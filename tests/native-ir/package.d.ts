declare const nativeScalar: unique symbol;
declare const nativeCounterBaseResource: unique symbol;
declare const nativeCounterMiddleResource: unique symbol;
declare const nativeCounterResource: unique symbol;

export type i8 = number & { readonly [nativeScalar]: "i8" };
export type u8 = number & { readonly [nativeScalar]: "u8" };
export type i16 = number & { readonly [nativeScalar]: "i16" };
export type u16 = number & { readonly [nativeScalar]: "u16" };
export type i32 = number & { readonly [nativeScalar]: "i32" };
export type u32 = number & { readonly [nativeScalar]: "u32" };
export type i64 = bigint & { readonly [nativeScalar]: "i64" };
export type u64 = bigint & { readonly [nativeScalar]: "u64" };
export type usize = bigint & { readonly [nativeScalar]: "usize" };
export type f64 = number & { readonly [nativeScalar]: "f64" };

export interface Padded {
  readonly tag: u8;
  readonly value: u64;
  readonly ratio: f64;
}

export interface Pair32 {
  readonly first: i32;
  readonly second: i32;
}

export interface PairF64 {
  readonly first: f64;
  readonly second: f64;
}

export interface CounterBase {
  readonly [nativeCounterBaseResource]: true;
  value(): i32;
}

export interface CounterMiddle extends CounterBase {
  readonly [nativeCounterMiddleResource]: true;
}

export interface Counter extends CounterMiddle {
  readonly [nativeCounterResource]: true;
  add(delta: i32): i32;
  label(): string | null;
  requiredLabel(): string;
  dispose(): void;
}

export interface Subscription {
  emit(value: i32): i32;
  emitForeign(value: i32): i32;
  dispose(): void;
}

export declare class NativeCounter {
  constructor(initialValue: i32);
  static withInitialValue(initialValue: i32): NativeCounter;
}

export declare function i8Identity(value: i8): i8;
export declare function u8Identity(value: u8): u8;
export declare function i16Identity(value: i16): i16;
export declare function u16Identity(value: u16): u16;
export declare function i32Identity(value: i32): i32;
export declare function u32Identity(value: u32): u32;
export declare function i64Identity(value: i64): i64;
export declare function u64Identity(value: u64): u64;
export declare function usizeIdentity(value: usize): usize;
export declare function nativeFalse(): boolean;
export declare function nativeInvalidBoolean(): boolean;
export declare function nativeNot(value: boolean): boolean;
export declare function nativeTrue(): boolean;
export declare function paddedRoundtrip(value: Padded): Padded;
export declare function pair32Transform(value: Pair32): Pair32;
export declare function pairF64Transform(value: PairF64): PairF64;
export declare function pairF64Verify(value: PairF64): i32;
export declare function hashUtf8(value: string): u64;
export declare function cStringObserve(value: string): void;
export declare function hashBytes(value: Uint8Array): u64;
export declare function callScoped(
  callback: (value: i32) => i32,
  value: i32,
): i32;
export declare function failErrno(errorNumber: i32): never;
export declare function createCounter(initialValue: i32): Counter;
export declare function subscribe(
  callback: (value: i32) => void,
): Subscription;
export declare function counterDestroyedCount(): i32;
export declare function counterVerify(
  actualValue: i32,
  actualDestroyed: i32,
  expectedValue: i32,
  expectedDestroyed: i32,
): i32;
