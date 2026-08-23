const LOOP_LIMIT = 50000;

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
