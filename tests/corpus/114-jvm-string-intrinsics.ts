export function codeAt(value: string, index: number): number {
  return value.charCodeAt(index);
}

export function characterAt(value: string, index: number): string {
  return value.charAt(index);
}

export function findText(value: string, needle: string, position: number): number {
  return value.indexOf(needle, position);
}

export function hasText(value: string, needle: string, position: number): boolean {
  return value.includes(needle, position);
}

export function startsWithText(value: string, start: string): boolean {
  return value.startsWith(start);
}

export function endsWithText(value: string, end: string): boolean {
  return value.endsWith(end);
}

export function sliced(value: string, start: number, end: number): string {
  return value.slice(start, end);
}

export function substring(value: string, start: number, end: number): string {
  return value.substring(start, end);
}

export function repeated(value: string, count: number): string {
  return value.repeat(count);
}

export function padded(value: string, length: number, fill: string): string {
  return value.padStart(length, fill) + value.padEnd(length, fill);
}

export function trimmed(value: string): string {
  return value.trim() + ":" + value.trimStart() + ":" + value.trimEnd();
}

export function cased(value: string): string {
  return value.toLowerCase() + ":" + value.toUpperCase();
}

export function wellFormed(value: string): boolean {
  return value.isWellFormed();
}

export function repaired(value: string): string {
  return value.toWellFormed();
}

export function splitCount(
  value: string,
  separator: string,
  limit: number,
): number {
  return value.split(separator, limit).length;
}

export function splitPart(
  value: string,
  separator: string,
  limit: number,
  index: number,
): string {
  return value.split(separator, limit)[index]!;
}
