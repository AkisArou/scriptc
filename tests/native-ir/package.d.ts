declare const nativeScalar: unique symbol;
declare const nativeResource: unique symbol;

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

export interface Counter {
  readonly [nativeResource]: "Counter";
  add(delta: i32): i32;
  value(): i32;
  dispose(): void;
}

export interface Subscription {
  emit(value: i32): i32;
  emitForeign(value: i32): i32;
  dispose(): void;
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
export declare function paddedRoundtrip(value: Padded): Padded;
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
