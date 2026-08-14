import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function useCounter(): i32 {
  const counter = createCounter(39 as i32);
  return counter.add(3 as i32);
}

const value = useCounter();
exit(counterVerify(value, counterDestroyedCount(), 42 as i32, 1 as i32));
