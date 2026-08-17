/* Arbitrary-precision integers: the representation behind JavaScript's
 * `bigint`.
 *
 * Sign and magnitude, base 2^32, little-endian, always normalized — no
 * leading zero limb, and zero is the unique value with no limbs and no sign.
 * Normalization is what makes comparison and equality structural: two values
 * are equal exactly when their signs and limbs are, so nothing has to
 * canonicalize before a test.
 *
 * Limbs are 32 bits rather than 64 so every intermediate fits a `uint64_t`
 * without a 128-bit type the C standard does not promise. The cost is twice
 * the iterations on a machine that could do it in one; the benefit is that
 * the same code is correct on every target this compiles for.
 *
 * Values are immutable once returned. Every operation allocates its result,
 * which is what lets a caller hold one without copying and what makes the
 * refcount the whole ownership story.
 */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

/* Allocation failure is a trap rather than a return: every operation here
 * answers with a value, and there is no partial answer to hand back. */
static void scr_bigint_oom(void) { scr_trap("scriptc: out of memory\n"); }

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_bigints = 0;
long scr_bigint_live_count(void) { return scr_live_bigints; }
#endif

/* One digit chunk per decimal conversion step: 10^9 is the largest power of
 * ten a uint32_t limb divisor can carry without overflowing the 64-bit
 * intermediate that divides by it. */
#define SCR_BIGINT_DECIMAL_CHUNK 1000000000u
#define SCR_BIGINT_DECIMAL_DIGITS 9

static ScrBigInt *scr_bigint_alloc(size_t limbs) {
  ScrBigInt *value = malloc(sizeof(ScrBigInt) + limbs * sizeof(uint32_t));
  if (!value) scr_bigint_oom();
  value->rc = 1;
  value->len = limbs;
  value->negative = false;
#ifdef SCR_RC_AUDIT
  scr_live_bigints++;
#endif
  return value;
}

/* Drops leading zero limbs and clears the sign of zero, so every value that
 * leaves this file is in the one form the comparisons assume. */
static ScrBigInt *scr_bigint_normalize(ScrBigInt *value) {
  while (value->len > 0 && value->limbs[value->len - 1] == 0) value->len -= 1;
  if (value->len == 0) value->negative = false;
  return value;
}

ScrBigInt *scr_bigint_retain(ScrBigInt *value) {
  if (value) value->rc += 1;
  return value;
}

void scr_bigint_release(ScrBigInt *value) {
  if (!value || value->rc == SIZE_MAX) return; /* an uninitialized `let` */
  if (--value->rc == 0) {
#ifdef SCR_RC_AUDIT
    scr_live_bigints--;
#endif
    free(value);
  }
}

ScrBigInt *scr_bigint_from_u64(uint64_t magnitude, bool negative) {
  ScrBigInt *value = scr_bigint_alloc(2);
  value->limbs[0] = (uint32_t)(magnitude & 0xFFFFFFFFu);
  value->limbs[1] = (uint32_t)(magnitude >> 32);
  value->negative = negative;
  return scr_bigint_normalize(value);
}

ScrBigInt *scr_bigint_from_i64(int64_t value) {
  /* Negating the minimum has no answer in int64_t, so the magnitude is taken
   * in the unsigned domain where it does. */
  uint64_t magnitude = value < 0
      ? (uint64_t)0 - (uint64_t)value
      : (uint64_t)value;
  return scr_bigint_from_u64(magnitude, value < 0);
}

bool scr_bigint_is_zero(const ScrBigInt *value) { return value->len == 0; }

/* Compares magnitudes only: -1, 0, or 1 for |a| against |b|. */
static int scr_bigint_compare_magnitude(const ScrBigInt *a, const ScrBigInt *b) {
  if (a->len != b->len) return a->len < b->len ? -1 : 1;
  for (size_t index = a->len; index > 0; index -= 1) {
    uint32_t left = a->limbs[index - 1], right = b->limbs[index - 1];
    if (left != right) return left < right ? -1 : 1;
  }
  return 0;
}

