import { createCounter, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createCounter(42 as i32);
  counter.dispose();
  try {
    counter.value();
    return 1 as i32;
  } catch {
    /* The same throw one frame further in. Every handle argument is checked
     * before its call, so a binding that takes one is a throwing call, and a
     * caller has to notice it where the closure returns rather than where the
     * throw happened — otherwise the exception walks out past this `try`. */
    let reached = false;
    const ask = (): void => {
      counter.value();
      reached = true;
    };
    try {
      ask();
      return 2 as i32;
    } catch {
      return reached ? (3 as i32) : (42 as i32);
    }
  }
}

exit(run());
