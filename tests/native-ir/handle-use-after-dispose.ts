import { createCounter, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(42 as i32);
  counter.dispose();
  try {
    counter.value();
    return 1 as i32;
  } catch {
    return 42 as i32;
  }
}

exit(run());
