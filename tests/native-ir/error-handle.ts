import {
  errorHandleFail,
  fixtureErrorsOutstanding,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
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
        "@native-typescript/scabi-c-v1-fixture.errorHandleFail: fixture failure 7"
    ) {
      caught = 1 as i32;
    }
  }
  if (caught !== (1 as i32)) return 2 as i32;

  // The message is copied into the thrown Error, so the object is released on
  // the throwing path too.
  if (fixtureErrorsOutstanding() !== (0 as i32)) return 3 as i32;
  return 42 as i32;
}

exit(run());
