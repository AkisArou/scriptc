#include "scr_runtime.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  size_t rc;
  int64_t total;
} TestAnchor;

typedef struct {
  ScrCallbackInvocation invocation;
  int32_t value;
} TestInvocation;

typedef struct {
  ScrCallbackToken *token;
} TestForeign;

static const char signature;
static const char type_tag;
static _Atomic size_t anchors_freed;
static _Atomic size_t events_destroyed;
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

static void *retain_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  anchor->rc++;
  return anchor;
}

static void release_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  assert(anchor->rc != 0);
  if (--anchor->rc != 0) return;
  atomic_fetch_add(&anchors_freed, 1);
  free(anchor);
}

static bool invoke_callback(ScrCallbackInvocation *base, void *owner_context,
                            size_t slot, uint64_t generation) {
  TestInvocation *invocation = (TestInvocation *)base;
  TestAnchor *anchor = scr_callback_table_acquire(
      owner_context, slot, generation, invocation->invocation.signature);
  assert(anchor != NULL);
  anchor->total += invocation->value;
  release_anchor(anchor);
  return true;
}

static void destroy_event(ScrOwnerGatewayEvent *base) {
  atomic_fetch_add(&events_destroyed, 1);
  free(base);
}

static TestInvocation *new_invocation(int32_t value) {
  TestInvocation *invocation = calloc(1, sizeof *invocation);
  assert(invocation != NULL);
  invocation->invocation.signature = &signature;
  invocation->invocation.invoke = invoke_callback;
  invocation->invocation.payload_destroy = destroy_event;
  invocation->value = value;
  return invocation;
}

static void destroy_foreign(void *opaque) {
  TestForeign *foreign = opaque;
  /* The lifecycle edge must close admission before native cancellation. */
  assert(!scr_callback_token_admit(
      foreign->token, &new_invocation(99)->invocation));
  atomic_fetch_add(&foreign_destroyed, 1);
  free(foreign);
}

static void wake_owner(void *context) { (void)context; }

int main(void) {
  ScrOwnerGateway *gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  ScrCallbackTable *table =
      scr_callback_table_new(gateway, retain_anchor, release_anchor);
  assert(table != NULL);
  TestAnchor *anchor = calloc(1, sizeof *anchor);
  assert(anchor != NULL);
  anchor->rc = 1;
  ScrCallbackToken *token =
      scr_callback_table_register(table, anchor, &signature);
  assert(token != NULL);

  TestForeign *foreign = malloc(sizeof *foreign);
  assert(foreign != NULL);
  foreign->token = token;
  ScrNativeHandle *handle = scr_native_handle_new(
      foreign, destroy_foreign, &type_tag, "TestSubscription");
  assert(handle != NULL);
  scr_native_handle_attach_callback(handle, table, token);
  assert(scr_callback_token_admit(
      token, &new_invocation(7)->invocation));

  scr_native_handle_dispose(handle, &type_tag, "TestSubscription.dispose");
  assert(atomic_load(&foreign_destroyed) == 1);
  assert(scr_callback_token_state(token) == SCR_CALLBACK_TOKEN_CLOSING);
  assert(scr_callback_table_active(table) == 1);
  assert(anchor->rc == 1);
  /* Explicit disposal is alias-safe and cannot close the edge twice. */
  scr_native_handle_dispose(handle, &type_tag, "TestSubscription.dispose");

  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(anchor->total == 7);
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&anchors_freed) == 1);
  assert(atomic_load(&events_destroyed) == 2);
  scr_native_handle_release(handle);
  assert(atomic_load(&handles_allocated) == 0);

  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_callback_table_destroy(table));
  assert(scr_owner_gateway_destroy(gateway));
  puts("callback handle: ok");
  return 0;
}
