#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

typedef struct NtsPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} NtsPadded;

typedef struct NtsPair32 {
  int32_t first;
  int32_t second;
} NtsPair32;

/* The answer-as-a-field shape: a call that fills storage and separately says
 * whether it managed to. It is what a C predicate with an out-parameter looks
 * like once the out-parameter has become a field of the result, and the two
 * fields are read differently — one as a truth test, one as a number — from
 * the same pair of int32 slots. */
typedef struct NtsAnswered {
  int32_t answered;
  int32_t value;
} NtsAnswered;

typedef struct NtsPairF64 {
  double first;
  double second;
} NtsPairF64;

typedef struct NtsNestedPair32 {
  NtsPair32 left;
  NtsPair32 right;
  int64_t marker;
} NtsNestedPair32;

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

/* The same identity under a second symbol. One C symbol carries one binding,
 * so reading a 64-bit slot as a number while another binding reads it exactly
 * needs an entry point of its own. */
int64_t nts_i64_passthrough(int64_t value) {
  return value;
}

uint64_t nts_u64_identity(uint64_t value) {
  return value;
}

size_t nts_usize_identity(size_t value) {
  return value;
}

double nts_f64_identity(double value) {
  return value;
}

float nts_f32_identity(float value) {
  return value;
}

int32_t nts_boolean_false(void) { return 0; }

int32_t nts_boolean_invalid(void) { return 2; }

int32_t nts_boolean_not(int32_t value) {
  if (value != 0 && value != 1) abort();
  return value == 0 ? 1 : 0;
}

int32_t nts_boolean_true(void) { return 1; }

NtsPadded nts_padded_roundtrip(NtsPadded value) {
  return value;
}

NtsPair32 nts_pair32_transform(NtsPair32 value) {
  if (value.first != 40 || value.second != 2) abort();
  NtsPair32 result = { value.second, value.first + 2 };
  return result;
}

/* Reads a NUL-terminated vector the caller built for this call and nothing
 * else. Summing the lengths makes the answer depend on every element, and
 * counting to the terminator makes a missing one visible rather than silently
 * short — the two ways a borrowed vector goes wrong. */
int32_t nts_cstring_array_measure(const char **items) {
  int32_t total = 0;
  int32_t count = 0;
  for (size_t i = 0; items[i] != NULL; i++) {
    total += (int32_t)strlen(items[i]);
    count += 1;
  }
  return total * 100 + count;
}

/* The same measurement with a plain string BESIDE the vector, so a program
 * can put a throwing conversion after a successful borrow. That ordering is
 * the one where a vector could be stranded: the release below the call is
 * never reached, and nothing else knows the allocation exists. */
int32_t nts_cstring_array_measure_named(const char **items, const char *name) {
  return nts_cstring_array_measure(items) + (int32_t)strlen(name);
}


/* A vector the CALLER frees, built fresh each call. `count` picks the length
 * so a program can ask for an empty one, and a negative count answers NULL —
 * the absent vector, which is a different thing from an empty one. */
char **nts_cstring_array_made(int32_t count) {
  if (count < 0) return NULL;
  char **slots = calloc((size_t)count + 1, sizeof *slots);
  for (int32_t i = 0; i < count; i++) {
    slots[i] = malloc(4);
    snprintf(slots[i], 4, "s%d", i % 10);
  }
  slots[count] = NULL;
  return slots;
}

/* The disposal the binding names for the vector above. Frees the elements as
 * well as the vector, which is the shape GIR calls `full` — and the reason
 * the compiler takes a SYMBOL rather than a policy: a `container` transfer
 * would name a function that frees only the vector, and nothing else about
 * the projection would change. */
void nts_cstring_array_free(void *vector) {
  char **slots = vector;
  for (size_t i = 0; slots[i] != NULL; i++) free(slots[i]);
  free(slots);
}

/* Answers whether `value` is above `threshold`, and hands back the value it
 * looked at either way — the distinction that makes this shape worth having,
 * since a call that reported absence instead would discard a usable value. */
