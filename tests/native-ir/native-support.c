#include <stdint.h>
#include <errno.h>

typedef struct ScriptcTestPadded {
  uint8_t tag;
  uint64_t value;
  double ratio;
} ScriptcTestPadded;

intptr_t scriptc_test_isize_identity(intptr_t value) {
  return value;
}

int32_t scriptc_test_verify_exact_integers(
    int8_t signed8,
    uint8_t unsigned8,
    int16_t signed16,
    uint16_t unsigned16,
    int32_t signed32,
    uint32_t unsigned32,
    int64_t signed64,
    uint64_t unsigned64,
    intptr_t signedSize,
    uintptr_t unsignedSize) {
  return signed8 == INT8_MIN &&
                 unsigned8 == UINT8_MAX &&
                 signed16 == INT16_MIN &&
                 unsigned16 == UINT16_MAX &&
                 signed32 == INT32_MIN &&
                 unsigned32 == UINT32_MAX &&
                 signed64 == INT64_MIN &&
                 unsigned64 == UINT64_MAX &&
                 signedSize == INTPTR_MIN &&
                 unsignedSize == UINTPTR_MAX
             ? 42
             : 1;
}

int32_t scriptc_test_verify_padded(
    ScriptcTestPadded value,
    uint8_t tag,
    uint64_t scalarValue,
    double ratio) {
  return value.tag == UINT8_C(7) &&
                 value.value == UINT64_C(4277009102) &&
                 value.ratio == 0.5 &&
                 tag == value.tag &&
                 scalarValue == value.value &&
                 ratio == value.ratio
             ? 42
             : 1;
}

int32_t scriptc_test_verify_utf8_hash(uint64_t actual) {
  return actual == UINT64_C(4742834144205301894) ? 42 : 1;
}

int32_t scriptc_test_verify_bytes_hash(uint64_t actual) {
  return actual == UINT64_C(4742834144205301894) ? 42 : 1;
}

int32_t scriptc_test_verify_call_scoped(int32_t forwarded, int32_t captured) {
  return forwarded == 42 && captured == 42 ? 42 : 1;
}

typedef int32_t (*ScriptcTestCallback)(int32_t value, void *context);

int32_t scriptc_test_callback_errno(
    ScriptcTestCallback callback,
    void *context,
    int32_t value) {
  (void)callback(value, context);
  errno = EINVAL;
  return -1;
}
