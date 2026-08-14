import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(40 as i32);
  let alias = counter;
  const add = (): i32 => alias.add(2 as i32);
  alias = counter;
  const value = add();
  counter.dispose();
  return counterVerify(value, counterDestroyedCount(), 42 as i32, 1 as i32);
}

exit(run());