int scr_bigint_compare(const ScrBigInt *a, const ScrBigInt *b) {
  if (a->negative != b->negative) return a->negative ? -1 : 1;
  int magnitude = scr_bigint_compare_magnitude(a, b);
  return a->negative ? -magnitude : magnitude;
}

bool scr_bigint_equals(const ScrBigInt *a, const ScrBigInt *b) {
  return scr_bigint_compare(a, b) == 0;
}

/* |a| + |b|, sign supplied by the caller. */
static ScrBigInt *scr_bigint_add_magnitude(
    const ScrBigInt *a, const ScrBigInt *b, bool negative) {
  size_t longer = a->len > b->len ? a->len : b->len;
  ScrBigInt *result = scr_bigint_alloc(longer + 1);
  uint64_t carry = 0;
  for (size_t index = 0; index < longer; index += 1) {
    uint64_t sum = carry;
    if (index < a->len) sum += a->limbs[index];
    if (index < b->len) sum += b->limbs[index];
    result->limbs[index] = (uint32_t)(sum & 0xFFFFFFFFu);
    carry = sum >> 32;
  }
  result->limbs[longer] = (uint32_t)carry;
  result->negative = negative;
  return scr_bigint_normalize(result);
}

/* |a| - |b|, which the caller must have checked is not negative. */
static ScrBigInt *scr_bigint_sub_magnitude(
    const ScrBigInt *a, const ScrBigInt *b, bool negative) {
  ScrBigInt *result = scr_bigint_alloc(a->len);
  int64_t borrow = 0;
  for (size_t index = 0; index < a->len; index += 1) {
    int64_t difference = (int64_t)a->limbs[index] - borrow -
        (index < b->len ? (int64_t)b->limbs[index] : 0);
    if (difference < 0) {
      difference += (int64_t)1 << 32;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result->limbs[index] = (uint32_t)difference;
  }
  result->negative = negative;
  return scr_bigint_normalize(result);
}

ScrBigInt *scr_bigint_add(const ScrBigInt *a, const ScrBigInt *b) {
  if (a->negative == b->negative) {
    return scr_bigint_add_magnitude(a, b, a->negative);
  }
  int magnitude = scr_bigint_compare_magnitude(a, b);
  if (magnitude == 0) return scr_bigint_alloc(0);
  return magnitude > 0
      ? scr_bigint_sub_magnitude(a, b, a->negative)
      : scr_bigint_sub_magnitude(b, a, b->negative);
}

ScrBigInt *scr_bigint_negate(const ScrBigInt *value) {
  ScrBigInt *result = scr_bigint_alloc(value->len);
  memcpy(result->limbs, value->limbs, value->len * sizeof(uint32_t));
  result->negative = value->len == 0 ? false : !value->negative;
  return result;
}

ScrBigInt *scr_bigint_sub(const ScrBigInt *a, const ScrBigInt *b) {
  ScrBigInt *negated = scr_bigint_negate(b);
  ScrBigInt *result = scr_bigint_add(a, negated);
  scr_bigint_release(negated);
  return result;
}

ScrBigInt *scr_bigint_mul(const ScrBigInt *a, const ScrBigInt *b) {
  if (a->len == 0 || b->len == 0) return scr_bigint_alloc(0);
  ScrBigInt *result = scr_bigint_alloc(a->len + b->len);
  memset(result->limbs, 0, (a->len + b->len) * sizeof(uint32_t));
  for (size_t i = 0; i < a->len; i += 1) {
    uint64_t carry = 0;
    for (size_t j = 0; j < b->len; j += 1) {
      uint64_t product = (uint64_t)a->limbs[i] * b->limbs[j] +
          result->limbs[i + j] + carry;
      result->limbs[i + j] = (uint32_t)(product & 0xFFFFFFFFu);
      carry = product >> 32;
    }
    result->limbs[i + b->len] = (uint32_t)carry;
  }
  result->negative = a->negative != b->negative;
  return scr_bigint_normalize(result);
}

/* Divides the magnitude in place by a single limb, returning the remainder.
 * Only the decimal conversions need division so far, and they need exactly
 * this shape. */
static uint32_t scr_bigint_divmod_small(ScrBigInt *value, uint32_t divisor) {
  uint64_t remainder = 0;
  for (size_t index = value->len; index > 0; index -= 1) {
    uint64_t current = (remainder << 32) | value->limbs[index - 1];
    value->limbs[index - 1] = (uint32_t)(current / divisor);
    remainder = current % divisor;
  }
  scr_bigint_normalize(value);
  return (uint32_t)remainder;
}

static ScrBigInt *scr_bigint_copy(const ScrBigInt *value) {
  ScrBigInt *result = scr_bigint_alloc(value->len);
  memcpy(result->limbs, value->limbs, value->len * sizeof(uint32_t));
  result->negative = value->negative;
  return result;
}

size_t scr_bigint_format_capacity(const ScrBigInt *value) {
  /* Each limb contributes at most ceil(32 / log2(10)) < 10 digits, so ten per
   * limb plus the sign is always enough — an upper bound rather than a count,
   * which is all a caller sizing a buffer needs. */
  return value->len * 10 + 2;
}

size_t scr_bigint_format(const ScrBigInt *value, char *buffer, size_t capacity) {
  if (capacity < scr_bigint_format_capacity(value)) return 0;
  if (value->len == 0) {
    buffer[0] = '0';
    return 1;
  }
  size_t cursor = capacity;
  ScrBigInt *scratch = scr_bigint_copy(value);
  while (scratch->len > 0) {
    uint32_t chunk = scr_bigint_divmod_small(scratch, SCR_BIGINT_DECIMAL_CHUNK);
    for (int digit = 0; digit < SCR_BIGINT_DECIMAL_DIGITS; digit += 1) {
      buffer[--cursor] = (char)('0' + (chunk % 10));
      chunk /= 10;
      /* The most significant chunk stops at its own first digit so the number
       * carries no leading zeros; every other chunk writes all nine, because
       * its zeros are significant. */
      if (scratch->len == 0 && chunk == 0) break;
    }
  }
  scr_bigint_release(scratch);
  if (value->negative) buffer[--cursor] = '-';
  size_t len = capacity - cursor;
  memmove(buffer, buffer + cursor, len);
  return len;
}

ScrBigInt *scr_bigint_from_decimal(
    const char *digits, size_t len, bool negative) {
  ScrBigInt *value = scr_bigint_alloc(0);
  size_t cursor = 0;
  while (cursor < len) {
    size_t take = len - cursor < SCR_BIGINT_DECIMAL_DIGITS
        ? len - cursor
        : (size_t)SCR_BIGINT_DECIMAL_DIGITS;
    uint32_t chunk = 0;
    uint32_t scale = 1;
    for (size_t index = 0; index < take; index += 1) {
      chunk = chunk * 10 + (uint32_t)(digits[cursor + index] - '0');
      scale *= 10;
    }
    ScrBigInt *multiplier = scr_bigint_from_u64(scale, false);
    ScrBigInt *shifted = scr_bigint_mul(value, multiplier);
    ScrBigInt *addend = scr_bigint_from_u64(chunk, false);
    ScrBigInt *sum = scr_bigint_add(shifted, addend);
    scr_bigint_release(multiplier);
    scr_bigint_release(shifted);
    scr_bigint_release(addend);
    scr_bigint_release(value);
    value = sum;
    cursor += take;
  }
  value->negative = negative && value->len != 0;
  return value;
}

double scr_bigint_to_double(const ScrBigInt *value) {
  /* Accumulating from the most significant limb down rounds once per step
   * rather than once at the end, which is what a caller reading an
   * approximate magnitude expects; an exact answer is the conversion's
   * caller's business, not this function's. */
  double result = 0.0;
  for (size_t index = value->len; index > 0; index -= 1) {
    result = result * 4294967296.0 + (double)value->limbs[index - 1];
  }
  return value->negative ? -result : result;
}
