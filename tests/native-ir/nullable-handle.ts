import type { i32 } from "@scriptc/native-abi-fixture";
import { createNullableCounter, exit } from "scriptc-native-test";

function run(): i32 {
  try {
    createNullableCounter(0 as i32);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "scriptc-native-test.createNullableCounter returned null"
    ) {
      return 42 as i32;
    }
  }
  return 1 as i32;
}

exit(run());
