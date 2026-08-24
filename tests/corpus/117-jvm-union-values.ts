interface Hit {
  score: number;
}

export function optionalNumber(seed: number, present: boolean): number {
  const value: number | undefined = present ? seed : undefined;
  return value === undefined ? 11 : value + 3;
}

export function optionalRecord(seed: number, present: boolean): number {
  const value: Hit | undefined = present ? { score: seed } : undefined;
  return value === undefined ? 5 : value.score;
}

export function optionalString(value: string, present: boolean): number {
  const maybe: string | undefined = present ? value : undefined;
  return maybe === undefined ? 7 : maybe.length;
}

export function optionalArray(seed: number, present: boolean): number {
  const values: number[] | undefined = present ? [seed, 2] : undefined;
  return values === undefined ? 9 : values[0]! + values.length;
}

export function mixedValue(seed: number, arm: number): number {
  const value: number | string | null = arm === 0
    ? seed
    : arm === 1
      ? "v" + seed
      : null;
  if (value === null) return 5;
  if (typeof value === "string") return value.length;
  return value + 2;
}
