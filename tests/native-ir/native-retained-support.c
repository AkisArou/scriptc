#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdlib.h>

#include "../../packages/runtime/src/scr_runtime.h"

static pthread_mutex_t callback_wake_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t callback_wake_condition = PTHREAD_COND_INITIALIZER;
static _Atomic int32_t callback_wakes;
static bool attached_pending;
static bool attached_expects_timer_deadline;
static int32_t attached_observations[3];
static size_t attached_observation_count;

static void scriptc_test_callback_wake(void *context) {
  (void)context;
  pthread_mutex_lock(&callback_wake_mutex);
  atomic_fetch_add_explicit(&callback_wakes, 1, memory_order_release);
  pthread_cond_signal(&callback_wake_condition);
  pthread_mutex_unlock(&callback_wake_mutex);
}

int32_t scriptc_test_callbacks_configure(void) {
  atomic_store_explicit(&callback_wakes, 0, memory_order_relaxed);
  return scr_retained_callbacks_configure(scriptc_test_callback_wake, NULL)
      ? 1
      : 0;
}

int32_t scriptc_test_callbacks_wait_and_dispatch(int32_t expected_wakes) {
  pthread_mutex_lock(&callback_wake_mutex);
  while (atomic_load_explicit(&callback_wakes, memory_order_acquire) <
         expected_wakes) {
    pthread_cond_wait(&callback_wake_condition, &callback_wake_mutex);
  }
  pthread_mutex_unlock(&callback_wake_mutex);
  ScrRetainedCallbackDispatch dispatched = scr_retained_callbacks_dispatch();
  if (dispatched != SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED) return 0;
  return scr_loop_checkpoint() == SCR_LOOP_CHECKPOINT_COMPLETE ? 1 : 0;
}

int32_t scriptc_test_callbacks_active(void) {
  return (int32_t)scr_retained_callbacks_active();
}

int32_t scriptc_test_callbacks_shutdown(void) {
  scr_retained_callbacks_stop_accepting();
  return scr_retained_callbacks_destroy() ? 1 : 0;
}

static bool scriptc_test_attached_pending(void *context) {
  (void)context;
  return attached_pending;
}

static ScrAttachedLoopPollResult scriptc_test_attached_poll(
    void *context, double max_wait_ms) {
  (void)context;
  if ((attached_expects_timer_deadline ? max_wait_ms < 0.0
                                       : max_wait_ms != -1.0) ||
      atomic_load_explicit(&callback_wakes, memory_order_acquire) != 1) {
    return SCR_ATTACHED_LOOP_POLL_FAILED;
  }
  if (scr_retained_callbacks_dispatch() !=
          SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED ||
      scr_loop_checkpoint() != SCR_LOOP_CHECKPOINT_COMPLETE) {
    return SCR_ATTACHED_LOOP_POLL_FAILED;
  }
  attached_pending = false;
  return SCR_ATTACHED_LOOP_POLL_COMPLETE;
}

static void scriptc_test_attached_cleanup(void) {
  scr_retained_callbacks_stop_accepting();
  size_t expected_count = attached_expects_timer_deadline ? 3 : 2;
  if (attached_pending || attached_observation_count != expected_count ||
      attached_observations[0] != 41 || attached_observations[1] != 42 ||
      (attached_expects_timer_deadline && attached_observations[2] != 43) ||
      scr_retained_callbacks_active() != 0 ||
      !scr_retained_callbacks_destroy() ||
      !scr_loop_clear_attached(NULL)) {
    abort();
  }
}

static int32_t scriptc_test_callbacks_configure_attached_mode(
    bool expects_timer_deadline) {
  atomic_store_explicit(&callback_wakes, 0, memory_order_relaxed);
  attached_pending = true;
  attached_expects_timer_deadline = expects_timer_deadline;
  attached_observation_count = 0;
  if (!scr_retained_callbacks_configure(scriptc_test_callback_wake, NULL) ||
      !scr_loop_set_attached(scriptc_test_attached_pending,
                             scriptc_test_attached_poll, NULL)) {
    return 0;
  }
  scr_atexit(scriptc_test_attached_cleanup);
  return 1;
}

int32_t scriptc_test_callbacks_configure_attached(void) {
  return scriptc_test_callbacks_configure_attached_mode(false);
}

int32_t scriptc_test_callbacks_configure_attached_timer(void) {
  return scriptc_test_callbacks_configure_attached_mode(true);
}

void scriptc_test_callbacks_observe_attached(int32_t value) {
  if (attached_observation_count >= 3) abort();
  attached_observations[attached_observation_count++] = value;
}

int32_t scriptc_test_verify_retained(
    int32_t total,
    int32_t active_before,
    int32_t active_after,
    int32_t shutdown) {
  return total == 94 && active_before == 1 && active_after == 0 && shutdown == 1
      ? 94
      : 1;
}
