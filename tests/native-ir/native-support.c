#include <stdint.h>

int32_t scriptc_test_verify_exact_integers(
    int8_t signed8,
    uint8_t unsigned8,
    int16_t signed16,
    uint16_t unsigned16,
    int32_t signed32,
    uint32_t unsigned32,
    int64_t signed64,
    uint64_t unsigned64) {
  return signed8 == INT8_MIN &&
                 unsigned8 == UINT8_MAX &&
                 signed16 == INT16_MIN &&
                 unsigned16 == UINT16_MAX &&
                 signed32 == INT32_MIN &&
                 unsigned32 == UINT32_MAX &&
                 signed64 == INT64_MIN &&
                 unsigned64 == UINT64_MAX
             ? 42
             : 1;
}
