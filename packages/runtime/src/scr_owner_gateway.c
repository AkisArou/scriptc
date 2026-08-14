/* Runtime-owner ingress gateway.
 *
 * The queue lock protects only pointer publication and lifecycle bits. No
 * event delivery, payload destruction, allocation, or target wake executes
 * inside it. This keeps producer contention independent of TypeScript work
 * while giving admission and stop one linearization order. */
#include "scr_runtime.h"

#include <stdatomic.h>
#include <stdlib.h>

struct ScrOwnerGateway {
  atomic_flag lock;
  ScrOwnerGatewayEvent *head;
  ScrOwnerGatewayEvent *tail;
  ScrOwnerGatewayWakeFn wake;
  void *wake_context;
  _Atomic ScrOwnerGatewayState state;
  ScrOwnerGatewayFailure failure;
  bool wake_armed;
  bool draining;
};

static void scr_owner_gateway_lock(ScrOwnerGateway *gateway) {
  while (atomic_flag_test_and_set_explicit(&gateway->lock, memory_order_acquire)) {
    /* The critical section is only an intrusive-list splice. Avoid a platform
     * scheduler dependency in this generic runtime primitive. */
  }
}

static void scr_owner_gateway_unlock(ScrOwnerGateway *gateway) {
  atomic_flag_clear_explicit(&gateway->lock, memory_order_release);
}

static void scr_owner_gateway_wake(ScrOwnerGateway *gateway) {
  if (gateway->wake != NULL) gateway->wake(gateway->wake_context);
}

ScrOwnerGateway *scr_owner_gateway_new(ScrOwnerGatewayWakeFn wake,
                                        void *wake_context) {
  ScrOwnerGateway *gateway = calloc(1, sizeof *gateway);
  if (gateway == NULL) return NULL;
  atomic_flag_clear_explicit(&gateway->lock, memory_order_relaxed);
  gateway->wake = wake;
  gateway->wake_context = wake_context;
  atomic_init(&gateway->state, SCR_OWNER_GATEWAY_RUNNING);
  return gateway;
}

bool scr_owner_gateway_admit(ScrOwnerGateway *gateway,
                             ScrOwnerGatewayEvent *event) {
  if (event == NULL) return false;
  event->next = NULL;
  if (gateway == NULL) {
    event->destroy(event);
    return false;
  }

  bool accepted = false;
  bool wake = false;
  scr_owner_gateway_lock(gateway);
  if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
      SCR_OWNER_GATEWAY_RUNNING) {
    if (gateway->tail == NULL) gateway->head = event;
    else gateway->tail->next = event;
    gateway->tail = event;
    accepted = true;
    if (!gateway->wake_armed) {
      gateway->wake_armed = true;
      wake = true;
    }
  }
  scr_owner_gateway_unlock(gateway);

  if (!accepted) event->destroy(event);
  else if (wake) scr_owner_gateway_wake(gateway);
  return accepted;
}

void scr_owner_gateway_report_failure(ScrOwnerGateway *gateway,
                                      ScrOwnerGatewayFailure failure) {
  if (gateway == NULL || failure == SCR_OWNER_GATEWAY_FAILURE_NONE) return;
  bool wake = false;
  scr_owner_gateway_lock(gateway);
  if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
          SCR_OWNER_GATEWAY_RUNNING &&
      gateway->failure == SCR_OWNER_GATEWAY_FAILURE_NONE) {
    gateway->failure = failure;
    if (!gateway->wake_armed) {
      gateway->wake_armed = true;
      wake = true;
    }
  }
  scr_owner_gateway_unlock(gateway);
  if (wake) scr_owner_gateway_wake(gateway);
}

ScrOwnerGatewayFailure scr_owner_gateway_take_failure(
    ScrOwnerGateway *gateway) {
  if (gateway == NULL) return SCR_OWNER_GATEWAY_FAILURE_NONE;
  scr_owner_gateway_lock(gateway);
  ScrOwnerGatewayFailure failure = gateway->failure;
  gateway->failure = SCR_OWNER_GATEWAY_FAILURE_NONE;
  scr_owner_gateway_unlock(gateway);
  return failure;
}

/* Detach one admission-order snapshot, bounded only while walking links.
 * Producers remain free to append to the now-independent live queue. */
static ScrOwnerGatewayEvent *scr_owner_gateway_detach(
    ScrOwnerGateway *gateway, size_t budget, ScrOwnerGatewayEvent **last) {
  ScrOwnerGatewayEvent *first = gateway->head;
  *last = NULL;
  if (first == NULL) return NULL;

  ScrOwnerGatewayEvent *end = first;
  size_t count = 1;
  while (end->next != NULL && (budget == 0 || count < budget)) {
    end = end->next;
    count++;
  }
  gateway->head = end->next;
  end->next = NULL;
  if (gateway->head == NULL) gateway->tail = NULL;
  *last = end;
  return first;
}

