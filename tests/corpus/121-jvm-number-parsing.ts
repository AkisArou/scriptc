export function numberPredicates(): number {
  let checksum = 0;
  const nan = 0 / 0;
  if (Number.isFinite(1.5)) checksum += 1;
  if (!Number.isFinite(1 / 0)) checksum += 2;
  if (Number.isNaN(nan)) checksum += 4;
  if (!Number.isNaN(1)) checksum += 8;
  if (Number.isInteger(-0)) checksum += 16;
  if (Number.isInteger(3) && !Number.isInteger(3.5)) checksum += 32;
  if (!Number.isInteger(1 / 0)) checksum += 64;
  if (Number.isSafeInteger(9_007_199_254_740_991)) checksum += 128;
  if (Number.isSafeInteger(-9_007_199_254_740_991)) checksum += 256;
  if (!Number.isSafeInteger(9_007_199_254_740_992)) checksum += 512;
  if (isNaN(nan) && !isNaN(1)) checksum += 1024;
  if (isFinite(-12.5) && !isFinite(-1 / 0)) checksum += 2048;
  return checksum;
}

export function numericSameValue(): number {
  let checksum = 0;
  if (Object.is(0 / 0, 0 / 0)) checksum += 1;
  if (!Object.is(0, -0)) checksum += 2;
  if (Object.is(-0, -0)) checksum += 4;
  if (Object.is(1, 1)) checksum += 8;
  if (!Object.is(1, 2)) checksum += 16;
  return checksum;
}

let predicateEvaluations = 0;

function nextPredicateNumber(value: number): number {
  predicateEvaluations += 1;
  return value;
}

export function predicateEvaluationOrder(): number {
  predicateEvaluations = 0;
  Number.isSafeInteger(nextPredicateNumber(3));
  Object.is(nextPredicateNumber(1), nextPredicateNumber(1));
  return predicateEvaluations;
}

export function parseIntegerEdges(): number {
  let checksum = 0;
  if (parseInt("\uFEFF\u3000-0x10tail") === -16) checksum += 1;
  if (parseInt("101xyz", 2) === 5) checksum += 2;
  if (parseInt("zz", 36) === 1295) checksum += 4;
  if (parseInt("11", 4_294_967_306) === 11) checksum += 8;
  if (Object.is(parseInt("-0"), -0)) checksum += 16;
  if (Number.isNaN(parseInt("ff", 37))) checksum += 32;
  if (parseInt("18446744073709551617") === 18_446_744_073_709_552_000) checksum += 64;
  if (
    parseInt(
      "11111111111111111111111111111111111111111111111111111111111111111111111111111111",
      35,
    ) === 9.861991661243382e121
  ) checksum += 128;
  if (Number.isNaN(parseInt("0x", 16))) checksum += 256;
  if (parseInt("0x10", 10) === 0) checksum += 512;
  return checksum;
}

export function parseFloatEdges(): number {
  let checksum = 0;
  if (parseFloat("\uFEFF -12.5e2tail") === -1250) checksum += 1;
  if (parseFloat("1e+oops") === 1) checksum += 2;
  if (parseFloat("Infinityrest") === 1 / 0) checksum += 4;
  if (parseFloat(".5x") === 0.5) checksum += 8;
  if (parseFloat("0x10") === 0) checksum += 16;
  if (Number.isNaN(parseFloat("not-a-number"))) checksum += 32;
  if (Object.is(parseFloat("-0tail"), -0)) checksum += 64;
  if (Number.isNaN(parseFloat("."))) checksum += 128;
  return checksum;
}

export function convertStringEdges(): number {
  let checksum = 0;
  if (Number(" \uFEFF\u3000 ") === 0) checksum += 1;
  if (Number("0b101") === 5) checksum += 2;
  if (Number("0o17") === 15) checksum += 4;
  if (Number("0x20") === 32) checksum += 8;
  if (Number.isNaN(Number("-0x10"))) checksum += 16;
  if (Number.isNaN(Number("12px"))) checksum += 32;
  if (Number("-12.5e2") === -1250) checksum += 64;
  if (Object.is(Number("-0"), -0)) checksum += 128;
  if (Number("+Infinity") === 1 / 0) checksum += 256;
  if (Number.isNaN(Number("0b2"))) checksum += 512;
  return checksum;
}

export function parsedInteger(value: string, radix: number): number {
  return parseInt(value, radix);
}

export function parsedFloat(value: string): number {
  return parseFloat(value);
}

export function convertedNumber(value: string): number {
  return Number(value);
}
