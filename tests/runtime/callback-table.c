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
  bool interrupt;
} TestInvocation;

static const char signature;
static const char wrong_signature;
static _Atomic size_t anchors_freed;
static _Atomic size_t events_destroyed;

static void *retain_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  anchor->rc++;
  return anchor;
}

static void release_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  assert(anchor->rc != 0);
  if (--anchor->rc != 0) return;
  atomic_fetch_add_explicit(&anchors_freed, 1, memory_order_relaxed);
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
  return !invocation->interrupt;
}

static void destroy_event(ScrOwnerGatewayEvent *base) {
  atomic_fetch_add_explicit(&events_destroyed, 1, memory_order_relaxed);
  free(base);
}

static TestInvocation *new_invocation(int32_t value, const void *event_signature,
                                      bool interrupt) {
  TestInvocation *invocation = calloc(1, sizeof *invocation);
  assert(invocation != NULL);
  invocation->invocation.signature = event_signature;
  invocation->invocation.invoke = invoke_callback;
  invocation->invocation.payload_destroy = destroy_event;
  invocation->value = value;
  invocation->interrupt = interrupt;
  return invocation;
}

static void wake_owner(void *context) { (void)context; }

int main(void) {
  ScrOwnerGateway *gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  ScrCallbackTable *table =
      scr_callback_table_new(gateway, retain_anchor, release_anchor);
  assert(table != NULL);

  TestAnchor *first = calloc(1, sizeof *first);
  assert(first != NULL);
  first->rc = 1;
  ScrCallbackToken *token =
      scr_callback_table_register(table, first, &signature);
  assert(token != NULL);
  size_t first_slot = scr_callback_token_slot(token);
  uint64_t first_generation = scr_callback_token_generation(token);
  assert(scr_callback_table_active(table) == 1);

  for (int32_t value = 1; value <= 4; value++) {
    assert(scr_callback_token_admit(
        token, &new_invocation(value, &signature, value == 2)->invocation));
  }
  assert(!scr_callback_token_admit(
      token, &new_invocation(99, &wrong_signature, false)->invocation));
  assert(scr_callback_table_begin_close(table, token));
  assert(scr_callback_table_cancellation_complete(table, token));
  assert(scr_callback_table_collect(table) == 0);
  assert(first->rc == 1);

  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  assert(first->total == 3);
  assert(scr_callback_table_collect(table) == 0);
  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  assert(first->total == 10);
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&anchors_freed) == 1);
  assert(scr_callback_table_active(table) == 0);
  assert(scr_callback_table_acquire(table, first_slot, first_generation,
                                    &signature) == NULL);

  TestAnchor *second = calloc(1, sizeof *second);
  assert(second != NULL);
  second->rc = 1;
  token = scr_callback_table_register(table, second, &signature);
  assert(token != NULL);
  assert(scr_callback_token_slot(token) == first_slot);
  assert(scr_callback_token_generation(token) == first_generation + 1);
  TestAnchor *borrow = scr_callback_table_acquire(
      table, scr_callback_token_slot(token),
      scr_callback_token_generation(token), &signature);
  assert(borrow == second && second->rc == 2);
  release_anchor(borrow);
  assert(scr_callback_table_begin_close(table, token));
  assert(scr_callback_table_cancellation_complete(table, token));
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&anchors_freed) == 2);
  assert(atomic_load(&events_destroyed) == 5);

  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_callback_table_destroy(table));
  assert(scr_owner_gateway_destroy(gateway));
  puts("callback table: ok");
  return 0;
}
