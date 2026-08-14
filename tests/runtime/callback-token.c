#include "scr_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

enum { PRODUCERS = 6, EVENTS_PER_PRODUCER = 5000 };

typedef struct {
  ScrCallbackInvocation invocation;
  size_t producer;
  size_t sequence;
  bool interrupt;
} TestInvocation;

static const char expected_signature;
static const char wrong_signature;
static ScrOwnerGateway *gateway;
static ScrCallbackToken *token;
static const char owner_context;
static size_t next_sequence[PRODUCERS];
static _Atomic size_t allocated;
static _Atomic size_t admitted;
static _Atomic size_t delivered;
static _Atomic size_t destroyed;
static _Atomic size_t producers_done;

static void wake_owner(void *context) { (void)context; }

static bool invoke_callback(ScrCallbackInvocation *base, void *context,
                            size_t slot, uint64_t generation) {
  TestInvocation *invocation = (TestInvocation *)base;
  assert(context == &owner_context);
  assert(slot == 17);
  assert(generation == 29);
  assert(next_sequence[invocation->producer] == invocation->sequence);
  next_sequence[invocation->producer]++;
  atomic_fetch_add_explicit(&delivered, 1, memory_order_relaxed);
  return !invocation->interrupt;
}

static void destroy_payload(ScrOwnerGatewayEvent *base) {
  atomic_fetch_add_explicit(&destroyed, 1, memory_order_relaxed);
  free(base);
}

static TestInvocation *new_invocation(size_t producer, size_t sequence,
                                      const void *signature, bool interrupt) {
  TestInvocation *invocation = calloc(1, sizeof *invocation);
  assert(invocation != NULL);
  invocation->invocation.signature = signature;
  invocation->invocation.invoke = invoke_callback;
  invocation->invocation.payload_destroy = destroy_payload;
  invocation->producer = producer;
  invocation->sequence = sequence;
  invocation->interrupt = interrupt;
  atomic_fetch_add_explicit(&allocated, 1, memory_order_relaxed);
  return invocation;
}

static void reset_counts(void) {
  for (size_t i = 0; i < PRODUCERS; i++) next_sequence[i] = 0;
  atomic_store(&allocated, 0);
  atomic_store(&admitted, 0);
  atomic_store(&delivered, 0);
  atomic_store(&destroyed, 0);
  atomic_store(&producers_done, 0);
}

static void new_transport(void) {
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  token = scr_callback_token_new(gateway, (void *)&owner_context, 17, 29,
                                 &expected_signature);
  assert(token != NULL);
}

static void stop_transport(void) {
  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_identity_and_leases(void) {
  reset_counts();
  new_transport();
  assert(!scr_callback_token_admit(
      token, &new_invocation(0, 0, &wrong_signature, false)->invocation));
  assert(scr_callback_token_leases(token) == 0);

  for (size_t sequence = 0; sequence < 4; sequence++) {
    assert(scr_callback_token_admit(
        token,
        &new_invocation(0, sequence, &expected_signature, sequence == 1)
             ->invocation));
  }
  assert(scr_callback_token_leases(token) == 4);
  assert(scr_callback_token_begin_close(token));
  assert(scr_callback_token_state(token) == SCR_CALLBACK_TOKEN_CLOSING);
  assert(scr_callback_token_cancellation_complete(token));
  assert(!scr_callback_token_try_destroy(token));
  assert(!scr_callback_token_admit(
      token, &new_invocation(0, 4, &expected_signature, false)->invocation));

  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  assert(scr_callback_token_leases(token) == 2);
  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  assert(scr_callback_token_leases(token) == 0);
  assert(scr_callback_token_try_destroy(token));
  token = NULL;
  assert(atomic_load(&allocated) == 6);
  assert(atomic_load(&delivered) == 4);
  assert(atomic_load(&destroyed) == 6);
  stop_transport();
}

static void *produce_until_closed(void *opaque) {
  size_t producer = *(size_t *)opaque;
  for (size_t sequence = 0; sequence < EVENTS_PER_PRODUCER; sequence++) {
    TestInvocation *invocation =
        new_invocation(producer, sequence, &expected_signature, false);
    if (!scr_callback_token_admit(token, &invocation->invocation)) break;
    atomic_fetch_add_explicit(&admitted, 1, memory_order_relaxed);
  }
  atomic_fetch_add_explicit(&producers_done, 1, memory_order_release);
  return NULL;
}

static void verify_close_races_admission(void) {
  reset_counts();
  new_transport();
  pthread_t threads[PRODUCERS];
  size_t ids[PRODUCERS];
  for (size_t i = 0; i < PRODUCERS; i++) {
    ids[i] = i;
    assert(pthread_create(&threads[i], NULL, produce_until_closed, &ids[i]) == 0);
  }
  while (atomic_load_explicit(&admitted, memory_order_relaxed) < 256 &&
         atomic_load_explicit(&producers_done, memory_order_acquire) !=
             PRODUCERS) {
    sched_yield();
  }
  assert(scr_callback_token_begin_close(token));
  for (size_t i = 0; i < PRODUCERS; i++) {
    assert(pthread_join(threads[i], NULL) == 0);
  }
  assert(scr_callback_token_cancellation_complete(token));
  assert(scr_callback_token_leases(token) == atomic_load(&admitted));
  assert(!scr_callback_token_try_destroy(token));

  while (scr_owner_gateway_pending(gateway)) {
    (void)scr_owner_gateway_drain(gateway, 113);
  }
  assert(atomic_load(&delivered) == atomic_load(&admitted));
  assert(atomic_load(&destroyed) == atomic_load(&allocated));
  assert(scr_callback_token_leases(token) == 0);
  assert(scr_callback_token_try_destroy(token));
  token = NULL;
  stop_transport();
}

static void verify_discard_releases_leases(void) {
  reset_counts();
  new_transport();
  for (size_t i = 0; i < 20; i++) {
    assert(scr_callback_token_admit(
        token, &new_invocation(0, i, &expected_signature, false)->invocation));
  }
  assert(scr_callback_token_begin_close(token));
  assert(scr_callback_token_cancellation_complete(token));
  assert(scr_owner_gateway_discard(gateway) == 20);
  assert(scr_callback_token_leases(token) == 0);
  assert(atomic_load(&delivered) == 0);
  assert(atomic_load(&destroyed) == 20);
  assert(scr_callback_token_try_destroy(token));
  token = NULL;
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

int main(void) {
  verify_identity_and_leases();
  verify_close_races_admission();
  verify_discard_releases_leases();
  puts("callback token: ok");
  return 0;
}
