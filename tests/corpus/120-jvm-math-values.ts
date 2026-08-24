export function mathTransforms(value: number): number {
  return Math.floor(value) +
    Math.ceil(value) +
    Math.trunc(-value) +
    Math.round(value) +
    Math.abs(-value);
}

export function mathEdges(): number {
  let checksum = 0;
  if (Math.round(0.49999999999999994) === 0) checksum += 1;
  if (Math.round(-1.5) === -1) checksum += 2;
  if (1 / Math.round(-0.1) < 0) checksum += 4;
  if (1 / Math.min(0, -0) < 0) checksum += 8;
  if (1 / Math.max(-0, 0) > 0) checksum += 16;
  const nan = 0 / 0;
  if (Math.min(nan, 1) !== Math.min(nan, 1)) checksum += 32;
  if (Math.max(1, nan) !== Math.max(1, nan)) checksum += 64;
  if (1 / Math.trunc(-0.1) < 0) checksum += 128;
  if (1 / Math.ceil(-0.1) < 0) checksum += 256;
  if (1 / Math.abs(-0) > 0) checksum += 512;
  return checksum;
}

export function extremaArity(): number {
  const empty: number[] = [];
  let checksum = 0;
  if (Math.max() === -1 / 0) checksum += 1;
  if (Math.min() === 1 / 0) checksum += 2;
  if (Math.max(7) === 7) checksum += 4;
  if (Math.min(-7) === -7) checksum += 8;
  if (Math.max(...empty) === -1 / 0) checksum += 16;
  if (Math.min(...empty) === 1 / 0) checksum += 32;
  return checksum;
}

export function spreadExtrema(): number {
  const values = [4, -3, 9, -0, 0];
  return Math.max(...values) * 100 + Math.min(...values);
}

let mathEvaluationOrder = 0;

function markMath(value: number): number {
  mathEvaluationOrder = mathEvaluationOrder * 10 + value;
  return value;
}

export function variadicMathOrder(): number {
  mathEvaluationOrder = 0;
  const maximum = Math.max(markMath(1), markMath(2), markMath(3));
  return mathEvaluationOrder * 10 + maximum;
}

export function randomInvariant(draws: number): number {
  let accepted = 0;
  let index = 0;
  while (index < draws) {
    const value = Math.random();
    const scaled = value * 9_007_199_254_740_992;
    if (
      value >= 0 &&
      value < 1 &&
      Math.floor(value) === 0 &&
      scaled === Math.floor(scaled)
    ) {
      accepted += 1;
    }
    index += 1;
  }
  return accepted;
}
