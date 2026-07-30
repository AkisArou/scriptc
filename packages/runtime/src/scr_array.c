#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Live heap-array count for the RC audit lane (-DSCR_RC_AUDIT); same
 * contract as scr_str_live_count in scr_string.c. */
#ifdef SCR_RC_AUDIT
static long scr_live_arrays = 0;
long scr_arr_live_count(void) { return scr_live_arrays; }
#endif

static void scr_arr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* JS would return undefined for an OOB read and create holes for a far OOB
 * write; both are unrepresentable here (see SEMANTICS.md), so any invalid
 * index — negative, fractional, NaN, or past the allowed end — traps. */
static void scr_arr_trap_oob(double i, size_t len) {
  char buf[32];
  scr_f64_to_str(i, buf);
  scr_trap_fmt("scriptc: RangeError: array index %s out of bounds (length %zu)\n",
               buf, len);
}

/* Validate i as an element index. limit is a->len for reads, a->len + 1 for
 * writes (i == len appends). NaN fails the >= 0 test; fractional indices
 * fail the trunc test. */
static size_t scr_arr_check_index(const ScrArr *a, double i, bool allow_append) {
  size_t limit = a->len + (allow_append ? 1 : 0);
  if (!(i >= 0) || i != trunc(i) || i >= (double)limit) {
    scr_arr_trap_oob(i, a->len);
  }
  return (size_t)i;
}

/* ── slot packing: 8-byte slots hold doubles, bools, or pointers ───────── */

static uint64_t scr_slot_from_f64(double v) {
  uint64_t s;
  memcpy(&s, &v, sizeof s);
  return s;
}

static double scr_slot_to_f64(uint64_t s) {
  double v;
  memcpy(&v, &s, sizeof v);
  return v;
}

static uint64_t scr_slot_from_ptr(void *p) { return (uint64_t)(uintptr_t)p; }

static void *scr_slot_to_ptr(uint64_t s) { return (void *)(uintptr_t)s; }

static bool scr_elem_is_ref(ScrElemKind k) {
  return k == SCR_ELEM_STR || k == SCR_ELEM_ARR || k == SCR_ELEM_BYTES ||
         k == SCR_ELEM_REF;
}

