const LOOP_LIMIT = 50000;
const FRACTIONAL_GLOBAL = 0.5;
const OVERFLOW_GLOBAL = 2147483648;
let MUTABLE_GLOBAL = 1;

export function integerLoop(): number {
  let index = 0;
  let checksum = 0;
  while (index < LOOP_LIMIT) {
    checksum = checksum + (index & 1 ? 1 : 0);
    index = index + 1;
  }
  return checksum;
}

export function overflowingNumber(): number {
  let value = 2147483647;
  value = value + 1;
  return value;
}

export function fractionalNumber(): number {
  let value = 0.5;
  value = value + 1;
  return value;
}

export function negativeZeroNumber(): number {
  const value = -0;
  return 1 / value;
}

export function nonIntegerGlobals(): number {
  MUTABLE_GLOBAL = MUTABLE_GLOBAL + 1;
  return FRACTIONAL_GLOBAL + OVERFLOW_GLOBAL + MUTABLE_GLOBAL;
}
