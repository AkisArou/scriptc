/* The checked-dynamic HANDLE support unit — everything the handle
 * dispatchers (scr_http.c / scr_net.c) and the emitter unit's dyn
 * registrations share BEYOND the DOM core: errors.js's
 * determineSpecificType renderer and the ERR_INVALID_ARG_TYPE throwers
 * (the listener gate), and the runtime-built listener adapter closures
 * whose fire thunks box event tuples back into the DOM. Split out of
 * scr_json.c so handle-free binaries keep their exact size class:
 * cc.ts compiles this unit exactly when a user of it links (the net or
 * emitter gate — http implies net).
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

/* errors.js's determineSpecificType over a DOM value — the "Received
 * ..." tail of Node's ERR_INVALID_ARG_TYPE messages. Renders into buf
 * when the shape needs a payload; returns the text either way. */
const char *scr_dyn_specific_type(const ScrDyn *cb, char *detail, size_t cap) {
  const char *d = detail;
  switch (cb->kind) {
  case SCR_DYN_NULL: d = "null"; break;
  case SCR_DYN_UNDEF: d = "undefined"; break;
  case SCR_DYN_OBJ: d = "an instance of Object"; break;
  case SCR_DYN_ARR: d = "an instance of Array"; break;
  case SCR_DYN_BYTES: d = "an instance of Uint8Array"; break;
  case SCR_DYN_FUNC: d = "function"; break; /* callers usually return before this */
  case SCR_DYN_HANDLE:
    snprintf(detail, cap, "an instance of %s", scr_dyn_handle_cls(cb));
    break;
  case SCR_DYN_PROMISE: d = "an instance of Promise"; break;
  case SCR_DYN_BOOL:
    snprintf(detail, cap, "type boolean (%s)", cb->v.b ? "true" : "false");
    break;
  case SCR_DYN_NUM: {
    char num[32];
    size_t n = scr_f64_to_str(cb->v.num, num);
    snprintf(detail, cap, "type number (%.*s)", (int)n, num);
    break;
  }
  case SCR_DYN_STR: {
    const ScrStr *sv = cb->v.str;
    char insp[32];
    size_t n = 0;
    insp[n++] = '\'';
    for (size_t i = 0; i < sv->len && n < 28; i++) insp[n++] = sv->data[i];
    if (sv->len + 2 > 28) {
      n = 25;
      memcpy(insp + n, "...", 3);
      n += 3;
    } else {
      insp[n++] = '\'';
    }
    snprintf(detail, cap, "type string (%.*s)", (int)n, insp);
    break;
  }
  default: d = "an instance of Object"; break;
  }
  return d;
}

/* Node's ERR_INVALID_ARG_TYPE thrower ("The \"chunk\" argument must be
 * of type string or an instance of Buffer or Uint8Array. Received type
 * number (5)") — the handle dispatchers' per-arg gates. `expected` is
 * the full "of type ..."/"an instance of ..." clause. */
void scr_dyn_arg_type_fail(const char *argname, const char *expected, const ScrDyn *got) {
  char detail[64];
  const char *d = scr_dyn_specific_type(got, detail, sizeof detail);
  char msg[224];
  int len = snprintf(msg, sizeof msg,
                     "The \"%s\" argument must be %s. Received %s", argname, expected, d);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_TYPE");
}

/* Node's ERR_INVALID_ARG_TYPE listener gate (errors.js's
 * determineSpecificType shapes — the scr_emitter_check_listener wording,
 * shared here so the gated units need not link the emitter unit). */
void scr_dyn_check_listener(const ScrDyn *cb, const char *argname) {
  if (cb->kind == SCR_DYN_FUNC) return;
  scr_dyn_arg_type_fail(argname, "of type function", cb);
}

/* ── runtime-built listener closures (the handle dispatchers' .on paths) ─
 * One capture: a box holding the retained dyn FUNCTION value. The fire
 * thunks box the event tuple back into the DOM and call through the
 * checked-dynamic machinery (scr_dyn_call — per-arg validation lives in
 * the boxed thunk). A throw from the listener stays pending, exactly like
 * a compiler-emitted listener body. */
static ScrDyn *scr_dyn_listener_peek(ScrClosure *cb) {
  return (ScrDyn *)scr_box_get_ref(cb->caps[0]); /* +1 */
}

/* The boxed dyn FUNCTION a listener closure carries (+1) — for fire
 * thunks the OWNING units define themselves (handle-boxing tuples this
 * unit cannot spell: scr_net.c's 'connection', scr_http.c's 'request'). */
ScrDyn *scr_dyn_listener_fn(ScrClosure *cb) { return scr_dyn_listener_peek(cb); }

void scr_dyn_listener_fire0(ScrClosure *cb) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  ScrDyn *r = scr_dyn_call(fn, NULL, 0, "listener");
  scr_dyn_release(r);
  scr_dyn_release(fn);
}

void scr_dyn_listener_fire_data(ScrClosure *cb, ScrBytes *chunk) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  ScrDyn *arg = scr_dyn_new_chunk(chunk); /* Buffer-flavored, or a string inside a setEncoding window */
  ScrDyn *args[1] = { arg };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

void scr_dyn_listener_fire_err(ScrClosure *cb, ScrStr *msg) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  /* The DOM's error encoding (caughtToDyn's shape) — what a dyn 'error'
   * listener body can instanceof-test and read .message from. */
  ScrDyn *arg = scr_dyn_new_obj();
  scr_dyn_obj_set(arg, "%error", 6, scr_dyn_new_bool(true));
  {
    ScrStr *name = scr_str_new("Error", 5);
    scr_dyn_obj_set(arg, "name", 4, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  scr_dyn_obj_set(arg, "message", 7, scr_dyn_new_str(msg));
  ScrDyn *args[1] = { arg };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

static ScrClosure *scr_dyn_listener_closure(const ScrDyn *cb, void *fire) {
  ScrClosure *clo = scr_closure_new(fire, 1);
  ScrBox *box = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(box, scr_dyn_retain((ScrDyn *)cb));
  clo->caps[0] = box;
  return clo;
}

ScrClosure *scr_dyn_listener_closure_fn(const ScrDyn *cb, void *fire) {
  return scr_dyn_listener_closure(cb, fire);
}
ScrClosure *scr_dyn_listener_closure0(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire0);
}
ScrClosure *scr_dyn_listener_closure_data(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire_data);
}
ScrClosure *scr_dyn_listener_closure_err(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire_err);
}

