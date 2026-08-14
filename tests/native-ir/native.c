#include <stdint.h>
#include <stddef.h>

typedef struct NtsPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} NtsPadded;

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
