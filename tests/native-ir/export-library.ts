import type { i32 } from "@scriptc/native-abi-fixture";

/** A host-callable exact Native IR export: no JavaScript-number ABI
 * conversion is permitted at either side of this function. */
export function ntsTsAddI32(left: i32, right: i32): i32 {
  return (left + right) as i32;
}