size_t scr_owner_gateway_drain(ScrOwnerGateway *gateway, size_t budget) {
  if (gateway == NULL) return 0;

  ScrOwnerGatewayEvent *detached_last = NULL;
  scr_owner_gateway_lock(gateway);
  /* Delivery can run arbitrary compiled code, so a nested owner-loop turn is
   * possible. The outer drain retains admission order and sole ownership of
   * its detached snapshot. */
  if (gateway->draining) {
    scr_owner_gateway_unlock(gateway);
    return 0;
  }
  ScrOwnerGatewayEvent *event =
      scr_owner_gateway_detach(gateway, budget, &detached_last);
  if (event == NULL) {
    gateway->wake_armed = false;
    if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
        SCR_OWNER_GATEWAY_STOPPING) {
      atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPED,
                            memory_order_release);
    }
    scr_owner_gateway_unlock(gateway);
    return 0;
  }
  gateway->draining = true;
  scr_owner_gateway_unlock(gateway);

  size_t delivered = 0;
  ScrOwnerGatewayEvent *remaining = NULL;
  while (event != NULL) {
    ScrOwnerGatewayEvent *next = event->next;
    bool keep_draining = event->deliver(event);
    event->destroy(event);
    delivered++;
    if (!keep_draining ||
        atomic_load_explicit(&gateway->state, memory_order_acquire) ==
            SCR_OWNER_GATEWAY_STOPPED) {
      remaining = next;
      break;
    }
    event = next;
  }

  bool wake = false;
  ScrOwnerGatewayEvent *discarded = NULL;
  scr_owner_gateway_lock(gateway);
  gateway->draining = false;
  if (remaining != NULL) {
    if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
        SCR_OWNER_GATEWAY_STOPPED) {
      /* Reentrant shutdown discarded the live queue while this detached
       * snapshot was delivering. Its untouched suffix follows that policy. */
      discarded = remaining;
    } else {
      /* A delivery boundary interrupted the detached snapshot. It precedes
       * every event producers admitted meanwhile, so prepend it unchanged. */
      detached_last->next = gateway->head;
      gateway->head = remaining;
      if (gateway->tail == NULL) gateway->tail = detached_last;
    }
  }
  if (gateway->head != NULL) {
    gateway->wake_armed = true;
    wake = true;
  } else {
    gateway->wake_armed = false;
    if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
        SCR_OWNER_GATEWAY_STOPPING) {
      atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPED,
                            memory_order_release);
    }
  }
  scr_owner_gateway_unlock(gateway);
  while (discarded != NULL) {
    ScrOwnerGatewayEvent *next = discarded->next;
    discarded->destroy(discarded);
    discarded = next;
  }
  if (wake) scr_owner_gateway_wake(gateway);
  return delivered;
}

void scr_owner_gateway_stop_accepting(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return;
  scr_owner_gateway_lock(gateway);
  if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
      SCR_OWNER_GATEWAY_RUNNING) {
    atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPING,
                          memory_order_release);
  }
  if (gateway->head == NULL &&
      !gateway->draining &&
      atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
          SCR_OWNER_GATEWAY_STOPPING) {
    atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPED,
                          memory_order_release);
    gateway->wake_armed = false;
  }
  scr_owner_gateway_unlock(gateway);
}

size_t scr_owner_gateway_discard(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return 0;
  scr_owner_gateway_lock(gateway);
  if (atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
      SCR_OWNER_GATEWAY_RUNNING) {
    atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPING,
                          memory_order_release);
  }
  ScrOwnerGatewayEvent *event = gateway->head;
  gateway->head = NULL;
  gateway->tail = NULL;
  gateway->wake_armed = false;
  gateway->failure = SCR_OWNER_GATEWAY_FAILURE_NONE;
  atomic_store_explicit(&gateway->state, SCR_OWNER_GATEWAY_STOPPED,
                        memory_order_release);
  scr_owner_gateway_unlock(gateway);

  size_t discarded = 0;
  while (event != NULL) {
    ScrOwnerGatewayEvent *next = event->next;
    event->destroy(event);
    discarded++;
    event = next;
  }
  return discarded;
}

bool scr_owner_gateway_pending(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return false;
  scr_owner_gateway_lock(gateway);
  bool pending = gateway->head != NULL ||
                 gateway->failure != SCR_OWNER_GATEWAY_FAILURE_NONE;
  scr_owner_gateway_unlock(gateway);
  return pending;
}

ScrOwnerGatewayState scr_owner_gateway_state(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return SCR_OWNER_GATEWAY_STOPPED;
  return atomic_load_explicit(&gateway->state, memory_order_acquire);
}

bool scr_owner_gateway_quiescent(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return true;
  scr_owner_gateway_lock(gateway);
  bool ready = atomic_load_explicit(&gateway->state, memory_order_relaxed) ==
                   SCR_OWNER_GATEWAY_STOPPED &&
               gateway->head == NULL &&
               gateway->failure == SCR_OWNER_GATEWAY_FAILURE_NONE &&
               !gateway->draining;
  scr_owner_gateway_unlock(gateway);
  return ready;
}

bool scr_owner_gateway_destroy(ScrOwnerGateway *gateway) {
  if (gateway == NULL) return true;
  if (!scr_owner_gateway_quiescent(gateway)) return false;
  free(gateway);
  return true;
}
