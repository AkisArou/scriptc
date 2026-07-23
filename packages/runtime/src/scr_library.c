/* Library mode support: the panic sink, the poisoned-library flag, the
 * outbound-result arena, the reset registry, and the sink-routing trap
 * funnel. Linked ONLY into library artifacts (every TU of a library archive
 * compiles with -DSCR_LIB); executable builds never contain this file —
 * their funnel expansion lives in scr_console.c and their session teardown
 * stays atexit-driven.
 *
 * The profile-NAMED symbols (init, sink registration, reset, collect) are
 * emitted in the program TU and delegate here, so this file stays
 * profile-agnostic and the program TU carries every profile-named symbol —
 * one place for the conformance symbol audit to look.
 *
 * State after a sink call: none is legal. The trap fired mid-operation with
 * no unwinding — heap, arena, and collector state are unspecified; the library
 * is POISONED. Every runtime-touching entry prologue aborts on the flag
 * (deterministic, never heap corruption); recovery is process restart. */
#include "scr_runtime.h"

#ifdef SCR_LIB

#include <stdio.h>
#include <stdlib.h>

/* ── sink registration + poison ───────────────────────────────────────── */

static ScrLibSinkFn scr_library_sink = NULL;
static void *scr_library_sink_ctx = NULL;
static bool scr_library_poisoned = false;

void scr_library_set_sink(ScrLibSinkFn fn, void *ctx) {
  /* Latest registration wins; re-registration is permitted before a trap.
   * Deliberately NOT poison-guarded: a pure store, touching no runtime
   * state — but a poisoned library's entries abort regardless of the sink. */
  scr_library_sink = fn;
  scr_library_sink_ctx = ctx;
}

/* ── the trap funnel, library expansion ───────────────────────────────────
 * Poison first (the sink may longjmp to a host frame below the entry — the
 * conforming survival pattern), then deliver exactly once, then abort:
 * before registration, or if the sink returns (the ruled host-contract
 * violation). The address is the funnel frame's return address — the trap
 * site — 0 where the toolchain cannot supply one. */

#if defined(__GNUC__) || defined(__clang__)
#define SCR_TRAP_ADDR() ((uint64_t)(uintptr_t)__builtin_return_address(0))
#else
#define SCR_TRAP_ADDR() ((uint64_t)0)
#endif

static _Noreturn void scr_library_trap_deliver(const char *msg, size_t len, uint64_t addr) {
  scr_library_poisoned = true;
  if (scr_library_sink != NULL) {
    scr_library_sink(scr_library_sink_ctx, (const uint8_t *)msg, len, addr);
  }
  abort();
}

