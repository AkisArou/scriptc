export function stringSet(seed: string): number {
  const values = new Set<string>(["alpha", "beta", "alpha"]);
  values.add(seed);
  values.add(seed);
  let checksum = values.size;
  if (values.has("alpha")) checksum += 2;
  if (values.delete("beta")) checksum += 3;
  if (values.delete("beta")) checksum += 100;
  checksum += values.size;
  values.clear();
  return checksum + values.size;
}

export function numberSet(seed: number): number {
  const values = new Set<number>();
  values.add(-0);
  values.add(0 / 0);
  values.add(seed);
  let checksum = values.size;
  if (values.has(0)) checksum += 2;
  if (values.has(0 / 0)) checksum += 3;
  values.add(0);
  if (values.delete(seed)) checksum += 5;
  return checksum + values.size;
}

export function seededEvaluationOrderSet(): number {
  let order = 0;
  const mark = (value: number): number => {
    order = order * 10 + value;
    return value;
  };
  const values = new Set<number>([mark(1), mark(2), mark(1)]);
  return order * 10 + values.size;
}

export function spreadSet(): number {
  const values = new Set<string>(["b", "a", "b", "c"]);
  values.delete("a");
  values.add("d");
  const drained = [...values];
  return drained.length === 3 &&
      drained[0]! === "b" &&
      drained[1]! === "c" &&
      drained[2]! === "d"
    ? 7
    : -1;
}

export function liveIterationSet(): number {
  const values = new Set<string>(["a", "bb", "ccc"]);
  let checksum = 0;
  values.forEach((value, key) => {
    checksum += value.length + key.length;
    if (value === "a") {
      values.delete("bb");
      values.add("dddd");
    }
  });
  return checksum + values.size;
}

export function clearDuringIterationSet(): number {
  const values = new Set<string>(["a", "bb", "ccc"]);
  let checksum = 0;
  values.forEach((value) => {
    checksum += value.length;
    if (value === "a") {
      values.clear();
      values.add("dddd");
      values.add("eeeee");
    }
  });
  return checksum * 10 + values.size;
}

export function combinedSets(): number {
  const a = new Set<number>([1, 2, 3, 4]);
  const b = new Set<number>([3, 4, 5]);
  let checksum = a.union(b).size * 1000 +
    a.intersection(b).size * 100 +
    a.difference(b).size * 10 +
    a.symmetricDifference(b).size;
  if (new Set<number>([3, 4]).isSubsetOf(a)) checksum += 1;
  if (a.isSupersetOf(new Set<number>([2, 3]))) checksum += 2;
  if (a.isDisjointFrom(new Set<number>([9]))) checksum += 4;
  if (!a.isDisjointFrom(b)) checksum += 8;
  return checksum;
}

export function rehashAndCompactSet(): number {
  const values = new Set<number>();
  for (let index = 0; index < 96; index++) {
    values.add(index);
  }
  for (let index = 0; index < 64; index++) {
    values.delete(index);
  }
  for (let index = 0; index < 64; index++) {
    values.add(index);
  }
  let checksum = 0;
  values.forEach((value) => {
    checksum += value;
  });
  return checksum + values.size;
}

export function directSetIteration(): number {
  const values = new Set<string>(["a", "bb", "ccc"]);
  let checksum = 0;
  for (const member of values) checksum += member.length;
  return checksum;
}
