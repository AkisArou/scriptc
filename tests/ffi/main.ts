declare function nativeScale(value: number): number;
declare function nativeInvert(value: boolean): boolean;
declare function nativeU8(value: number): number;
declare function nativeU32(value: number): number;
declare function nativeI32(value: number): number;
declare function nativeTextSum(value: string): number;
declare function nativeBytesSum(value: Uint8Array): number;
declare function nativeNote(value: number): void;
declare function nativeLastNote(): number;
declare function nativeApply(callback: (value: number) => number, value: number): number;
declare function nativeCombineRaw(
  left: (value: number) => number,
  right: (value: number) => number,
  value: number,
): number;
declare function nativeCallbackMix(
  callback: (
    truth: boolean,
    byte: number,
    wide: number,
    signedValue: number,
    fraction: number,
  ) => number,
): number;
declare function nativeEach(callback: (value: number) => void): void;

console.log(nativeScale(21));
console.log(nativeInvert(false), nativeInvert(true));
console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));
console.log(nativeTextSum("A\0é"));
console.log(nativeBytesSum(new Uint8Array([1, 2, 3])));
nativeNote(12.5);
console.log(nativeLastNote());

const offset = 7;
console.log(nativeApply((value) => value + offset, 5));

const leftOffset = 3;
const rightFactor = 4;
console.log(nativeCombineRaw((value) => value + leftOffset, (value) => value * rightFactor, 5));

console.log(nativeCallbackMix((truth, byte, wide, signedValue, fraction) => {
  console.log(truth, byte, wide, signedValue, fraction);
  return -1;
}));

let total = 0;
nativeEach((value) => {
  total += value;
});
console.log(total);

try {
  nativeApply(() => {
    throw new Error("callback boom");
  }, 1);
} catch (error) {
  console.log("caught", (error as Error).message);
}
