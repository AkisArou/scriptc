import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(40 as i32);
  const alias = counter;
  const value = alias.add(2 as i32);
  counter.dispose();
  alias.dispose();
  return counterVerify(value, counterDestroyedCount(), 42 as i32, 1 as i32);
}

exit(run());
