interface Hit {
  score: number;
}

export function optionalNumber(seed: number, present: boolean): number {
  const value: number | undefined = present ? seed : undefined;
  return value === undefined ? 11 : value + 3;
}

export function optionalNumberIdentity(seed: number, present: boolean): number {
  const value: number | undefined = present ? seed : undefined;
  return value === undefined ? 91 : value;
}

export function optionalNumberKinds(seed: number, arm: number): number {
  const value: number | null | undefined = arm === 0
    ? seed
    : arm === 1
      ? null
      : undefined;
  if (value === null) return 11;
  if (value === undefined) return 22;
  if (Number.isNaN(value)) return 33;
  return Object.is(value, -0) ? 44 : value;
}

export function optionalNumberArray(): number {
  const values: (number | undefined)[] = [0 / 0, undefined, -0, 3];
  let checksum = 0;
  const first = values[0];
  if (first !== undefined && Number.isNaN(first)) checksum += 1;
  if (values[1] === undefined) checksum += 2;
  const third = values[2];
  if (third !== undefined && Object.is(third, -0)) checksum += 4;
  const fourth = values[3];
  if (fourth !== undefined && fourth === 3) checksum += 8;
  return checksum;
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