static void scr_elem_release(const ScrArr *a, uint64_t slot) {
  void *p = scr_slot_to_ptr(slot);
  if (a->elem == SCR_ELEM_STR) scr_str_release((ScrStr *)p);
  else if (a->elem == SCR_ELEM_ARR) scr_arr_release((ScrArr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_release((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) a->elem_release(p);
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

static void scr_arr_grow(ScrArr *a, size_t need) {
  if (need <= a->cap) return;
  size_t cap = a->cap ? a->cap : 4;
  while (cap < need) {
    if (cap > SIZE_MAX / 2 / sizeof(uint64_t)) scr_arr_oom();
    cap *= 2;
  }
  uint64_t *data = realloc(a->data, cap * sizeof(uint64_t));
  if (!data) scr_arr_oom();
  a->data = data;
  if (a->present) {
    size_t old_bytes = (a->cap + 7) / 8;
    size_t new_bytes = (cap + 7) / 8;
    uint8_t *present = realloc(a->present, new_bytes);
    if (!present) scr_arr_oom();
    memset(present + old_bytes, 0, new_bytes - old_bytes);
    a->present = present;
  }
  a->cap = cap;
}

static bool scr_arr_present_at(const ScrArr *a, size_t i) {
  return !a->present || (a->present[i >> 3] & (uint8_t)(1u << (i & 7))) != 0;
}

static void scr_arr_mark_present(ScrArr *a, size_t i, bool present) {
  if (!a->present) {
    if (present) return;
    size_t bytes = (a->cap + 7) / 8;
    a->present = malloc(bytes ? bytes : 1);
    if (!a->present) scr_arr_oom();
    memset(a->present, 0xff, bytes);
    if (a->cap & 7) a->present[bytes - 1] &= (uint8_t)((1u << (a->cap & 7)) - 1u);
  }
  uint8_t mask = (uint8_t)(1u << (i & 7));
  if (present) a->present[i >> 3] |= mask;
  else a->present[i >> 3] &= (uint8_t)~mask;
}

static void scr_arr_pack_if_dense(ScrArr *a) {
  if (!a->present) return;
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) return;
  }
  free(a->present);
  a->present = NULL;
}

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap) {
  ScrArr *a = malloc(sizeof(ScrArr));
  if (!a) scr_arr_oom();
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = elem;
  a->elem_retain = NULL;
  a->elem_release = NULL;
  a->elem_trace = NULL;
  a->data = NULL;
  a->present = NULL;
  if (initial_cap > 0) scr_arr_grow(a, initial_cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

/* Collector trace of a cycle-capable array: every element is a headered
 * child (elem_trace non-NULL means the element TYPE carries a header, and
 * arrays are monomorphic), so trace visits all of them and the teardown
 * below releases none — the complement contract in scr_runtime.h. */
void scr_arr_trace_v(void *a0, ScrTraceVisit visit, void *ctx) {
  ScrArr *a = (ScrArr *)a0;
  for (size_t i = 0; i < a->len; i++) {
    if (scr_arr_present_at(a, i)) visit(scr_slot_to_ptr(a->data[i]), ctx);
  }
}

static void scr_arr_gc_free(void *a0) {
  ScrArr *a = (ScrArr *)a0;
  free(a->data);
  free(a->present);
#ifdef SCR_RC_AUDIT
  scr_live_arrays--;
#endif
  scr_cyc_free(a);
}

ScrArr *scr_arr_new_ref(void *(*elem_retain)(void *),
                         void (*elem_release)(void *),
                         ScrTraceFn elem_trace, size_t initial_cap) {
  ScrArr *a;
  if (elem_trace) {
    a = scr_cyc_alloc(sizeof(ScrArr), &scr_arr_trace_v, &scr_arr_gc_free);
  } else {
    a = malloc(sizeof(ScrArr));
    if (!a) scr_arr_oom();
  }
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = SCR_ELEM_REF;
  a->elem_retain = elem_retain;
  a->elem_release = elem_release;
  a->elem_trace = elem_trace;
  a->data = NULL;
  a->present = NULL;
  if (initial_cap > 0) scr_arr_grow(a, initial_cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

void scr_arr_release(ScrArr *a) {
  if (!a || a->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--a->rc == 0) {
    if (a->elem_trace) scr_cyc_on_dead(a);
    if (scr_elem_is_ref(a->elem)) {
      for (size_t i = 0; i < a->len; i++) {
        if (scr_arr_present_at(a, i)) scr_elem_release(a, a->data[i]);
      }
    }
    if (a->elem_trace) {
      scr_arr_gc_free(a);
    } else {
      free(a->data);
      free(a->present);
#ifdef SCR_RC_AUDIT
      scr_live_arrays--;
#endif
      free(a);
    }
  } else if (a->elem_trace) {
    scr_cyc_on_release(a); /* possible cycle root; may collect */
  }
}

double scr_arr_len(ScrArr *a) { return (double)a->len; }

void scr_arr_set_sparse_len(ScrArr *a, double n, void *fill) {
  if (!(n >= 0) || n != trunc(n) || n > 4294967295.0) {
    scr_throw_error_msg(SCR_ERR_RANGE, "Invalid array length", sizeof "Invalid array length" - 1);
    return;
  }
  size_t len = (size_t)n;
  if (len < a->len) {
    /* Shrink len BEFORE releasing so a release-triggered cycle collection
     * never traces the dropped tail; presence bits above len are dead (every
     * grow path rewrites them), so packed arrays stay bitmap-free and a
     * sparse array whose surviving prefix is dense drops its bitmap. */
    size_t old_len = a->len;
    a->len = len;
    if (scr_elem_is_ref(a->elem)) {
      for (size_t i = len; i < old_len; i++) {
        if (scr_arr_present_at(a, i)) scr_elem_release(a, a->data[i]);
      }
    }
    scr_arr_pack_if_dense(a);
    return;
  }
  if (len == a->len) return;
  scr_arr_grow(a, len);
  if (!a->present) {
    size_t bytes = (a->cap + 7) / 8;
    a->present = calloc(bytes ? bytes : 1, 1);
    if (!a->present) scr_arr_oom();
    for (size_t i = 0; i < a->len; i++) scr_arr_mark_present(a, i, true);
  }
  uint64_t slot = scr_slot_from_ptr(fill);
  for (size_t i = a->len; i < len; i++) {
    a->data[i] = slot;
    scr_arr_mark_present(a, i, false);
  }
  a->len = len;
}

bool scr_arr_has(ScrArr *a, double i) {
  if (!(i >= 0) || i != trunc(i) || i >= (double)a->len) return false;
  return scr_arr_present_at(a, (size_t)i);
}

bool scr_arr_delete(ScrArr *a, double i, void *fill) {
  if (!(i >= 0) || i != trunc(i) || i >= (double)a->len) return true;
  size_t idx = (size_t)i;
  if (!scr_arr_present_at(a, idx)) return true;
  uint64_t old = a->data[idx];
  a->data[idx] = scr_slot_from_ptr(fill);
  scr_arr_mark_present(a, idx, false);
  if (scr_elem_is_ref(a->elem)) scr_elem_release(a, old);
  return true;
}

double scr_arr_append_sparse(ScrArr *dst, ScrArr *src, void *fill) {
  size_t src_len = src->len;
  size_t start = dst->len;
  scr_arr_set_sparse_len(dst, (double)(start + src_len), fill);
  if (scr_exc_pending()) return (double)dst->len;
  for (size_t i = 0; i < src_len; i++) {
    if (!scr_arr_present_at(src, i)) continue;
    uint64_t slot = src->data[i];
    if (scr_elem_is_ref(dst->elem)) {
      void *p = scr_slot_to_ptr(slot);
      if (dst->elem == SCR_ELEM_STR) p = scr_str_retain((ScrStr *)p);
      else if (dst->elem == SCR_ELEM_ARR) p = scr_arr_retain((ScrArr *)p);
      else if (dst->elem == SCR_ELEM_BYTES) p = scr_bytes_retain((ScrBytes *)p);
      else p = dst->elem_retain(p);
      slot = scr_slot_from_ptr(p);
    }
    dst->data[start + i] = slot;
    scr_arr_mark_present(dst, start + i, true);
  }
  scr_arr_pack_if_dense(dst);
  return (double)dst->len;
}

/* ── Math.max/min over one spread number[] ─────────────────────────────
 * The JS fold exactly (ECMA Math.max/min applied to the elements): any
 * NaN poisons the result, +0 beats -0 for max (the reverse for min), and
 * the empty array yields the zero-argument constants. Borrows the array. */
double scr_math_max_arr(ScrArr *a) {
  double best = -INFINITY;
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) return NAN;
    double v = scr_slot_to_f64(a->data[i]);
    if (isnan(v)) return v;
    if (v > best || (v == 0.0 && best == 0.0 && !signbit(v))) best = v;
  }
  return best;
}

double scr_math_min_arr(ScrArr *a) {
  double best = INFINITY;
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) return NAN;
    double v = scr_slot_to_f64(a->data[i]);
    if (isnan(v)) return v;
    if (v < best || (v == 0.0 && best == 0.0 && signbit(v))) best = v;
  }
  return best;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

double scr_arr_get_f64(ScrArr *a, double i) {
  size_t idx = scr_arr_check_index(a, i, false);
  if (!scr_arr_present_at(a, idx)) {
    scr_trap("scriptc: TypeError: array hole cannot be represented by the element type\n");
  }
  return scr_slot_to_f64(a->data[idx]);
}

double scr_arr_get_dense_f64(ScrArr *a, double i) {
  return scr_slot_to_f64(a->data[scr_arr_check_index(a, i, false)]);
}

bool scr_arr_get_bool(ScrArr *a, double i) {
  size_t idx = scr_arr_check_index(a, i, false);
  if (!scr_arr_present_at(a, idx)) {
    scr_trap("scriptc: TypeError: array hole cannot be represented by the element type\n");
  }
  return a->data[idx] != 0;
}

bool scr_arr_get_dense_bool(ScrArr *a, double i) {
  return a->data[scr_arr_check_index(a, i, false)] != 0;
}

void *scr_arr_get_ref(ScrArr *a, double i) {
  size_t idx = scr_arr_check_index(a, i, false);
  void *p = scr_slot_to_ptr(a->data[idx]);
  if (!scr_arr_present_at(a, idx) && !p) {
    scr_trap("scriptc: TypeError: array hole cannot be represented by the element type\n");
  }
  if (a->elem == SCR_ELEM_STR) scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_retain((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) p = a->elem_retain(p);
  else scr_arr_retain((ScrArr *)p);
  return p;
}

void *scr_arr_get_dense_ref(ScrArr *a, double i) {
  void *p = scr_slot_to_ptr(a->data[scr_arr_check_index(a, i, false)]);
  if (a->elem == SCR_ELEM_STR) scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_retain((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) p = a->elem_retain(p);
  else scr_arr_retain((ScrArr *)p);
  return p;
}

/* ── writes: i == len appends ──────────────────────────────────────────── */

static void scr_arr_set_slot(ScrArr *a, double i, uint64_t slot) {
  size_t idx = scr_arr_check_index(a, i, true);
  if (idx == a->len) {
    scr_arr_grow(a, a->len + 1);
    a->len++;
    a->data[idx] = slot;
    scr_arr_mark_present(a, idx, true);
    return;
  }
  /* Unlink-then-release: a release can trigger a cycle collection, which
   * must never see a heap edge whose count was already given up. */
  bool had_old = scr_arr_present_at(a, idx);
  uint64_t old = a->data[idx];
  a->data[idx] = slot;
  scr_arr_mark_present(a, idx, true);
  if (!had_old && idx + 1 == a->len) scr_arr_pack_if_dense(a);
  if (had_old && scr_elem_is_ref(a->elem)) scr_elem_release(a, old);
}

void scr_arr_set_f64(ScrArr *a, double i, double v) {
  scr_arr_set_slot(a, i, scr_slot_from_f64(v));
}

void scr_arr_set_bool(ScrArr *a, double i, bool v) {
  scr_arr_set_slot(a, i, (uint64_t)(v ? 1 : 0));
}

void scr_arr_set_ref(ScrArr *a, double i, void *v) {
  scr_arr_set_slot(a, i, scr_slot_from_ptr(v));
}

/* ── push / pop ────────────────────────────────────────────────────────── */

static double scr_arr_push_slot(ScrArr *a, uint64_t slot) {
  scr_arr_grow(a, a->len + 1);
  a->data[a->len] = slot;
  scr_arr_mark_present(a, a->len, true);
  a->len++;
  return (double)a->len;
}

double scr_arr_push_f64(ScrArr *a, double v) {
  return scr_arr_push_slot(a, scr_slot_from_f64(v));
}

double scr_arr_push_bool(ScrArr *a, bool v) {
  return scr_arr_push_slot(a, (uint64_t)(v ? 1 : 0));
}

double scr_arr_push_ref(ScrArr *a, void *v) {
  return scr_arr_push_slot(a, scr_slot_from_ptr(v));
}

static uint64_t scr_arr_pop_slot(ScrArr *a) {
  if (a->len == 0) {
    scr_trap("scriptc: RangeError: pop() on an empty array\n");
  }
  size_t idx = --a->len;
  /* pop() on a hole is Get(len-1): undefined. A union element's backing
   * slot carries the interned undefined arm (immortal — handing it out as
   * owned is safe, its release is a no-op); a zero backing has no value
   * the element type can represent. */
  if (!scr_arr_present_at(a, idx) && a->data[idx] == 0) {
    scr_trap("scriptc: TypeError: array hole cannot be represented by the element type\n");
  }
  return a->data[idx];
}

double scr_arr_pop_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_pop_slot(a)); }

bool scr_arr_pop_bool(ScrArr *a) { return scr_arr_pop_slot(a) != 0; }

void *scr_arr_pop_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_pop_slot(a)); }

