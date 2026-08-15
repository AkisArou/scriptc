#include "scr_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  ScrCallbackInvocation invocation;
  int32_t value;
  bool shutdown_inside;
  bool throws;
} TestInvocation;

typedef struct {
  int64_t total;
} TestClosureState;

typedef struct {
  ScrCallbackToken *token;
  int32_t first;
  int32_t count;
} Producer;

static const char signature;
static _Atomic size_t closures_freed;
static _Atomic size_t invocations_destroyed;
static _Atomic size_t source_owner_retains;
static _Atomic size_t wakes;
static ScrCallbackTable *attached_table;
static ScrCallbackToken *attached_token;
static bool exception_pending;

void scr_closure_release(ScrClosure *closure) {
  assert(closure != NULL && closure->rc != 0 && closure->rc != SIZE_MAX);
  if (--closure->rc != 0) return;
  free(closure->fn);
  free(scr_cyc_hdr(closure));
  atomic_fetch_add_explicit(&closures_freed, 1, memory_order_relaxed);
}

_Noreturn void scr_trap(const char *message) {
  fputs(message, stderr);
  abort();
}

bool scr_exc_pending(void) { return exception_pending; }

ScrNativeHandle *scr_native_handle_retain_live(ScrNativeHandle *handle) {
  assert(handle != NULL);
  atomic_fetch_add_explicit(&source_owner_retains, 1, memory_order_relaxed);
  return handle;
}

void scr_native_handle_prepare_callback(ScrNativeHandle *handle,
                                        ScrCallbackTable *table,
                                        ScrCallbackToken *token) {
  assert(handle != NULL);
  assert(attached_table == NULL && attached_token == NULL);
  attached_table = table;
  attached_token = token;
}

static void commit_prepared(void) {
  assert(attached_table != NULL && attached_token != NULL);
  assert(scr_callback_table_claim_owner(attached_table, attached_token));
}

static void abandon_prepared(void) {
  assert(attached_table != NULL && attached_token != NULL);
  assert(scr_callback_table_abandon(attached_table, attached_token));
  (void)scr_callback_table_collect(attached_table);
  attached_table = NULL;
  attached_token = NULL;
}

static ScrClosure *new_closure(void) {
  ScrCycHdr *header = calloc(1, sizeof *header + sizeof(ScrClosure));
  TestClosureState *state = calloc(1, sizeof *state);
  assert(header != NULL && state != NULL);
  ScrClosure *closure = (ScrClosure *)(header + 1);
  closure->rc = 1;
  closure->fn = state;
  return closure;
}

static bool invoke_callback(ScrCallbackInvocation *base, void *owner_context,
                            size_t slot, uint64_t generation) {
  TestInvocation *invocation = (TestInvocation *)base;
  ScrClosure *closure = scr_callback_table_acquire(
      owner_context, slot, generation, invocation->invocation.signature);
  assert(closure != NULL);
  TestClosureState *state = closure->fn;
  state->total += invocation->value;
  if (invocation->shutdown_inside) {
    /* Re-entrant shutdown must refuse destruction while this invocation is
     * using the table. The outer dispatch remains responsible for the record. */
    scr_retained_callbacks_stop_accepting();
    assert(!scr_retained_callbacks_destroy());
  }
  if (invocation->throws) exception_pending = true;
  scr_closure_release(closure);
  return !scr_exc_pending();
}

static void destroy_invocation(ScrOwnerGatewayEvent *base) {
  atomic_fetch_add_explicit(&invocations_destroyed, 1, memory_order_relaxed);
  free(base);
}

static TestInvocation *new_invocation(int32_t value, bool shutdown_inside,
                                      bool throws) {
  TestInvocation *invocation = calloc(1, sizeof *invocation);
  assert(invocation != NULL);
  invocation->invocation.signature = &signature;
  invocation->invocation.invoke = invoke_callback;
  invocation->invocation.payload_destroy = destroy_invocation;
  invocation->value = value;
  invocation->shutdown_inside = shutdown_inside;
  invocation->throws = throws;
  return invocation;
}

static void *produce(void *opaque) {
  Producer *producer = opaque;
  for (int32_t i = 0; i < producer->count; i++) {
    TestInvocation *invocation =
        new_invocation(producer->first + i, false, false);
    assert(scr_callback_token_admit(producer->token,
                                    &invocation->invocation));
  }
  return NULL;
}

static void wake_owner(void *context) {
  assert(context == &wakes);
  atomic_fetch_add_explicit(&wakes, 1, memory_order_relaxed);
}

static void cancel_attached(void) {
  assert(attached_table != NULL && attached_token != NULL);
  assert(scr_callback_table_begin_close(attached_table, attached_token));
  assert(scr_callback_table_cancellation_complete(attached_table,
                                                  attached_token));
  attached_table = NULL;
  attached_token = NULL;
}

