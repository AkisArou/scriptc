#include <stddef.h>
#include <stdint.h>

static double last_note;

double sf_scale(double value) {
  return value * 2.0;
}

uint8_t sf_invert(uint8_t value) {
  return value ? 0 : 1;
}

uint8_t sf_u8(uint8_t value) {
  return value;
}

uint32_t sf_u32(uint32_t value) {
  return value;
}

int32_t sf_i32(int32_t value) {
  return value;
}

double sf_text_sum(const uint8_t *data, size_t len) {
  double sum = 0;
  for (size_t i = 0; i < len; i++) sum += data[i];
  return sum;
}

double sf_bytes_sum(const uint8_t *data, size_t len) {
  double sum = 0;
  for (size_t i = 0; i < len; i++) sum += data[i];
  return sum;
}

void sf_note(double value) {
  last_note = value;
}

double sf_last_note(void) {
  return last_note;
}