/* ── shift ─────────────────────────────────────────────────────────────
 * The first element out, tail sliding down. The EMITTER guards the empty
 * array (JS answers undefined there — the `elem | undefined` union), so
 * an empty receiver here is an internal error, pop's discipline. Ref
 * ownership moves out to the caller (no retain). */
static uint64_t scr_arr_shift_slot(ScrArr *a) {
  if (a->len == 0) {
    scr_trap("scriptc: internal error: shift() on an empty array\n");
  }
  /* shift() on a hole is Get(0): undefined — representable only when the
   * backing slot carries an interned undefined arm (pop's discipline). */
  if (!scr_arr_present_at(a, 0) && a->data[0] == 0) {
    scr_trap("scriptc: TypeError: array hole cannot be represented by the element type\n");
  }
  uint64_t s = a->data[0];
  a->len--;
  memmove(a->data, a->data + 1, a->len * sizeof(uint64_t));
  if (a->present) {
    for (size_t i = 0; i < a->len; i++) {
      scr_arr_mark_present(a, i, scr_arr_present_at(a, i + 1));
    }
    scr_arr_mark_present(a, a->len, false);
  }
  return s;
}

double scr_arr_shift_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_shift_slot(a)); }

bool scr_arr_shift_bool(ScrArr *a) { return scr_arr_shift_slot(a) != 0; }

