import { failErrno, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  try {
    failErrno(22 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "EINVAL: invalid argument, @scriptc/native-abi-fixture.failErrno"
    ) {
      return 42 as i32;
    }
  }
  return 1 as i32;
}

exit(run());
