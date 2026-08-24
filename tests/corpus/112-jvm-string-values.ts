export function joined(value: number, enabled: boolean): string {
  return `value=${value} enabled=${enabled}`;
}

export function equal(left: string, right: string): boolean {
  return left === right;
}

export function notEqual(left: string, right: string): boolean {
  return left !== right;
}

export function numberText(value: number): string {
  return String(value);
}

export function maybeText(value: string, present: boolean): string | null {
  return present ? value : null;
}

export function nullableLength(value: string | null): number {
  if (value === null) return -1;
  return value.length;
}