void *scr_arr_shift_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_shift_slot(a)); }

/* ── splice (the removal forms) ────────────────────────────────────────
 * a.splice(start, deleteCount) with Node's exact index handling: start
 * goes through ToIntegerOrInfinity with negative-from-the-end resolution
 * and clamps to [0, len]; deleteCount clamps to [0, len - start] (the
 * omitted-count form passes +Infinity — remove to the end). The removed
 * elements come back as a fresh +1 array IN ORDER, their ownership MOVED
 * out of the receiver (no retain/release churn); the tail slides down.
 * Borrows a. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount) {
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  if (s0 < 0) s0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  double avail = len - (double)from;
  double d0 = isnan(deleteCount) ? 0 : trunc(deleteCount);
  size_t n = d0 <= 0 ? 0 : d0 >= avail ? (size_t)avail : (size_t)d0;
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, n ? n : 1)
          : scr_arr_new(a->elem, n ? n : 1);
  if (n > 0) {
    memcpy(out->data, a->data + from, n * sizeof(uint64_t));
    out->len = n;
    if (a->present) {
      for (size_t i = 0; i < n; i++) {
        if (!scr_arr_present_at(a, from + i)) scr_arr_mark_present(out, i, false);
      }
    }
    memmove(a->data + from, a->data + from + n, (a->len - from - n) * sizeof(uint64_t));
    if (a->present) {
      for (size_t i = from; i + n < a->len; i++) {
        scr_arr_mark_present(a, i, scr_arr_present_at(a, i + n));
      }
    }
    a->len -= n;
  }
  return out;
}

/* ── indexOf / includes ────────────────────────────────────────────────
 * indexOf uses JS strict equality (===): NaN never matches (NaN !== NaN),
 * -0 matches 0 (C == agrees on both). includes uses SameValueZero: the one
 * difference is that NaN DOES match NaN. Reference elements: strings by
 * content (JS strings are primitive values), arrays by pointer identity.
 * All needles are borrowed. */

