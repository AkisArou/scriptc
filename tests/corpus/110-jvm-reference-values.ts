export function utf16Length(value: string): number {
  return value.length;
}

export function byteLength(value: Uint8Array): number {
  return value.length;
}

export function firstByte(value: Uint8Array): number {
  return value[0];
}
