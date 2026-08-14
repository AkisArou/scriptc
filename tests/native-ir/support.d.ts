import type {
  i8,
  u8,
  i16,
  u16,
  i32,
  u32,
  i64,
  u64,
  usize,
  Counter,
  Padded,
} from "@native-typescript/scabi-c-v1-fixture";

declare const nativeScalar: unique symbol;
export type isize = bigint & { readonly [nativeScalar]: "isize" };

export declare function exit(status: i32): void;
export declare function unused(value: i32): i32;
export declare function isizeIdentity(value: isize): isize;
export declare function verifyExactIntegers(
  signed8: i8,
  unsigned8: u8,
  signed16: i16,
  unsigned16: u16,
  signed32: i32,
  unsigned32: u32,
  signed64: i64,
  unsigned64: u64,
  signedSize: isize,
  unsignedSize: usize,
): i32;
export declare function verifyPadded(
  value: Padded,
  tag: u8,
  scalarValue: u64,
  ratio: import("@native-typescript/scabi-c-v1-fixture").f64,
): i32;
export declare function verifyUtf8Hash(actual: u64): i32;
export declare function verifyBytesHash(actual: u64): i32;
export declare function verifyCallScoped(forwarded: i32, captured: i32): i32;
export declare function callbackErrno(
  callback: (value: i32) => i32,
  value: i32,
): i32;
export declare function createNullableCounter(succeed: i32): Counter;
export declare function callbackNullableCounter(
  callback: (value: i32) => i32,
  succeed: i32,
): Counter;
export declare function callbacksConfigure(): i32;
export declare function callbacksWaitAndDispatch(expectedWakes: i32): i32;
export declare function callbacksActive(): i32;
export declare function callbacksShutdown(): i32;
export declare function verifyRetained(
  total: i32,
  activeBefore: i32,
  activeAfter: i32,
  shutdown: i32,
): i32;