static bool scr_arr_ref_eq(const ScrArr *a, uint64_t slot, void *v) {
  void *p = scr_slot_to_ptr(slot);
  if (a->elem == SCR_ELEM_STR) return scr_str_eq((ScrStr *)p, (ScrStr *)v);
  return p == v;
}

double scr_arr_index_of_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) continue;
    if (scr_slot_to_f64(a->data[i]) == v) return (double)i; /* NaN: never */
  }
  return -1;
}

double scr_arr_index_of_bool(ScrArr *a, bool v) {
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) continue;
    if ((a->data[i] != 0) == v) return (double)i;
  }
  return -1;
}

double scr_arr_index_of_ref(ScrArr *a, void *v) {
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) continue;
    if (scr_arr_ref_eq(a, a->data[i], v)) return (double)i;
  }
  return -1;
}

bool scr_arr_includes_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->len; i++) {
    if (!scr_arr_present_at(a, i)) continue;
    double x = scr_slot_to_f64(a->data[i]);
    if (x == v || (x != x && v != v)) return true; /* SameValueZero: NaN hits */
  }
  return false;
}

bool scr_arr_includes_bool(ScrArr *a, bool v) {
  return scr_arr_index_of_bool(a, v) >= 0;
}

bool scr_arr_includes_ref(ScrArr *a, void *v) {
  for (size_t i = 0; i < a->len; i++) {
    /* Get treats a hole as undefined. Union-backed sparse arrays store the
     * undefined singleton in the hole; NULL means this element type cannot
     * represent undefined and therefore cannot match the needle. */
    if (!scr_arr_present_at(a, i) && a->data[i] == 0) continue;
    if (scr_arr_ref_eq(a, a->data[i], v)) return true;
  }
  return false;
}

/* ── join ──────────────────────────────────────────────────────────────── */

