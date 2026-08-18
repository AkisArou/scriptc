import {
  cStringObserve,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  cStringObserve("native");

  try {
    cStringObserve("before\0after");
  } catch {
    cStringObserve("done");
    return 42 as i32;
  }
  return 1 as i32;
}

exit(run());
