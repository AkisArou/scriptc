#include "scr_runtime.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  ScrDirectCallback *callback;
  bool connected;
} TestForeign;

static const ScrNativeHandleType handle_type = {NULL, 0, false, false};
static _Atomic size_t closures_freed;
static _Atomic size_t foreign_destroyed;
static _Atomic size_t handles_allocated;

_Noreturn void scr_trap(const char *message) {
  fputs(message, stderr);
  abort();
}

void scr_throw_error_msg(int kind, const char *message, size_t length) {
  (void)kind;
  (void)message;
  (void)length;
  abort();
}

void scr_obj_alloc_note(void) { atomic_fetch_add(&handles_allocated, 1); }
void scr_obj_free_note(void) { atomic_fetch_sub(&handles_allocated, 1); }

static void closure_trace(void *opaque, ScrTraceVisit visit, void *context) {
  (void)opaque;
  (void)visit;
  (void)context;
}

static void closure_collect(void *opaque) {
  atomic_fetch_add(&closures_freed, 1);
  scr_cyc_free(opaque);
}

static ScrClosure *new_closure(void) {
  ScrClosure *closure = scr_cyc_alloc(
      sizeof *closure, closure_trace, closure_collect);
  closure->rc = 1;
  closure->fn = NULL;
  closure->ncaps = 0;
  closure->props = NULL;
  return closure;
}

void scr_closure_release(ScrClosure *closure) {
  if (closure == NULL || closure->rc == SIZE_MAX) return;
  if (--closure->rc == 0) {
    scr_cyc_on_dead(closure);
    closure_collect(closure);
  } else {
    scr_cyc_on_release(closure);
  }
}

static void destroy_foreign(void *opaque) {
  TestForeign *foreign = opaque;
  /* Native teardown runs after lifecycle begin, so it cannot reenter a
   * callback whose managed closure is being detached. */
  if (foreign->connected) {
    assert(scr_direct_callback_acquire(foreign->callback) == NULL);
  }
  atomic_fetch_add(&foreign_destroyed, 1);
  free(foreign);
}

int main(void) {
  ScrClosure *closure = new_closure();
  ScrDirectCallback *callback = NULL;
  ScrNativeHandle *handle = scr_native_handle_prepare_direct_callback_fused(
      destroy_foreign, &handle_type, "DirectSubscription", closure,
      &callback);
  assert(closure->rc == 2);
  scr_closure_release(closure);

  TestForeign *foreign = calloc(1, sizeof *foreign);
  assert(foreign != NULL);
  foreign->callback = callback;
  foreign->connected = true;
  scr_native_handle_commit(handle, foreign);

  ScrClosure *invocation = scr_direct_callback_acquire(callback);
  assert(invocation == closure && closure->rc == 2);
  /* Model disposal from inside the callback: the active invocation's retain
   * must outlive both native cancellation and freeing the opaque context. */
  scr_native_handle_dispose(handle, &handle_type,
                            "DirectSubscription.dispose");
  assert(atomic_load(&foreign_destroyed) == 1);
  assert(atomic_load(&closures_freed) == 0);
  scr_closure_release(invocation);
  assert(atomic_load(&closures_freed) == 1);
  scr_native_handle_release(handle);
  assert(atomic_load(&handles_allocated) == 0);

  /* A native factory that fails after receiving its context rolls back the
   * staged lifecycle and its closure retain exactly once. */
  closure = new_closure();
  callback = NULL;
  handle = scr_native_handle_prepare_direct_callback_fused(
      destroy_foreign, &handle_type, "DirectSubscription", closure,
      &callback);
  assert(scr_direct_callback_acquire(callback) != NULL);
  /* Give back the probe and the caller's original reference. */
  scr_closure_release(closure);
  scr_closure_release(closure);
  scr_native_handle_abandon(handle);
  assert(atomic_load(&closures_freed) == 2);
  assert(atomic_load(&handles_allocated) == 0);

  puts("direct callback: ok");
  return 0;
}