static void scr_join_append(char **buf, size_t *len, size_t *cap,
                             const char *bytes, size_t n) {
  if (*len + n > *cap) {
    size_t cap2 = *cap;
    while (*len + n > cap2) {
      if (cap2 > SIZE_MAX / 2) scr_arr_oom();
      cap2 *= 2;
    }
    char *grown = realloc(*buf, cap2);
    if (!grown) scr_arr_oom();
    *buf = grown;
    *cap = cap2;
  }
  memcpy(*buf + *len, bytes, n);
  *len += n;
}

/* `a.slice(start?, end?)` — a fresh shallow copy of the index range,
 * JS-exact: indices go through ToIntegerOrInfinity (the emitter fills the
 * omitted defaults 0 / +Infinity), negatives count from the end, both
 * clamp to [0, len]. Ref elements RETAIN into the copy — the same
 * references, exactly JS's shallow copy. Borrows a; returns +1. */
ScrArr *scr_arr_slice(ScrArr *a, double start, double end) {
  /* ToIntegerOrInfinity + relative-index resolution over the LENGTH. */
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  double e0 = isnan(end) ? 0 : trunc(end);
  if (s0 < 0) s0 += len;
  if (e0 < 0) e0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  size_t to = e0 <= 0 ? 0 : e0 >= len ? a->len : (size_t)e0;
  size_t n = to > from ? to - from : 0;
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, n ? n : 1)
          : scr_arr_new(a->elem, n ? n : 1);
  for (size_t i = 0; i < n; i++) {
    uint64_t slot = a->data[from + i];
    bool present = scr_arr_present_at(a, from + i);
    if (present && scr_elem_is_ref(a->elem)) {
      void *pv = scr_slot_to_ptr(slot);
      if (a->elem == SCR_ELEM_STR) scr_str_retain((ScrStr *)pv);
      else if (a->elem == SCR_ELEM_ARR) scr_arr_retain((ScrArr *)pv);
      else if (a->elem == SCR_ELEM_BYTES) scr_bytes_retain((ScrBytes *)pv);
      else pv = a->elem_retain(pv);
      slot = scr_slot_from_ptr(pv);
    }
    out->data[out->len++] = slot;
    if (!present) scr_arr_mark_present(out, i, false);
  }
  return out;
}

ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep) {
  size_t cap = 64, len = 0;
  char *buf = malloc(cap);
  if (!buf) scr_arr_oom();
  for (size_t i = 0; i < a->len; i++) {
    if (i > 0) scr_join_append(&buf, &len, &cap, sep->data, sep->len);
    if (!scr_arr_present_at(a, i)) continue;
    switch (a->elem) {
      case SCR_ELEM_F64: {
        char nb[32];
        size_t n = scr_f64_to_str(scr_slot_to_f64(a->data[i]), nb);
        scr_join_append(&buf, &len, &cap, nb, n);
        break;
      }
      case SCR_ELEM_BOOL:
        if (a->data[i] != 0) scr_join_append(&buf, &len, &cap, "true", 4);
        else scr_join_append(&buf, &len, &cap, "false", 5);
        break;
      case SCR_ELEM_STR: {
        const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(a->data[i]);
        scr_join_append(&buf, &len, &cap, s->data, s->len);
        break;
      }
      case SCR_ELEM_ARR:
      case SCR_ELEM_BYTES:
      case SCR_ELEM_REF:
        /* The compiler rejects join on ref-element arrays (SC1090). */
        scr_trap("scriptc: internal error: join on a ref-element array\n");
    }
  }
  ScrStr *out = scr_str_new(buf, len);
  free(buf);
  return out;
}

/* String.raw over the template's raw literals and PRE-STRINGIFIED
 * substitutions (the frontend applies the static ToString per value):
 * raw[0] sub[0] raw[1] sub[1] ... — substitutions beyond raw.len-1 drop,
 * missing ones skip, exactly the spec's loop. Both arrays are
 * SCR_ELEM_STR; borrows both; +1 result. Never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs) {
  size_t cap = 64, len = 0;
  char *buf = malloc(cap);
  if (!buf) scr_arr_oom();
  for (size_t i = 0; i < raw->len; i++) {
    const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(raw->data[i]);
    scr_join_append(&buf, &len, &cap, s->data, s->len);
    if (i + 1 < raw->len && i < subs->len) {
      const ScrStr *v = (const ScrStr *)scr_slot_to_ptr(subs->data[i]);
      scr_join_append(&buf, &len, &cap, v->data, v->len);
    }
  }
  ScrStr *out = scr_str_new(buf, len);
  free(buf);
  return out;
}
