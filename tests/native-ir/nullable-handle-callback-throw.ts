import type { i32 } from "@native-typescript/scabi-c-v1-fixture";
import { callbackNullableCounter, exit } from "scriptc-native-test";

function run(): i32 {
  try {
    callbackNullableCounter((_value): i32 => {
      throw new Error("callback wins");
    }, 1 as i32);
  } catch (error) {
    if (error instanceof Error && error.message === "callback wins") {
      return 42 as i32;
    }
  }
  return 1 as i32;
}

exit(run());
