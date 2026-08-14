import type {
  i8,
  u8,
  i16,
  u16,
  i32,
  u32,
  i64,
  u64,
} from "@native-typescript/scabi-c-v1-fixture";

export declare function exit(status: i32): void;
export declare function unused(value: i32): i32;
export declare function verifyExactIntegers(
  signed8: i8,
  unsigned8: u8,
  signed16: i16,
  unsigned16: u16,
  signed32: i32,
  unsigned32: u32,
  signed64: i64,
  unsigned64: u64,
): i32;
