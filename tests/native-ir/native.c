#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

typedef struct NtsPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} NtsPadded;

typedef struct NtsCounter {
  int32_t value;
} NtsCounter;

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
