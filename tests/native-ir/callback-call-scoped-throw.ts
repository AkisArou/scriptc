import type { i32 } from "@native-typescript/scabi-c-v1-fixture";
import { callScoped } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  try {
    callScoped((_value): i32 => {
      throw new Error("callback failure");
    }, 0 as i32);
  } catch (error) {
    if (error instanceof Error && error.message === "callback failure") {
      return 42 as i32;
    }
  }

  return 1 as i32;
}

exit(run());
