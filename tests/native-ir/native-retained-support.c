#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>

#include "../../packages/runtime/src/scr_runtime.h"

static pthread_mutex_t callback_wake_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t callback_wake_condition = PTHREAD_COND_INITIALIZER;
static _Atomic int32_t callback_wakes;

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

int32_t scriptc_test_callbacks_wait_and_drain(int32_t expected_wakes) {
  pthread_mutex_lock(&callback_wake_mutex);
  while (atomic_load_explicit(&callback_wakes, memory_order_acquire) <
         expected_wakes) {
    pthread_cond_wait(&callback_wake_condition, &callback_wake_mutex);
  }
  pthread_mutex_unlock(&callback_wake_mutex);
  return (int32_t)scr_retained_callbacks_drain(0);
}

int32_t scriptc_test_callbacks_active(void) {
  return (int32_t)scr_retained_callbacks_active();
}

int32_t scriptc_test_callbacks_shutdown(void) {
  return scr_retained_callbacks_shutdown(true) ? 1 : 0;
}

int32_t scriptc_test_verify_retained(
    int32_t total,
    int32_t active_before,
    int32_t active_after,
    int32_t shutdown) {
  return total == 42 && active_before == 1 && active_after == 0 && shutdown == 1
      ? 42
      : 1;
}
