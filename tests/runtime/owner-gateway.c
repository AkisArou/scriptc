#include "scr_runtime.h"

#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

enum { PRODUCERS = 8, EVENTS_PER_PRODUCER = 4000 };

typedef struct {
  ScrOwnerGatewayEvent event;
  size_t producer;
  size_t sequence;
  bool stop_once;
  bool discard_on_delivery;
  bool stop_accepting_on_delivery;
  bool nested_drain_on_delivery;
  bool try_destroy_on_delivery;
} TestEvent;

static ScrOwnerGateway *gateway;
static size_t next_sequence[PRODUCERS];
static _Atomic size_t admitted;
static _Atomic size_t allocated;
static _Atomic size_t delivered;
static _Atomic size_t destroyed;
static _Atomic size_t wakes;
static _Atomic size_t producers_done;

static void wake_owner(void *context) {
  (void)context;
  atomic_fetch_add_explicit(&wakes, 1, memory_order_relaxed);
}

static bool deliver_event(ScrOwnerGatewayEvent *base) {
  TestEvent *event = (TestEvent *)base;
  assert(event->producer < PRODUCERS);
  assert(next_sequence[event->producer] == event->sequence);
  next_sequence[event->producer]++;
  atomic_fetch_add_explicit(&delivered, 1, memory_order_relaxed);
  if (event->nested_drain_on_delivery) {
    assert(scr_owner_gateway_drain(gateway, 0) == 0);
  }
  if (event->stop_accepting_on_delivery) {
    scr_owner_gateway_stop_accepting(gateway);
  }
  if (event->discard_on_delivery) {
    (void)scr_owner_gateway_discard(gateway);
  }
  if (event->try_destroy_on_delivery) {
    assert(!scr_owner_gateway_destroy(gateway));
  }
  return !event->stop_once;
}

static void destroy_event(ScrOwnerGatewayEvent *base) {
  atomic_fetch_add_explicit(&destroyed, 1, memory_order_relaxed);
  free(base);
}

static TestEvent *new_event(size_t producer, size_t sequence, bool stop_once) {
  TestEvent *event = calloc(1, sizeof *event);
  assert(event != NULL);
  event->event.deliver = deliver_event;
  event->event.destroy = destroy_event;
  event->producer = producer;
  event->sequence = sequence;
  event->stop_once = stop_once;
  return event;
}

static void *produce(void *opaque) {
  size_t producer = *(size_t *)opaque;
  for (size_t sequence = 0; sequence < EVENTS_PER_PRODUCER; sequence++) {
    bool accepted = scr_owner_gateway_admit(
        gateway, &new_event(producer, sequence, false)->event);
    assert(accepted);
    atomic_fetch_add_explicit(&admitted, 1, memory_order_relaxed);
  }
  atomic_fetch_add_explicit(&producers_done, 1, memory_order_release);
  return NULL;
}

static void *produce_until_stopped(void *opaque) {
  size_t producer = *(size_t *)opaque;
  for (size_t sequence = 0; sequence < EVENTS_PER_PRODUCER; sequence++) {
    TestEvent *event = new_event(producer, sequence, false);
    atomic_fetch_add_explicit(&allocated, 1, memory_order_relaxed);
    if (!scr_owner_gateway_admit(gateway, &event->event)) break;
    atomic_fetch_add_explicit(&admitted, 1, memory_order_relaxed);
  }
  atomic_fetch_add_explicit(&producers_done, 1, memory_order_release);
  return NULL;
}

static void verify_interrupted_snapshot(void) {
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  for (size_t sequence = 0; sequence < 4; sequence++) {
    assert(scr_owner_gateway_admit(
        gateway, &new_event(0, sequence, sequence == 1)->event));
  }
  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  assert(scr_owner_gateway_pending(gateway));
  assert(scr_owner_gateway_drain(gateway, 0) == 2);
  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
  assert(next_sequence[0] == 4);
}