int main(void) {
  assert(!scr_retained_callbacks_configured());
  assert(scr_retained_callbacks_configure(wake_owner, &wakes));
  assert(scr_retained_callbacks_configured());
  assert(!scr_retained_callbacks_configure(wake_owner, &wakes));

  ScrClosure *closure = new_closure();
  ScrNativeHandle *source_owner = (ScrNativeHandle *)(uintptr_t)1;
  ScrCallbackToken *token =
      scr_retained_callbacks_register(closure, &signature, source_owner);
  assert(token != NULL && closure->rc == 2);
  assert(scr_retained_callbacks_retain_owner(token) == source_owner);
  assert(atomic_load(&source_owner_retains) == 1);
  assert(scr_retained_callbacks_active() == 1);

  Producer producer = {.token = token, .first = 1, .count = 100};
  pthread_t thread;
  assert(pthread_create(&thread, NULL, produce, &producer) == 0);
  assert(pthread_join(thread, NULL) == 0);
  assert(atomic_load(&wakes) == 1);
  TestClosureState *state = closure->fn;
  size_t delivered = 0;
  while (delivered != 100) {
    ScrRetainedCallbackDispatch result = scr_retained_callbacks_dispatch();
    assert(result == SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED);
    delivered++;
  }
  assert(state->total == 5050);
  assert(atomic_load(&invocations_destroyed) == 100);

  scr_retained_callbacks_prepare((ScrNativeHandle *)(uintptr_t)1, token);
  commit_prepared();
  cancel_attached();
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_IDLE);
  assert(scr_retained_callbacks_active() == 0 && closure->rc == 1);
  scr_closure_release(closure);
  assert(atomic_load(&closures_freed) == 1);
  scr_retained_callbacks_stop_accepting();
  assert(scr_retained_callbacks_destroy());
  assert(!scr_retained_callbacks_configured());

  /* Destruction is fenced while an owner delivery is still executing. */
  assert(scr_retained_callbacks_configure(wake_owner, &wakes));
  closure = new_closure();
  token = scr_retained_callbacks_register(closure, &signature, NULL);
  assert(token != NULL);
  assert(scr_callback_token_admit(
      token, &new_invocation(7, true, false)->invocation));
  assert(scr_callback_token_admit(
      token, &new_invocation(11, false, false)->invocation));
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED);
  assert(((TestClosureState *)closure->fn)->total == 7);
  assert(atomic_load(&invocations_destroyed) == 101);
  assert(scr_retained_callbacks_configured());
  scr_retained_callbacks_prepare((ScrNativeHandle *)(uintptr_t)1, token);
  abandon_prepared();
  assert(scr_retained_callbacks_active() == 1);
  assert(scr_retained_callbacks_discard() == 1);
  assert(atomic_load(&invocations_destroyed) == 102);
  assert(scr_retained_callbacks_active() == 0);
  scr_closure_release(closure);
  assert(atomic_load(&closures_freed) == 2);
  assert(scr_retained_callbacks_destroy());
  assert(!scr_retained_callbacks_configured());

  /* A failed native factory has no registration owner: payloads admitted
   * during the attempted call are destroyed, never delivered later. */
  assert(scr_retained_callbacks_configure(wake_owner, &wakes));
  closure = new_closure();
  token = scr_retained_callbacks_register(closure, &signature, NULL);
  assert(token != NULL);
  assert(scr_callback_token_admit(
      token, &new_invocation(19, false, false)->invocation));
  scr_retained_callbacks_prepare((ScrNativeHandle *)(uintptr_t)1, token);
  abandon_prepared();
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED);
  assert(((TestClosureState *)closure->fn)->total == 0);
  assert(scr_retained_callbacks_active() == 0);
  scr_closure_release(closure);
  assert(atomic_load(&closures_freed) == 3);
  assert(atomic_load(&invocations_destroyed) == 103);
  scr_retained_callbacks_stop_accepting();
  assert(scr_retained_callbacks_destroy());

  /* A callback exception is an explicit owner-turn outcome. It remains in
   * the active exception cell for the target's sink and fences later events. */
  assert(scr_retained_callbacks_configure(wake_owner, &wakes));
  closure = new_closure();
  token = scr_retained_callbacks_register(closure, &signature, NULL);
  assert(token != NULL);
  assert(scr_callback_token_admit(
      token, &new_invocation(23, false, true)->invocation));
  assert(scr_callback_token_admit(
      token, &new_invocation(29, false, false)->invocation));
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION);
  assert(exception_pending);
  assert(((TestClosureState *)closure->fn)->total == 23);
  assert(atomic_load(&invocations_destroyed) == 104);
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION);
  assert(atomic_load(&invocations_destroyed) == 104);
  exception_pending = false;
  assert(scr_retained_callbacks_dispatch() ==
         SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED);
  assert(((TestClosureState *)closure->fn)->total == 52);
  assert(atomic_load(&invocations_destroyed) == 105);
  scr_retained_callbacks_prepare((ScrNativeHandle *)(uintptr_t)1, token);
  abandon_prepared();
  assert(scr_retained_callbacks_active() == 0);
  scr_closure_release(closure);
  assert(atomic_load(&closures_freed) == 4);
  scr_retained_callbacks_stop_accepting();
  assert(scr_retained_callbacks_destroy());

  puts("retained callbacks: ok");
  return 0;
}
