/* JS-exact double → string.
 *
 * ECMA-262 §6.1.6.1.20 (Number::toString, radix 10) requires the shortest
 * digit string s (with digit count k and scale n, so that the value is
 * s * 10^(n-k)) that round-trips to the exact double — among equally short
 * candidates the closest, ties to even — then fixed placement for
 * -6 < n <= 21 and exponential notation otherwise.
 *
 * Digit generation is Ryū (vendored, see ../vendor/ryu/README.md): d2d()
 * computes exactly that shortest/closest/ties-even digit string with pure
 * integer arithmetic — no snprintf/strtod probing, no locale dependence.
 * The ECMA placement logic below is ours and unchanged; only the digit
 * source moved. Byte-exactness vs Node is pinned by the oracle case file
 * and the 1M-double fuzz gate (packages/runtime/test/gen-number-cases.mjs).
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* Ryū d2s core, textually included so the build's runtime source list is
 * unchanged. Provides d2d(), d2d_small_int(), decimalLength17(), div10(). */
#include "../vendor/ryu/d2s.c"

size_t scr_f64_to_str(double x, char *buf) {
  if (isnan(x)) return (size_t)(stpcpy(buf, "NaN") - buf);
  if (x == 0) return (size_t)(stpcpy(buf, "0") - buf); /* covers -0 */
  if (isinf(x)) {
    return (size_t)(stpcpy(buf, x < 0 ? "-Infinity" : "Infinity") - buf);
  }

  char *out = buf;
  if (x < 0) {
    *out++ = '-';
    x = -x;
  }

  /* Shortest round-tripping digits via Ryū. Mirrors d2s_buffered_n's
   * dispatch: the exact small-integer fast path first (trailing decimal
   * zeros folded into the exponent), the full algorithm otherwise. */
  uint64_t bits;
  memcpy(&bits, &x, sizeof bits);
  const uint64_t ieeeMantissa = bits & ((1ull << DOUBLE_MANTISSA_BITS) - 1);
  const uint32_t ieeeExponent =
      (uint32_t)(bits >> DOUBLE_MANTISSA_BITS); /* sign already stripped */
  floating_decimal_64 v;
  if (d2d_small_int(ieeeMantissa, ieeeExponent, &v)) {
    for (;;) {
      const uint64_t q = div10(v.mantissa);
      const uint32_t r = ((uint32_t)v.mantissa) - 10 * ((uint32_t)q);
      if (r != 0) break;
      v.mantissa = q;
      ++v.exponent;
    }
  } else {
    v = d2d(ieeeMantissa, ieeeExponent);
  }

  /* Ryū's (mantissa, exponent) → ECMA's (digits, k, n): the k mantissa
   * digits have no trailing zeros, and value = 0.digits * 10^n. */
  char digits[18];
  int k = (int)decimalLength17(v.mantissa);
  int n = v.exponent + k;
  digits[k] = '\0';
  uint64_t m = v.mantissa;
  for (int i = k - 1; i >= 0; i--) {
    const uint64_t q = div10(m);
    digits[i] = (char)('0' + (uint32_t)m - 10 * (uint32_t)q);
    m = q;
  }

  if (k <= n && n <= 21) {
    /* Integer: digits followed by n-k zeros. */
    memcpy(out, digits, (size_t)k);
    out += k;
    for (int i = 0; i < n - k; i++) *out++ = '0';
  } else if (0 < n && n <= 21) {
    /* ddd.ddd */
    memcpy(out, digits, (size_t)n);
    out += n;
    *out++ = '.';
    memcpy(out, digits + n, (size_t)(k - n));
    out += k - n;
  } else if (-6 < n && n <= 0) {
    /* 0.000ddd */
    *out++ = '0';
    *out++ = '.';
    for (int i = 0; i < -n; i++) *out++ = '0';
    memcpy(out, digits, (size_t)k);
    out += k;
  } else {
    /* d.ddde±e — exponent is n-1, printed without leading zeros. */
    *out++ = digits[0];
    if (k > 1) {
      *out++ = '.';
      memcpy(out, digits + 1, (size_t)(k - 1));
      out += k - 1;
    }
    *out++ = 'e';
    int e = n - 1;
    *out++ = e < 0 ? '-' : '+';
    if (e < 0) e = -e;
    char etmp[8];
    int elen = 0;
    do {
      etmp[elen++] = (char)('0' + e % 10);
      e /= 10;
    } while (e > 0);
    while (elen > 0) *out++ = etmp[--elen];
  }
  *out = '\0';
  return (size_t)(out - buf);
}
