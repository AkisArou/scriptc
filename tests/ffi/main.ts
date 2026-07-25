declare function nativeScale(value: number): number;
declare function nativeInvert(value: boolean): boolean;
declare function nativeU8(value: number): number;
declare function nativeU32(value: number): number;
declare function nativeI32(value: number): number;
declare function nativeTextSum(value: string): number;
declare function nativeBytesSum(value: Uint8Array): number;
declare function nativeNote(value: number): void;
declare function nativeLastNote(): number;

console.log(nativeScale(21));
console.log(nativeInvert(false), nativeInvert(true));
console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));
console.log(nativeTextSum("A\0é"));
console.log(nativeBytesSum(new Uint8Array([1, 2, 3])));
nativeNote(12.5);
console.log(nativeLastNote());
