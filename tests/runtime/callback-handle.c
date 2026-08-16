#include "scr_runtime.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  size_t rc;
  int64_t total;
  ScrNativeHandle *captured;
  bool traced;
} TestAnchor;

typedef struct {
  ScrCallbackInvocation invocation;
  int32_t value;
} TestInvocation;

typedef struct {
  ScrCallbackToken *token;
  bool connected;
} TestForeign;

static const char signature;
static const ScrNativeHandleType handle_type = {NULL, 0, false, false};
static const ScrNativeHandleType traced_handle_type = {NULL, 0, true, false};
static _Atomic size_t anchors_freed;
static _Atomic size_t events_destroyed;
static _Atomic size_t foreign_destroyed;
static _Atomic size_t handles_allocated;
static _Atomic size_t receivers_destroyed;

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
  if (anchor->traced) scr_cyc_mark_live(anchor);
  anchor->rc++;
  return anchor;
}

static void release_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  assert(anchor->rc != 0);
  if (--anchor->rc != 0) {
    if (anchor->traced) scr_cyc_on_release(anchor);
    return;
  }
  if (anchor->traced) {
    scr_cyc_on_dead(anchor);
    ScrNativeHandle *captured = anchor->captured;
    anchor->captured = NULL;
    scr_native_handle_release(captured);
  }
  atomic_fetch_add(&anchors_freed, 1);
  if (anchor->traced) scr_cyc_free(anchor);
  else free(anchor);
}

static void trace_anchor(void *opaque, ScrTraceVisit visit, void *context) {
  TestAnchor *anchor = opaque;
  visit(anchor->captured, context);
}

static void collect_anchor(void *opaque) {
  TestAnchor *anchor = opaque;
  /* captured is a traced edge already accounted by trial deletion. */
  atomic_fetch_add(&anchors_freed, 1);
  scr_cyc_free(anchor);
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
  if (foreign->connected) {
    assert(!scr_callback_token_admit(
        foreign->token, &new_invocation(99)->invocation));
  }
  atomic_fetch_add(&foreign_destroyed, 1);
  free(foreign);
}

static void destroy_receiver(void *opaque) {
  atomic_fetch_add(&receivers_destroyed, 1);
  free(opaque);
}


/* An object payload, modelled the way the emitted trampoline sees one: a
 * refcounted foreign object whose reference the signal dispatch took before
 * queueing, and a destructor that gives exactly that reference back. */
typedef struct {
  size_t rc;
} TestPayload;

static _Atomic size_t payloads_freed;
static _Atomic size_t payload_unrefs;

static const ScrNativeHandleType payload_handle_type = {NULL, 0, false, true};

static void unref_payload(void *opaque) {
  TestPayload *payload = opaque;
  atomic_fetch_add(&payload_unrefs, 1);
  assert(payload->rc != 0);
  if (--payload->rc == 0) {
    atomic_fetch_add(&payloads_freed, 1);
    free(payload);
  }
}

typedef struct {
  ScrCallbackInvocation invocation;
  /* The emitted record stores the referenced pointer, not a cell: a cell can
   * only be made on the owner thread, and the signal may fire on another. */
  void *payload;
} PayloadInvocation;

static _Atomic size_t payload_deliveries;
static ScrNativeHandle *delivered_cell;

static bool invoke_payload(ScrCallbackInvocation *base, void *owner_context,
                           size_t slot, uint64_t generation) {
  PayloadInvocation *invocation = (PayloadInvocation *)base;
  TestAnchor *anchor = scr_callback_table_acquire(
      owner_context, slot, generation, invocation->invocation.signature);
  assert(anchor != NULL);
  /* Exactly what the trampoline emits: reuse the object's cell if it has one,
   * handing the surplus reference back, and clear the slot either way so the
   * dropped path does not release a reference that now belongs to a cell. */
  ScrNativeHandle *cell =
      scr_native_handle_interned(&payload_handle_type, invocation->payload);
  if (cell != NULL) {
    unref_payload(invocation->payload);
  } else {
    cell = scr_native_handle_prepare(
        unref_payload, &payload_handle_type, "TestPayload");
    scr_native_handle_commit(cell, invocation->payload);
  }
  invocation->payload = NULL;
  atomic_fetch_add(&payload_deliveries, 1);
  /* The callee owns the reference it is handed. */
  delivered_cell = cell;
  release_anchor(anchor);
  return true;
}

