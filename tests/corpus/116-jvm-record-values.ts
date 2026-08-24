interface BenchmarkRow {
  count: number;
  label: string;
  active: boolean;
}

export function recordFields(seed: number, label: string): number {
  const row: BenchmarkRow = { label, count: seed, active: true };
  row.count += 7;
  return row.count + row.label.length + (row.active ? 1 : 0);
}

export function recordEvaluationOrder(): number {
  let order = 0;
  const mark = (value: number): number => {
    order = order * 10 + value;
    return value;
  };
  const row = { z: mark(1), a: mark(2) };
  return order * 100 + row.z * 10 + row.a;
}
