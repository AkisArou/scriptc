export function stringNumberMap(seed: number): number {
  const values = new Map<string, number>([
    ["alpha", 1],
    ["beta", 2],
  ]);
  values.set("alpha", seed);
  const hit = values.get("alpha");
  let checksum = hit === undefined ? -100 : hit;
  if (values.has("beta")) checksum += 3;
  if (values.delete("beta")) checksum += 5;
  if (values.delete("beta")) checksum += 100;
  checksum += values.size;
  values.clear();
  return checksum + values.size;
}

export function numberStringMap(seed: number): number {
  const values = new Map<number, string>();
  values.set(-0, "zero");
  values.set(0 / 0, "nan");
  values.set(seed, "value");
  const zero = values.get(0);
  const nan = values.get(0 / 0);
  const found = values.get(seed);
  return (zero === undefined ? 0 : zero.length) +
    (nan === undefined ? 0 : nan.length) +
    (found === undefined ? 0 : found.length) +
    values.size;
}

export function booleanMap(): number {
  const flags = new Map<string, boolean>();
  flags.set("on", true);
  flags.set("off", false);
  const off = flags.get("off");
  return off === undefined ? -1 : off ? 99 : flags.size;
}

export function unionValueMap(numberArm: boolean): number {
  const values = new Map<string, number | string>();
  const stored: number | string = numberArm ? 7 : "four";
  values.set("value", stored);
  const hit = values.get("value");
  if (hit === undefined) return -100;
  return typeof hit === "string" ? hit.length + 1 : hit + 2;
}

export function nullableValueMap(nullArm: boolean): number {
  const values = new Map<string, string | null>();
  values.set("value", nullArm ? null : "four");
  const hit = values.get("value");
  if (hit === undefined) return -100;
  return hit === null ? 7 : hit.length;
}

export function undefinedValueMap(): number {
  const values = new Map<string, string | undefined>();
  values.set("value", undefined);
  const hit = values.get("value");
  return hit === undefined && values.has("value") ? values.size + 1 : -1;
}

export function liveIterationMap(): number {
  const values = new Map<string, number>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  let checksum = 0;
  values.forEach((value, key) => {
    checksum += value + key.length;
    if (key === "a") {
      values.delete("b");
      values.set("d", 4);
    }
  });
  return checksum;
}

export function clearDuringIterationMap(): number {
  const values = new Map<string, number>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  let checksum = 0;
  values.forEach((value, key) => {
    checksum += value;
    if (key === "a") {
      values.clear();
      values.set("d", 4);
      values.set("e", 5);
    }
  });
  return checksum * 10 + values.size;
}

export function rehashAndCompactMap(): number {
  const values = new Map<number, number>();
  for (let index = 0; index < 96; index++) {
    values.set(index, index * 2);
  }
  for (let index = 0; index < 64; index++) {
    values.delete(index);
  }
  for (let index = 0; index < 64; index++) {
    values.set(index, index);
  }
  let checksum = 0;
  values.forEach((value, key) => {
    checksum += value + key;
  });
  return checksum + values.size;
}