static void verify_concurrent_admission(void) {
  for (size_t i = 0; i < PRODUCERS; i++) next_sequence[i] = 0;
  atomic_store(&admitted, 0);
  atomic_store(&delivered, 0);
  atomic_store(&destroyed, 0);
  atomic_store(&wakes, 0);
  atomic_store(&producers_done, 0);

  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  pthread_t threads[PRODUCERS];
  size_t ids[PRODUCERS];
  for (size_t i = 0; i < PRODUCERS; i++) {
    ids[i] = i;
    assert(pthread_create(&threads[i], NULL, produce, &ids[i]) == 0);
  }

  const size_t expected = PRODUCERS * EVENTS_PER_PRODUCER;
  while (atomic_load_explicit(&producers_done, memory_order_acquire) != PRODUCERS ||
         atomic_load_explicit(&delivered, memory_order_relaxed) != expected) {
    if (scr_owner_gateway_drain(gateway, 127) == 0) sched_yield();
  }
  for (size_t i = 0; i < PRODUCERS; i++) assert(pthread_join(threads[i], NULL) == 0);
  assert(!scr_owner_gateway_pending(gateway));
  assert(atomic_load(&admitted) == expected);
  assert(atomic_load(&delivered) == expected);
  assert(atomic_load(&destroyed) == expected);
  assert(atomic_load(&wakes) > 0);

  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(!scr_owner_gateway_admit(gateway, &new_event(0, EVENTS_PER_PRODUCER, false)->event));
  assert(atomic_load(&destroyed) == expected + 1);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_discard(void) {
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  size_t before = atomic_load(&destroyed);
  for (size_t i = 0; i < 10; i++) {
    assert(scr_owner_gateway_admit(gateway, &new_event(0, i, false)->event));
  }
  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_owner_gateway_discard(gateway) == 10);
  assert(atomic_load(&destroyed) == before + 10);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_reentrant_discard(void) {
  next_sequence[0] = 0;
  atomic_store(&delivered, 0);
  atomic_store(&destroyed, 0);
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  TestEvent *first = new_event(0, 0, false);
  first->discard_on_delivery = true;
  first->try_destroy_on_delivery = true;
  assert(scr_owner_gateway_admit(gateway, &first->event));
  assert(scr_owner_gateway_admit(gateway, &new_event(0, 1, false)->event));
  assert(scr_owner_gateway_admit(gateway, &new_event(0, 2, false)->event));
  assert(scr_owner_gateway_drain(gateway, 0) == 1);
  assert(atomic_load(&delivered) == 1);
  assert(atomic_load(&destroyed) == 3);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_reentrant_stop_and_drain(void) {
  next_sequence[0] = 0;
  atomic_store(&delivered, 0);
  atomic_store(&destroyed, 0);
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  TestEvent *first = new_event(0, 0, false);
  first->stop_accepting_on_delivery = true;
  first->nested_drain_on_delivery = true;
  assert(scr_owner_gateway_admit(gateway, &first->event));
  assert(scr_owner_gateway_admit(gateway, &new_event(0, 1, false)->event));
  assert(scr_owner_gateway_admit(gateway, &new_event(0, 2, false)->event));
  assert(scr_owner_gateway_drain(gateway, 0) == 3);
  assert(atomic_load(&delivered) == 3);
  assert(atomic_load(&destroyed) == 3);
  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_stop_races_admission(void) {
  for (size_t i = 0; i < PRODUCERS; i++) next_sequence[i] = 0;
  atomic_store(&admitted, 0);
  atomic_store(&allocated, 0);
  atomic_store(&delivered, 0);
  atomic_store(&destroyed, 0);
  atomic_store(&producers_done, 0);

  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  pthread_t threads[PRODUCERS];
  size_t ids[PRODUCERS];
  for (size_t i = 0; i < PRODUCERS; i++) {
    ids[i] = i;
    assert(pthread_create(&threads[i], NULL, produce_until_stopped, &ids[i]) == 0);
  }

  while (atomic_load_explicit(&admitted, memory_order_relaxed) < 128 &&
         atomic_load_explicit(&producers_done, memory_order_acquire) != PRODUCERS) {
    sched_yield();
  }
  scr_owner_gateway_stop_accepting(gateway);
  for (size_t i = 0; i < PRODUCERS; i++) assert(pthread_join(threads[i], NULL) == 0);
  while (scr_owner_gateway_pending(gateway)) {
    (void)scr_owner_gateway_drain(gateway, 97);
  }
  (void)scr_owner_gateway_drain(gateway, 0);

  assert(scr_owner_gateway_state(gateway) == SCR_OWNER_GATEWAY_STOPPED);
  assert(atomic_load(&delivered) == atomic_load(&admitted));
  assert(atomic_load(&destroyed) == atomic_load(&allocated));
  size_t sequenced = 0;
  for (size_t i = 0; i < PRODUCERS; i++) sequenced += next_sequence[i];
  assert(sequenced == atomic_load(&delivered));
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

static void verify_failure_wake(void) {
  atomic_store(&wakes, 0);
  gateway = scr_owner_gateway_new(wake_owner, NULL);
  assert(gateway != NULL);
  scr_owner_gateway_report_failure(gateway, SCR_OWNER_GATEWAY_FAILURE_OOM);
  scr_owner_gateway_report_failure(gateway, SCR_OWNER_GATEWAY_FAILURE_OOM);
  assert(atomic_load(&wakes) == 1);
  assert(scr_owner_gateway_pending(gateway));
  assert(scr_owner_gateway_take_failure(gateway) ==
         SCR_OWNER_GATEWAY_FAILURE_OOM);
  assert(scr_owner_gateway_take_failure(gateway) ==
         SCR_OWNER_GATEWAY_FAILURE_NONE);
  assert(!scr_owner_gateway_pending(gateway));
  scr_owner_gateway_stop_accepting(gateway);
  assert(scr_owner_gateway_quiescent(gateway));
  assert(scr_owner_gateway_destroy(gateway));
  gateway = NULL;
}

int main(void) {
  verify_interrupted_snapshot();
  verify_concurrent_admission();
  verify_discard();
  verify_reentrant_discard();
  verify_reentrant_stop_and_drain();
  verify_stop_races_admission();
  verify_failure_wake();
  puts("owner gateway: ok");
  return 0;
}
