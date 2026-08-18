import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(42 as i32);
  const value = counter.value();
  counter.dispose();
  return counterVerify(value, counterDestroyedCount(), 42 as i32, 1 as i32);
}

exit(run());
