/* The arbitrary-precision integers, on their own: no string type, no
 * refcount audit, no compiler — just the arithmetic and the decimal form,
 * checked against values computed independently. */
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void scr_trap(const char *message) {
  fprintf(stderr, "%s", message);
  abort();
}

static void expect(const ScrBigInt *value, const char *text) {
  char buffer[512];
  size_t len = scr_bigint_format(value, buffer, sizeof buffer);
  if (len != strlen(text) || memcmp(buffer, text, len) != 0) {
    fprintf(stderr, "expected %s, got %.*s\n", text, (int)len, buffer);
    exit(1);
  }
}

static ScrBigInt *decimal(const char *text) {
  bool negative = text[0] == '-';
  const char *digits = negative ? text + 1 : text;
  return scr_bigint_from_decimal(digits, strlen(digits), negative);
}

int main(void) {
  ScrBigInt *zero = scr_bigint_from_i64(0);
  expect(zero, "0");
  assert(scr_bigint_is_zero(zero));

  ScrBigInt *one = scr_bigint_from_i64(1);
  ScrBigInt *minus = scr_bigint_from_i64(-42);
  expect(minus, "-42");

  /* The int64 minimum has no positive counterpart at its own width. */
  ScrBigInt *min64 = scr_bigint_from_i64(INT64_MIN);
  expect(min64, "-9223372036854775808");

  /* Beyond every fixed width, and beyond a double's integers. */
  ScrBigInt *big = decimal("123456789012345678901234567890");
  expect(big, "123456789012345678901234567890");

  ScrBigInt *sum = scr_bigint_add(big, one);
  expect(sum, "123456789012345678901234567891");

  ScrBigInt *product = scr_bigint_mul(big, big);
  expect(product, "15241578753238836750495351562536198787501905199875019052100");

  ScrBigInt *difference = scr_bigint_sub(big, big);
  expect(difference, "0");
  assert(scr_bigint_is_zero(difference));

  /* Sign handling across the operations. */
  ScrBigInt *mixed = scr_bigint_add(minus, one);
  expect(mixed, "-41");
  ScrBigInt *crossed = scr_bigint_sub(one, big);
  expect(crossed, "-123456789012345678901234567889");
  ScrBigInt *negated = scr_bigint_mul(minus, big);
  expect(negated, "-5185185138518518513851851851380");

  /* Comparison is by value, not by representation. */
  assert(scr_bigint_compare(one, big) < 0);
  assert(scr_bigint_compare(big, one) > 0);
  assert(scr_bigint_equals(big, big));
  assert(!scr_bigint_equals(one, minus));
  assert(scr_bigint_compare(minus, one) < 0);

  /* A leading-zero chunk keeps its zeros; a leading chunk drops them. */
  ScrBigInt *zeros = decimal("1000000000000000000");
  expect(zeros, "1000000000000000000");

  assert(scr_bigint_to_double(one) == 1.0);
  assert(scr_bigint_to_double(minus) == -42.0);

  /* ToNumber(bigint) rounds to nearest, ties to even, against the EXACT
   * value. 2^53+1 is the smallest integer a double cannot hold: it is a
   * tie, and the even neighbour wins. A limb-by-limb accumulation gets
   * the wide cases an ulp wrong, which is what these pin. */
  ScrBigInt *tie = decimal("9007199254740993");
  assert(scr_bigint_to_double(tie) == 9007199254740992.0);
  ScrBigInt *wide_value = decimal("123456789012345678901234567890");
  assert(scr_bigint_to_double(wide_value) == 1.2345678901234568e+29);
  ScrBigInt *wide_negative = decimal("-123456789012345678901234567890");
  assert(scr_bigint_to_double(wide_negative) == -1.2345678901234568e+29);

  /* The reverse crossing is exact or it refuses: an integral double has an
   * integer, a fraction does not. */
  ScrBigInt *from_int = scr_bigint_from_double(9007199254740992.0);
  expect(from_int, "9007199254740992");
  ScrBigInt *from_huge = scr_bigint_from_double(1e30);
  expect(from_huge, "1000000000000000019884624838656");
  ScrBigInt *from_neg = scr_bigint_from_double(-7.0);
  expect(from_neg, "-7");
  ScrBigInt *from_zero = scr_bigint_from_double(0.0);
  expect(from_zero, "0");
  assert(scr_bigint_from_double(1.5) == NULL);
  assert(scr_bigint_from_double(0.0 / 0.0) == NULL);
  assert(scr_bigint_from_double(1.0 / 0.0) == NULL);

  /* StringToBigInt: every radix, the sign rules, the Unicode trim, and the
   * empty string that is 0n rather than an error. */
  ScrBigInt *parsed_dec = scr_bigint_parse("  -1234  ", 9);
  expect(parsed_dec, "-1234");
  ScrBigInt *parsed_hex = scr_bigint_parse("0x1f", 4);
  expect(parsed_hex, "31");
  ScrBigInt *parsed_oct = scr_bigint_parse("0O17", 4);
  expect(parsed_oct, "15");
  ScrBigInt *parsed_bin = scr_bigint_parse("0b1011", 6);
  expect(parsed_bin, "11");
  ScrBigInt *parsed_plus = scr_bigint_parse("+5", 2);
  expect(parsed_plus, "5");
  ScrBigInt *parsed_empty = scr_bigint_parse("", 0);
  expect(parsed_empty, "0");
  ScrBigInt *parsed_blank = scr_bigint_parse("\xc2\xa0\t\n", 4); /* U+00A0 + ASCII */
  expect(parsed_blank, "0");
  ScrBigInt *parsed_nbsp = scr_bigint_parse("\xc2\xa0" "12" "\xef\xbb\xbf", 7); /* NBSP 12 BOM */
  expect(parsed_nbsp, "12");
  assert(scr_bigint_parse("abc", 3) == NULL);
  assert(scr_bigint_parse("-0x1f", 5) == NULL);   /* a radix prefix takes no sign */
  assert(scr_bigint_parse("1_0", 3) == NULL);     /* separators are literal syntax */
  assert(scr_bigint_parse("0x", 2) == NULL);      /* a prefix needs digits */
  assert(scr_bigint_parse("-", 1) == NULL);
  assert(scr_bigint_parse("0b2", 3) == NULL);     /* digit outside the radix */

  ScrBigInt *all[] = {zero, one, minus, min64, big, sum, product,
                      difference, mixed, crossed, negated, zeros,
                      tie, wide_value, wide_negative,
                      from_int, from_huge, from_neg, from_zero,
                      parsed_dec, parsed_hex, parsed_oct, parsed_bin,
                      parsed_plus, parsed_empty, parsed_blank, parsed_nbsp};
  for (size_t index = 0; index < sizeof all / sizeof *all; index += 1) {
    scr_bigint_release(all[index]);
  }
  printf("bigint: ok\n");
  return 0;
}
