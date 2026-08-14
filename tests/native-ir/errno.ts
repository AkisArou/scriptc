import { failErrno, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  try {
    failErrno(22 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "EINVAL: invalid argument, @native-typescript/scabi-c-v1-fixture.failErrno"
    ) {
      return 42 as i32;
    }
  }
  return 1 as i32;
}

exit(run());
