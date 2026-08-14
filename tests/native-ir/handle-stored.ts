import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(40 as i32);
  const handles = [counter];
  const holder = { counter };
  if (handles.length !== 1) return 1 as i32;
  const value = holder.counter.add(2 as i32);
  counter.dispose();
  return counterVerify(value, counterDestroyedCount(), 42 as i32, 1 as i32);
}

exit(run());
