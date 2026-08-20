import {
  errorHandleFail,
  errorOutDivide,
  errorOutI8,
  errorOutU8,
  fixtureErrorsOutstanding,
  type i32,
  type i8,
  type u8,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  // A null error object is success and must not throw.
  errorHandleFail(0 as i32);
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 1 as i32;

  let caught = 0 as i32;
  try {
    errorHandleFail(7 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "@scriptc/native-abi-fixture.errorHandleFail: fixture failure 7"
    ) {
      caught = 1 as i32;
    }
  }
  if (caught !== (1 as i32)) return 2 as i32;

  // The message is copied into the thrown Error, so the object is released on
  // the throwing path too.
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 3 as i32;

  // Failure through a SLOT rather than the result, so the call keeps its own
  // return value. Success hands back the quotient.
  if (errorOutDivide(84 as i32, 2 as i32) !== (42 as i32)) return 4 as i32;
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 5 as i32;

  let divided = 0 as i32;
  let thrown = 0 as i32;
  try {
    // On failure the callee still returns a value. Reading it would be wrong,
    // so the assignment below must never happen.
    divided = errorOutDivide(9 as i32, 0 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "@scriptc/native-abi-fixture.errorOutDivide: fixture failure 9"
    ) {
      thrown = 1 as i32;
    }
  }
  if (thrown !== (1 as i32)) return 6 as i32;
  // The result was never projected: the unwind beat it.
  if (divided !== (0 as i32)) return 7 as i32;
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 8 as i32;

  // The same channel with a SUB-WORD result. A u8 or i8 is the only result
  // whose ABI spelling carries an extension attribute, and the failure slot
  // is what makes a backend bind the call into a temporary before projecting
  // it — the position where that attribute is not allowed. Success first, so
  // a backend that cannot emit the pair at all fails here rather than in the
  // throwing case where a wrong answer could be mistaken for the unwind.
  if (errorOutU8(200 as i32) !== (200 as u8)) return 9 as i32;
  if (errorOutI8(100 as i32) !== (100 as i8)) return 10 as i32;

  let subword = 0 as u8;
  thrown = 0 as i32;
  try {
    // On failure the callee still returns a value, and 0xFE is one that would
    // be wrong to keep.
    subword = errorOutU8(-3 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "@scriptc/native-abi-fixture.errorOutU8: fixture failure -3"
    ) {
      thrown = 1 as i32;
    }
  }
  if (thrown !== (1 as i32)) return 11 as i32;
  if (subword !== (0 as u8)) return 12 as i32;
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 13 as i32;
  return 42 as i32;
}

exit(run());
