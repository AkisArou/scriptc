import {
  errorHandleFail,
  errorOutDivide,
  fixtureErrorsOutstanding,
  type i32,
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
  return 42 as i32;
}

exit(run());
