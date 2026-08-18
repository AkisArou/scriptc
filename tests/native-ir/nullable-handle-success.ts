import type { i32 } from "@scriptc/native-abi-fixture";
import { createNullableCounter, exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createNullableCounter(1 as i32);
  const value = counter.value();
  counter.dispose();
  return value;
}

exit(run());