static void destroy_payload_event(ScrOwnerGatewayEvent *base) {
  PayloadInvocation *invocation = (PayloadInvocation *)base;
  if (invocation->payload != NULL) unref_payload(invocation->payload);
  atomic_fetch_add(&events_destroyed, 1);
  free(base);
}

static PayloadInvocation *new_payload_invocation(TestPayload *payload) {
  PayloadInvocation *invocation = calloc(1, sizeof *invocation);
  assert(invocation != NULL);
  invocation->invocation.signature = &signature;
  invocation->invocation.invoke = invoke_payload;
  invocation->invocation.payload_destroy = destroy_payload_event;
  /* The dispatch references the payload before queueing it. */
  payload->rc++;
  invocation->payload = payload;
  return invocation;
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

  ScrNativeHandle *handle = scr_native_handle_prepare(
      destroy_foreign, &handle_type, "TestSubscription");
  assert(handle != NULL);
  scr_native_handle_prepare_callback(handle, table, token);
  TestForeign *foreign = malloc(sizeof *foreign);
  assert(foreign != NULL);
  foreign->token = token;
  foreign->connected = true;
  scr_native_handle_commit(handle, foreign);
  assert(scr_callback_token_admit(
      token, &new_invocation(7)->invocation));

  scr_native_handle_dispose(handle, &handle_type, "TestSubscription.dispose");
  assert(atomic_load(&foreign_destroyed) == 1);
  assert(scr_callback_token_state(token) == SCR_CALLBACK_TOKEN_CLOSING);
  assert(scr_callback_table_active(table) == 1);
  assert(anchor->rc == 1);
  /* Explicit disposal is alias-safe and cannot close the edge twice. */
  scr_native_handle_dispose(handle, &handle_type, "TestSubscription.dispose");

  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(anchor->total == 7);
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&anchors_freed) == 1);
  assert(atomic_load(&events_destroyed) == 2);
  scr_native_handle_release(handle);
  assert(atomic_load(&handles_allocated) == 0);

  /* Explicit cancellation closes and removes only the callback lifecycle;
   * the native handle remains live and repeated cancellation is idempotent. */
  anchor = calloc(1, sizeof *anchor);
  assert(anchor != NULL);
  anchor->rc = 1;
  token = scr_callback_table_register(table, anchor, &signature);
  assert(token != NULL);
  handle = scr_native_handle_prepare(
      destroy_foreign, &handle_type, "TestConnection");
  scr_native_handle_prepare_callback(handle, table, token);
  foreign = malloc(sizeof *foreign);
  assert(foreign != NULL);
  foreign->token = token;
  foreign->connected = true;
  scr_native_handle_commit(handle, foreign);
  assert(scr_callback_token_admit(token, &new_invocation(11)->invocation));
  assert(scr_native_handle_callbacks_begin(
      handle, &handle_type, "TestConnection.disconnect"));
  assert(!scr_callback_token_admit(token, &new_invocation(99)->invocation));
  foreign->connected = false;
  scr_native_handle_callbacks_complete(handle);
  assert(!scr_native_handle_callbacks_begin(
      handle, &handle_type, "TestConnection.disconnect"));
  assert(scr_native_handle_require(
      handle, &handle_type, "TestConnection.connected") == foreign);
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(anchor->total == 11);
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&anchors_freed) == 2);
  assert(atomic_load(&events_destroyed) == 4);
  scr_native_handle_dispose(handle, &handle_type, "TestConnection.release");
  scr_native_handle_release(handle);
  assert(atomic_load(&foreign_destroyed) == 2);
  assert(atomic_load(&handles_allocated) == 0);

  /* A failed factory rolls back its staged edge without ever claiming an
   * owner. Payloads admitted during the call are destroyed, not delivered. */
  anchor = calloc(1, sizeof *anchor);
  assert(anchor != NULL);
  anchor->rc = 1;
  token = scr_callback_table_register(table, anchor, &signature);
  assert(token != NULL);
  handle = scr_native_handle_prepare(
      destroy_foreign, &handle_type, "TestSubscription");
  scr_native_handle_prepare_callback(handle, table, token);
  assert(scr_callback_token_admit(
      token, &new_invocation(41)->invocation));
  scr_native_handle_abandon(handle);
  assert(atomic_load(&handles_allocated) == 0);
  assert(atomic_load(&anchors_freed) == 3);
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(scr_callback_table_collect(table) == 1);
  assert(atomic_load(&events_destroyed) == 5);

  /* Receiver ownership is a collector-visible graph, not an external root:
   * receiver -> subscription -> closure -> receiver is reclaimed together. */
  ScrNativeHandle *receiver = scr_native_handle_prepare(
      destroy_receiver, &traced_handle_type, "TestReceiver");
  int *receiver_foreign = malloc(sizeof *receiver_foreign);
  assert(receiver_foreign != NULL);
  *receiver_foreign = 1;
  scr_native_handle_commit(receiver, receiver_foreign);

  anchor = scr_cyc_alloc(sizeof *anchor, trace_anchor, collect_anchor);
  anchor->rc = 1;
  anchor->captured = scr_native_handle_retain(receiver);
  anchor->traced = true;
  token = scr_callback_table_register(table, anchor, &signature);
  assert(token != NULL);

  handle = scr_native_handle_prepare(
      destroy_foreign, &traced_handle_type, "TestSubscription");
  scr_native_handle_prepare_callback(handle, table, token);
  scr_native_handle_prepare_owner(handle, receiver);
  foreign = malloc(sizeof *foreign);
  assert(foreign != NULL);
  foreign->token = token;
  foreign->connected = true;
  scr_native_handle_commit(handle, foreign);

  scr_native_handle_release(handle);
  scr_native_handle_release(receiver);
  assert(scr_callback_table_active(table) == 1);
  scr_collect_cycles();
  assert(scr_callback_table_active(table) == 0);
  assert(atomic_load(&anchors_freed) == 4);
  assert(atomic_load(&foreign_destroyed) == 3);
  assert(atomic_load(&receivers_destroyed) == 1);
  assert(atomic_load(&handles_allocated) == 0);

  /* An object payload crosses as a reference the dispatch took. Three paths
   * have to give exactly that reference back: a delivery that builds the
   * object's first cell, a delivery that finds an existing one, and a delivery
   * dropped before it ever runs. */
  anchor = calloc(1, sizeof *anchor);
  assert(anchor != NULL);
  anchor->rc = 1;
  token = scr_callback_table_register(table, anchor, &signature);
  assert(token != NULL);

  TestPayload *payload = calloc(1, sizeof *payload);
  assert(payload != NULL);
  payload->rc = 1; /* the reference the emitter itself holds */

  /* First delivery: the object has no cell, so the queued reference becomes
   * one. */
  assert(scr_callback_token_admit(
      token, &new_payload_invocation(payload)->invocation));
  assert(payload->rc == 2);
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(atomic_load(&payload_deliveries) == 1);
  ScrNativeHandle *first_cell = delivered_cell;
  assert(first_cell != NULL);
  assert(payload->rc == 2);

  /* Second delivery while the cell is alive: interning finds it, and the
   * surplus reference goes back immediately rather than accumulating. */
  assert(scr_callback_token_admit(
      token, &new_payload_invocation(payload)->invocation));
  assert(payload->rc == 3);
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(atomic_load(&payload_deliveries) == 2);
  assert(payload->rc == 2);
  /* Interning hands back a retained cell, so this delivery owns one too. */
  assert(delivered_cell == first_cell);
  scr_native_handle_release(delivered_cell);
  scr_native_handle_release(first_cell);
  assert(payload->rc == 1);
  assert(atomic_load(&payloads_freed) == 0);

  /* A delivery dropped before it runs never reaches the owner, so the
   * record's own destructor is what closes the reference. */
  handle = scr_native_handle_prepare(
      destroy_foreign, &handle_type, "TestPayloadSubscription");
  scr_native_handle_prepare_callback(handle, table, token);
  assert(scr_callback_token_admit(
      token, &new_payload_invocation(payload)->invocation));
  assert(payload->rc == 2);
  scr_native_handle_abandon(handle);
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(atomic_load(&payload_deliveries) == 2);
  assert(payload->rc == 1);
  assert(scr_callback_table_collect(table) == 1);

  unref_payload(payload);
  assert(atomic_load(&payloads_freed) == 1);
  assert(atomic_load(&handles_allocated) == 0);

  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_callback_table_destroy(table));
  assert(scr_owner_gateway_destroy(gateway));
  puts("callback handle: ok");
  return 0;
}
