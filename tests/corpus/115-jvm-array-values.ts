export function mutateNumbers(seed: number): number {
  const values = [seed, 2, 3];
  const length = values.push(4, 5);
  values[1] = 7;
  return length + values[0] + values[1] + values[4];
}

export function findString(needle: string): number {
  const values = ["alpha", "same", "omega"];
  return values.indexOf(needle) + (values.includes(needle) ? 10 : 0);
}

export function mutateBooleans(seed: boolean): boolean {
  const values = [false, seed];
  values.push(true);
  values[0] = true;
  return values.length === 3 && values[0] && values[1] && values.pop();
}

export function arrayPipeline(seed: number): number {
  const values = [seed, 2, 3, 4];
  const transformed = values
    .map((value, index) => value * 2 + index)
    .filter((value) => value > 5);
  return transformed.reduce((sum, value) => sum + value, 0);
}

export function capturedPipeline(seed: number, delta: number): number {
  return [seed, 2, 3]
    .map((value) => value + delta)
    .reduce((sum, value) => sum + value, 0);
}

export function mutateCapturedTotal(seed: number): number {
  let total = seed;
  [1, 2, 3].forEach((value) => {
    total += value;
  });
  return total;
}

function addIndex(value: number, index: number): number {
  return value + index;
}

export function namedPipeline(seed: number): number {
  return [seed, 2]
    .map(addIndex)
    .reduce((sum, value) => sum + value, 0);
}

let spreadEvaluation = 0;

function evaluatedNumber(marker: number): number {
  spreadEvaluation = spreadEvaluation * 10 + marker;
  return marker;
}

function evaluatedPair(marker: number): number[] {
  spreadEvaluation = spreadEvaluation * 10 + marker;
  return [marker, marker + 1];
}

export function spreadLiteralOrder(): number {
  spreadEvaluation = 0;
  const values = [
    evaluatedNumber(1),
    ...evaluatedPair(2),
    evaluatedNumber(3),
    ...evaluatedPair(4),
    evaluatedNumber(5),
  ];
  return spreadEvaluation +
    values[0]! +
    values[1]! * 10 +
    values[2]! * 100 +
    values[3]! * 1_000 +
    values[4]! * 10_000 +
    values[5]! * 100_000 +
    values[6]! * 1_000_000;
}

export function selfSpreadArray(): number {
  const values = [1, 2, 3];
  const length = values.push(...values);
  return length * 1_000 + values[3]! * 100 + values[4]! * 10 + values[5]!;
}
