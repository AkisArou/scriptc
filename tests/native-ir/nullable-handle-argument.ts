import {
  counterValueOr,
  type Counter,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
import { createNullableCounter, exit } from "scriptc-native-test";

function run(): i32 {
  const counter = createNullableCounter(7 as i32);
  const direct = counter.value();
  // A present handle is validated and borrowed exactly as a required one is.
  if (counterValueOr(counter, 99 as i32) !== direct) return 1 as i32;

  // The null arm passes NULL without consulting the handle table.
  if (counterValueOr(null, 99 as i32) !== (99 as i32)) return 2 as i32;

  // One call site reached through a union carrying either arm.
  const optional: Counter | null =
    counter.value() !== (0 as i32) ? counter : null;
  if (counterValueOr(optional, 99 as i32) !== direct) return 3 as i32;

  counter.dispose();
  return 42 as i32;
}

exit(run());
