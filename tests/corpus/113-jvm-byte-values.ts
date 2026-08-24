export function filledBytes(length: number): Uint8Array {
  const output = new Uint8Array(length);
  let index = 0;
  while (index < output.length) {
    output[index] = index * 17 + 500;
    index += 1;
  }
  return output;
}

export function copiedBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(input);
}

export function emptyBytes(): Uint8Array {
  return new Uint8Array();
}
