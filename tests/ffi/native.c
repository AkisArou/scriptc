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

typedef double (*sf_apply_cb)(double value, void *context);

double sf_apply(sf_apply_cb callback, double value, void *context) {
  return callback(value, context);
}

typedef double (*sf_raw_cb)(double value);

double sf_combine_raw(sf_raw_cb left, sf_raw_cb right, double value) {
  return left(value) + right(value);
}

/* These valid external names deliberately overlap the emitter's preferred
 * callback-trampoline and raw-callback TLS names. */
double sc_ffi_cb_0(sf_raw_cb callback) {
  return callback(8);
}

double sc_ffi_cb_ctx_2(double value) {
  return value + 1;
}

typedef uint32_t (*sf_mix_cb)(uint8_t truth, uint8_t byte, uint32_t wide,
                              int32_t signed_value, double fraction,
                              void *context);

uint32_t sf_callback_mix(sf_mix_cb callback, void *context) {
  return callback(2, 255, 4000000000u, -7, 0.5, context);
}

typedef void (*sf_each_cb)(double value, void *context);

void sf_each(sf_each_cb callback, void *context) {
  callback(1, context);
  callback(2, context);
  callback(3, context);
}
