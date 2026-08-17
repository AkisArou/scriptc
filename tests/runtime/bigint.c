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

  ScrBigInt *all[] = {zero, one, minus, min64, big, sum, product,
                      difference, mixed, crossed, negated, zeros};
  for (size_t index = 0; index < sizeof all / sizeof *all; index += 1) {
    scr_bigint_release(all[index]);
  }
  printf("bigint: ok\n");
  return 0;
}