NtsAnswered nts_answered_above(int32_t value, int32_t threshold) {
  NtsAnswered result = { value > threshold, value };
  return result;
}

/* Reads one back, so the round trip is exercised in both directions: the
 * program constructs an NtsAnswered from a TypeScript boolean and this
 * reports what actually landed in the slot. */
int32_t nts_answered_raw(NtsAnswered value) {
  return value.answered;
}

NtsPairF64 nts_pair_f64_transform(NtsPairF64 value) {
  if (value.first != 1.5 || value.second != 2.5) abort();
  NtsPairF64 result = { 7.5, 42.0 };
  return result;
}

int32_t nts_pair_f64_verify(NtsPairF64 value) {
  return value.first == 7.5 && value.second == 42.0 ? 42 : 1;
}

NtsNestedPair32 nts_nested_pair32_transform(NtsNestedPair32 value) {
  if (value.left.first != 40 || value.left.second != 2 ||
      value.right.first != 3 || value.right.second != 4 || value.marker != 9) {
    abort();
  }
  NtsNestedPair32 result = {
    value.right,
    {value.left.second, value.left.first + 2},
    value.marker + 1,
  };
  return result;
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

int32_t nts_nullable_c_string_observe(const char *data) {
  if (data == NULL) return 1;
  if (strcmp(data, "native") == 0) return 2;
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

/* A call-scoped callback whose payload is a 32-bit float: the trampoline
 * widens it to a double on the way in, and every float is a double, so the
 * handler sees the value the caller stored exactly. */
typedef int32_t (*NtsCallFloatCallback)(float value, void *context);

int32_t nts_call_scoped_f32(
    NtsCallFloatCallback callback,
    void *context,
    float value) {
  return callback(value, context);
}

/* A retained callback the emitter ASKS rather than tells. It is registered
 * once, invoked on the caller's thread, and the value it answers with is the
 * value the emitter returns — the shape an event handler has when its
 * integer result says whether it consumed the event. Nothing here is
 * queued: the answer has to exist before the emitting call returns. */
typedef int32_t (*NtsAskCallback)(int32_t value, void *context);

typedef struct NtsAsker {
  NtsAskCallback callback;
  void *context;
  int32_t asked;
} NtsAsker;

NtsAsker *nts_asker_create(NtsAskCallback callback, void *context) {
  NtsAsker *asker = calloc(1, sizeof *asker);
  if (asker == NULL) return NULL;
  asker->callback = callback;
  asker->context = context;
  return asker;
}

int32_t nts_asker_ask(NtsAsker *asker, int32_t value) {
  asker->asked++;
  return asker->callback(value, asker->context);
}

int32_t nts_asker_asked(NtsAsker *asker) {
  return asker->asked;
}

void nts_asker_destroy(NtsAsker *asker) {
  free(asker);
}

/* The same registration reached through its own entry points, because two
 * bindings cannot share one C symbol and the boolean flavor is a second
 * binding over the same storage. */
NtsAsker *nts_answerer_create(NtsAskCallback callback, void *context) {
  return nts_asker_create(callback, context);
}

void nts_answerer_destroy(NtsAsker *asker) {
  nts_asker_destroy(asker);
}

int32_t nts_fail_errno(int32_t error_number) {
  errno = error_number;
  return -1;
}

/* An opaque error object returned instead of raised, the shape a C error
 * object takes once a generated adapter has absorbed its out-parameter. NULL is
 * success. The live counter proves the runtime releases it exactly once,
 * including when an exception is already pending. */
typedef struct NtsFixtureError {
  char *message;
} NtsFixtureError;

static int32_t nts_fixture_errors_live;

NtsFixtureError *nts_error_handle_fail(int32_t code) {
  if (code == 0) return NULL;
  NtsFixtureError *error = malloc(sizeof *error);
  if (error == NULL) abort();
  static const char prefix[] = "fixture failure ";
  size_t capacity = sizeof prefix + 16;
  error->message = malloc(capacity);
  if (error->message == NULL) abort();
  snprintf(error->message, capacity, "%s%d", prefix, (int)code);
  nts_fixture_errors_live += 1;
  return error;
}

/* The shape a failable C API actually has, and the one an absorbing adapter
 * cannot serve: the error arrives in a trailing out-parameter, so the result
 * is free to carry something the caller wants. GIO is built from this — 289 of
 * the 481 failable callables across GTK, Gio and GLib return a real value.
 *
 * On failure the result is deliberately a value that would be WRONG to use,
 * so a test that forgets to unwind reads it and says so. */
int32_t nts_error_out_divide(int32_t numerator, int32_t divisor,
                             NtsFixtureError **error) {
  if (divisor == 0) {
    *error = nts_error_handle_fail(numerator);
    return -12345;
  }
  return numerator / divisor;
}

const char *nts_fixture_error_message(NtsFixtureError *error) {
  return error->message;
}

void nts_fixture_error_free(NtsFixtureError *error) {
  nts_fixture_errors_live -= 1;
  free(error->message);
  free(error);
}

int32_t nts_fixture_errors_outstanding(void) {
  return nts_fixture_errors_live;
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

NtsCounter *nts_counter_create_with_initial_value(int32_t initial_value) {
  return nts_counter_create(initial_value);
}

NtsCounter *nts_counter_create_static(int32_t initial_value) {
  return nts_counter_create(initial_value);
}

int32_t nts_counter_add(NtsCounter *counter, int32_t delta) {
  counter->value += delta;
  return counter->value;
}

int32_t nts_counter_value(NtsCounter *counter) { return counter->value; }

const char *nts_counter_label(NtsCounter *counter) {
  return counter->value == 42 ? "native \xE2\x9C\x93" : NULL;
}

/* A vector the RECEIVER owns: static storage reached through the counter, so
 * the caller borrows it and frees nothing. This is the transfer-none shape,
 * and it is a method rather than a free function because that is the only
 * shape it takes in practice — a borrowed pointer needs something whose
 * lifetime bounds it, and for every such member in Gtk-4.0 that is the
 * receiver. */
static const char *const nts_counter_tag_vector[] = {"alpha", "beta", "gamma", NULL};

const char *const *nts_counter_tags(NtsCounter *counter) {
  (void)counter;
  return nts_counter_tag_vector;
}

const char *nts_counter_required_label(NtsCounter *counter) {
  return nts_counter_label(counter);
}

void nts_counter_destroy(NtsCounter *counter);

/* A vault that takes ownership of the counter handed to it, the shape
 * `gtk_widget_add_controller` has: the argument's reference moves to the
 * callee, which frees it in its own time. The counter stays readable through
 * the vault, so a test can prove the object survived the transfer. */
typedef struct NtsVault {
  NtsCounter *counter;
} NtsVault;

NtsVault *nts_vault_create(void) {
  return calloc(1, sizeof(NtsVault));
}

void nts_vault_adopt(NtsVault *vault, NtsCounter *counter) {
  if (vault->counter != NULL) nts_counter_destroy(vault->counter);
  vault->counter = counter;
}

int32_t nts_vault_value(NtsVault *vault) {
  return vault->counter == NULL ? -1 : vault->counter->value;
}

void nts_vault_destroy(NtsVault *vault) {
  if (vault->counter != NULL) nts_counter_destroy(vault->counter);
  free(vault);
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

/* Accepts an optional counter: null is a valid argument, not a failure. */
int32_t nts_counter_value_or(NtsCounter *counter, int32_t fallback) {
  return counter == NULL ? fallback : nts_counter_value(counter);
}

/* The same, declared over the base of the handle hierarchy: an argument two
 * identity upcasts below it has to widen on its way into the optional slot. */
int32_t nts_counter_base_value_or(NtsCounter *counter, int32_t fallback) {
  return counter == NULL ? fallback : nts_counter_value(counter);
}
