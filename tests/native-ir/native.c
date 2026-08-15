#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <string.h>

typedef struct NtsPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} NtsPadded;

typedef struct NtsCounter {
  int32_t value;
} NtsCounter;

typedef void (*NtsRetainedCallback)(int32_t value, void *context);

typedef struct NtsSubscription {
  pthread_mutex_t mutex;
  pthread_cond_t idle;
  NtsRetainedCallback callback;
  void *context;
  size_t active;
  bool closing;
} NtsSubscription;

typedef struct NtsForeignInvocation {
  NtsSubscription *subscription;
  int32_t value;
} NtsForeignInvocation;

static int32_t nts_counter_destroyed = 0;

int8_t nts_i8_identity(int8_t value) {
  return value;
}

uint8_t nts_u8_identity(uint8_t value) {
  return value;
}

int16_t nts_i16_identity(int16_t value) {
  return value;
}

uint16_t nts_u16_identity(uint16_t value) {
  return value;
}

int32_t nts_i32_identity(int32_t value) {
  return value;
}

uint32_t nts_u32_identity(uint32_t value) {
  return value;
}

int64_t nts_i64_identity(int64_t value) {
  return value;
}

uint64_t nts_u64_identity(uint64_t value) {
  return value;
}

size_t nts_usize_identity(size_t value) {
  return value;
}

int32_t nts_boolean_false(void) { return 0; }

int32_t nts_boolean_invalid(void) { return 2; }

int32_t nts_boolean_true(void) { return 1; }

NtsPadded nts_padded_roundtrip(NtsPadded value) {
  return value;
}

uint64_t nts_hash_utf8(const char *data, size_t length) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < length; index++) {
    hash ^= (uint8_t)data[index];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

void nts_c_string_observe(const char *data) {
  static bool saw_native;
  if (strcmp(data, "native") == 0) {
    saw_native = true;
    return;
  }
  if (saw_native && strcmp(data, "done") == 0) exit(42);
  abort();
}

uint64_t nts_hash_bytes(const uint8_t *data, size_t length) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t index = 0; index < length; index++) {
    hash ^= data[index];
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

typedef int32_t (*NtsCallCallback)(int32_t value, void *context);

int32_t nts_call_scoped(
    NtsCallCallback callback,
    void *context,
    int32_t value) {
  return callback(value, context);
}

int32_t nts_fail_errno(int32_t error_number) {
  errno = error_number;
  return -1;
}

NtsSubscription *nts_subscription_create(
    NtsRetainedCallback callback,
    void *context) {
  NtsSubscription *subscription = calloc(1, sizeof *subscription);
  if (subscription == NULL) return NULL;
  int result = pthread_mutex_init(&subscription->mutex, NULL);
  if (result != 0) {
    free(subscription);
    errno = result;
    return NULL;
  }
  result = pthread_cond_init(&subscription->idle, NULL);
  if (result != 0) {
    pthread_mutex_destroy(&subscription->mutex);
    free(subscription);
    errno = result;
    return NULL;
  }
  subscription->callback = callback;
  subscription->context = context;
  return subscription;
}

static bool nts_subscription_admit(NtsSubscription *subscription) {
  pthread_mutex_lock(&subscription->mutex);
  if (subscription->closing) {
    pthread_mutex_unlock(&subscription->mutex);
    return false;
  }
  subscription->active++;
  pthread_mutex_unlock(&subscription->mutex);
  return true;
}

static void nts_subscription_finish(NtsSubscription *subscription) {
  pthread_mutex_lock(&subscription->mutex);
  subscription->active--;
  if (subscription->closing && subscription->active == 0) {
    pthread_cond_signal(&subscription->idle);
  }
  pthread_mutex_unlock(&subscription->mutex);
}

int32_t nts_subscription_emit(NtsSubscription *subscription, int32_t value) {
  if (!nts_subscription_admit(subscription)) {
    errno = ECANCELED;
    return -1;
  }
  subscription->callback(value, subscription->context);
  nts_subscription_finish(subscription);
  return 0;
}

static void *nts_subscription_foreign_invoke(void *opaque) {
  NtsForeignInvocation *invocation = opaque;
  NtsSubscription *subscription = invocation->subscription;
  int32_t value = invocation->value;
  free(invocation);
  subscription->callback(value, subscription->context);
  nts_subscription_finish(subscription);
  return NULL;
}

int32_t nts_subscription_emit_foreign(
    NtsSubscription *subscription,
    int32_t value) {
  if (!nts_subscription_admit(subscription)) {
    errno = ECANCELED;
    return -1;
  }
  NtsForeignInvocation *invocation = malloc(sizeof *invocation);
  if (invocation == NULL) {
    nts_subscription_finish(subscription);
    errno = ENOMEM;
    return -1;
  }
  invocation->subscription = subscription;
  invocation->value = value;
  pthread_attr_t attributes;
  int result = pthread_attr_init(&attributes);
  if (result != 0) goto fail;
  result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  if (result != 0) {
    pthread_attr_destroy(&attributes);
    goto fail;
  }
  pthread_t thread;
  result = pthread_create(
      &thread, &attributes, nts_subscription_foreign_invoke, invocation);
  pthread_attr_destroy(&attributes);
  if (result != 0) goto fail;
  return 0;

fail:
  free(invocation);
  nts_subscription_finish(subscription);
  errno = result;
  return -1;
}

void nts_subscription_destroy(NtsSubscription *subscription) {
  if (subscription == NULL) return;
  pthread_mutex_lock(&subscription->mutex);
  subscription->closing = true;
  while (subscription->active != 0) {
    pthread_cond_wait(&subscription->idle, &subscription->mutex);
  }
  pthread_mutex_unlock(&subscription->mutex);
  pthread_cond_destroy(&subscription->idle);
  pthread_mutex_destroy(&subscription->mutex);
  free(subscription);
}

NtsCounter *nts_counter_create(int32_t initial_value) {
  NtsCounter *counter = malloc(sizeof *counter);
  if (!counter) return NULL;
  counter->value = initial_value;
  return counter;
}

int32_t nts_counter_add(NtsCounter *counter, int32_t delta) {
  counter->value += delta;
  return counter->value;
}

int32_t nts_counter_value(NtsCounter *counter) { return counter->value; }

const char *nts_counter_label(NtsCounter *counter) {
  return counter->value == 42 ? "native \xE2\x9C\x93" : NULL;
}

const char *nts_counter_required_label(NtsCounter *counter) {
  return nts_counter_label(counter);
}

void nts_counter_destroy(NtsCounter *counter) {
  nts_counter_destroyed++;
  free(counter);
}

int32_t nts_counter_destroyed_count(void) { return nts_counter_destroyed; }

int32_t nts_counter_verify(int32_t actual_value, int32_t actual_destroyed,
                           int32_t expected_value, int32_t expected_destroyed) {
  return actual_value == expected_value && actual_destroyed == expected_destroyed
      ? 42 : 1;
}