__attribute__((noinline)) _Noreturn void scr_trap(const char *msg) {
  scr_library_trap_deliver(msg, strlen(msg), SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_len(const char *msg, size_t len) {
  /* The length-delimited funnel entry: structured trap-teaching messages
   * and verbatim 0x01-led thrown messages are byte-counted, never
   * NUL-scanned (a thrown JS string may embed NUL). Same poison-deliver-
   * abort discipline as scr_trap. */
  scr_library_trap_deliver(msg, len, SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_fmt(const char *fmt, ...) {
  static char buf[512]; /* no malloc on the invariant-failure path */
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  size_t len = n < 0 ? 0 : (size_t)n >= sizeof buf ? sizeof buf - 1 : (size_t)n;
  scr_library_trap_deliver(buf, len, SCR_TRAP_ADDR());
}

/* ── entry prologues ──────────────────────────────────────────────────── */

void scr_library_entry(bool reset_arena) {
  /* A poisoned library's entries abort deterministically — never through the
   * sink again (it received its exactly-once message when the trap fired),
   * never into a heap whose invariants already failed. */
  if (scr_library_poisoned) abort();
  if (reset_arena) scr_library_arena_reset();
}

/* ── the outbound-result arena ────────────────────────────────────────────
 * Buffer-class results (string/bytes) MOVE in here; the host reads through
 * borrowed pointers until the arena resets (per-entry under the auto
 * posture, host-cycled when the profile declares a reset symbol; init and
 * collect always reset). */

typedef struct {
  void *v;
  bool is_str; /* ScrStr vs ScrBytes — picks the release */
} ScrCoreArenaEnt;

static ScrCoreArenaEnt *scr_library_arena = NULL;
static size_t scr_library_arena_n = 0, scr_library_arena_cap = 0;

static void scr_library_arena_keep(void *v, bool is_str) {
  if (scr_library_arena_n == scr_library_arena_cap) {
    scr_library_arena_cap = scr_library_arena_cap ? scr_library_arena_cap * 2 : 16;
    scr_library_arena = realloc(scr_library_arena, scr_library_arena_cap * sizeof *scr_library_arena);
    if (!scr_library_arena) scr_trap("scriptc: out of memory\n");
  }
  scr_library_arena[scr_library_arena_n].v = v;
  scr_library_arena[scr_library_arena_n].is_str = is_str;
  scr_library_arena_n++;
}

void scr_library_arena_reset(void) {
  for (size_t i = 0; i < scr_library_arena_n; i++) {
    if (scr_library_arena[i].is_str) scr_str_release((ScrStr *)scr_library_arena[i].v);
    else scr_bytes_release((ScrBytes *)scr_library_arena[i].v);
  }
  scr_library_arena_n = 0;
}

void scr_library_collect(void) {
  scr_library_arena_reset();
  scr_collect_cycles();
}

/* ── marshalling helpers (both emissions call exactly these) ──────────── */

ScrStr *scr_library_str_in(const uint8_t *p, size_t len) {
  /* ptr may be NULL when len is 0 (the contract's empty-buffer form). */
  return scr_str_new(len == 0 ? "" : (const char *)p, len);
}

ScrBytes *scr_library_bytes_in(const uint8_t *p, size_t len, const char *trap_msg) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (b == NULL) {
    /* scr_bytes_new throws only for lengths past 2^53-1 — an impossible
     * host buffer; funnel the contract violation instead of a NULL deref.
     * The message is the wrapper's compiler-assembled structured
     * trap-teaching form (code SC4012, the trapping export's symbol, the
     * profile's teaching and remediation) — opaque bytes here. */
    scr_exc_clear();
    scr_trap(trap_msg);
  }
  if (len > 0 && p != NULL) memcpy(b->data, p, len);
  return b;
}

void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(s, true);
  *out = (const uint8_t *)s->data; /* NUL-terminated after len (ScrStr layout) */
  *out_len = s->len;
}

void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(b, false);
  *out = b->data; /* elem is always u8 at the boundary (v1 bytes class) */
  *out_len = b->len;
}

/* ── the reset registry + session reset ─────────────────────────────────
 * Where an executable's always-linked units atexit() their lazy teardowns,
 * library builds register here (scr_atexit in scr_runtime.h): registered
 * once, drained on EVERY reset — re-registration guards in the units stay
 * satisfied because the entry persists. */

#define SCR_LIB_MAX_RESETS 32
static void (*scr_library_resets[SCR_LIB_MAX_RESETS])(void);
static size_t scr_library_nresets = 0;

void scr_library_register_reset(void (*fn)(void)) {
  for (size_t i = 0; i < scr_library_nresets; i++) {
    if (scr_library_resets[i] == fn) return;
  }
  if (scr_library_nresets == SCR_LIB_MAX_RESETS) {
    scr_trap("scriptc: internal error: library reset registry overflow\n");
  }
  scr_library_resets[scr_library_nresets++] = fn;
}

#ifdef SCR_RC_AUDIT
extern long scr_str_live_count(void);     /* scr_string.c */
extern long scr_arr_live_count(void);     /* scr_array.c */
extern long scr_map_live_count(void);     /* scr_map.c */
extern long scr_box_live_count(void);     /* scr_closure.c */
extern long scr_closure_live_count(void); /* scr_closure.c */
extern long scr_obj_live_count(void);     /* scr_object.c */
extern long scr_union_live_count(void);   /* scr_union.c */
extern long scr_dyn_live_count(void);     /* scr_json.c */
extern long scr_bytes_live_count(void);   /* scr_bytes.c */

/* The per-session heap-emptiness assertion (the audit flavor's determinism
 * seam): after a full reset the live counters must all read zero, or the
 * previous session leaked. A failure is a TRAP through the sink — the
 * executable audit's _Exit(99) stays exe-lane-only. */
static void scr_library_audit_zero(void) {
  long strings = scr_str_live_count(), arrays = scr_arr_live_count(),
       maps = scr_map_live_count(), boxes = scr_box_live_count(),
       closures = scr_closure_live_count(), objects = scr_obj_live_count(),
       unions = scr_union_live_count(), dyns = scr_dyn_live_count(),
       bytes = scr_bytes_live_count();
  if (strings != 0 || arrays != 0 || maps != 0 || boxes != 0 || closures != 0 ||
      objects != 0 || unions != 0 || dyns != 0 || bytes != 0) {
    scr_trap_fmt(
        "scriptc LIBRARY RC AUDIT FAILED: %ld heap string(s), %ld array(s), "
        "%ld map(s), %ld box(es), %ld closure(s), %ld object(s), "
        "%ld union(s), %ld dyn value(s), %ld bytes value(s) live across re-init\n",
        strings, arrays, maps, boxes, closures, objects, unions, dyns, bytes);
  }
}
#endif /* SCR_RC_AUDIT */

extern void scr_lib_session_cleanup(void); /* scr_lib.c: the interned process values */

void scr_library_reset(void) {
  /* Called by the generated init entry AFTER the program TU released and
   * zeroed its globals (run-once guards included) — the same order the
   * executable exit path runs: library cleanup → cycle collection → RC
   * audit. Everything here is re-runnable; the first call is a cheap
   * no-op pass. */
  scr_exc_clear();
  scr_library_arena_reset();
  for (size_t i = 0; i < scr_library_nresets; i++) scr_library_resets[i]();
  scr_lib_session_cleanup();
  scr_collect_cycles();
#ifdef SCR_RC_AUDIT
  scr_library_audit_zero();
#endif
}

#endif /* SCR_LIB */
