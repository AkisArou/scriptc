function boundedIntegerLoop(iterations: number): number {
  let checksum = 0;
  let index = 0;
  while (index < iterations) {
    checksum += index & 255;
    index += 1;
  }
  return checksum;
}

export function directIntegerParameter(): number {
  return boundedIntegerLoop(64);
}

export function publicNumberParameter(value: number): number {
  return value & 255;
}

export function callPublicNumberParameter(): number {
  return publicNumberParameter(511);
}
