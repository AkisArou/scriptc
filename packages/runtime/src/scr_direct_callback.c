/* Lightweight result-owned callback lifecycle for contracts that guarantee
 * synchronous invocation on the runtime owner thread. */
#include "scr_runtime.h"

#include <stdbool.h>
#include <stdlib.h>

/* The native side receives this lifecycle edge as its opaque context.
 * Acquiring retains the closure before invoking it, so a handler may dispose
 * its own registration reentrantly without invalidating the active call. */
struct ScrDirectCallback {
  ScrClosure *closure;
  bool active;
};

static void scr_direct_callback_commit(void *opaque) { (void)opaque; }

static void scr_direct_callback_drop(ScrDirectCallback *callback) {
  callback->active = false;
  if (callback->closure != NULL) {
    scr_closure_release(callback->closure);
    callback->closure = NULL;
  }
}

static void scr_direct_callback_abandon(void *opaque) {
  scr_direct_callback_drop(opaque);
}

static void scr_direct_callback_begin(void *opaque) {
  ScrDirectCallback *callback = opaque;
  callback->active = false;
}

static void scr_direct_callback_complete(void *opaque) {
  scr_direct_callback_drop(opaque);
}

static void scr_direct_callback_trace(void *opaque, ScrTraceVisit visit,
                                      void *visit_context) {
  ScrDirectCallback *callback = opaque;
  if (callback->closure != NULL) visit(callback->closure, visit_context);
}

static void scr_direct_callback_collect_begin(void *opaque) {
  ScrDirectCallback *callback = opaque;
  callback->active = false;
}

static void scr_direct_callback_collect_complete(void *opaque) {
  ScrDirectCallback *callback = opaque;
  /* Trial deletion already accounted for the lifecycle -> closure edge. */
  callback->closure = NULL;
}

static void scr_direct_callback_destroy(void *opaque) { free(opaque); }

static void scr_direct_callback_destroy_inline(void *opaque) { (void)opaque; }

ScrDirectCallback *scr_native_handle_prepare_direct_callback(
    ScrNativeHandle *handle, ScrClosure *closure) {
  if (handle == NULL || closure == NULL) {
    scr_trap("scriptc: invalid direct callback lifecycle\n");
  }
  ScrDirectCallback *callback = malloc(sizeof *callback);
  if (callback == NULL) scr_trap("scriptc: out of memory\n");
  callback->closure = scr_closure_retain(closure);
  callback->active = true;
  scr_native_handle_prepare_lifecycle(
      handle, SCR_NATIVE_LIFECYCLE_CALLBACK, callback,
      scr_direct_callback_commit, scr_direct_callback_abandon,
      scr_direct_callback_begin, scr_direct_callback_complete,
      scr_direct_callback_trace, scr_direct_callback_collect_begin,
      scr_direct_callback_collect_complete, scr_direct_callback_destroy);
  return callback;
}

ScrNativeHandle *scr_native_handle_prepare_direct_callback_fused(
    ScrNativeDestructor destructor, const ScrNativeHandleType *type,
    const char *type_name, ScrClosure *closure,
    ScrDirectCallback **out_callback) {
  if (closure == NULL || out_callback == NULL) {
    scr_trap("scriptc: invalid fused direct callback lifecycle\n");
  }
  ScrDirectCallback *callback = NULL;
  ScrNativeHandle *handle = scr_native_handle_prepare_inline_lifecycle(
      destructor, type, type_name, SCR_NATIVE_LIFECYCLE_CALLBACK,
      sizeof *callback, scr_direct_callback_commit,
      scr_direct_callback_abandon, scr_direct_callback_begin,
      scr_direct_callback_complete, scr_direct_callback_trace,
      scr_direct_callback_collect_begin, scr_direct_callback_collect_complete,
      scr_direct_callback_destroy_inline, (void **)&callback);
  callback->closure = scr_closure_retain(closure);
  callback->active = true;
  *out_callback = callback;
  return handle;
}

ScrClosure *scr_direct_callback_acquire(ScrDirectCallback *callback) {
  if (callback == NULL || !callback->active || callback->closure == NULL) {
    return NULL;
  }
  return scr_closure_retain(callback->closure);
}
