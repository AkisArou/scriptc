import {
  counterBaseValueOr,
  counterValueOr,
  type Counter,
  type CounterBase,
  type i32,
} from "@scriptc/native-abi-fixture";
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

  /* The optional slot declared over the base of the hierarchy. A Counter is
   * two identity upcasts below it, and an upcast changes only the nominal
   * type — the managed cell and its pointer are the same value — so the
   * argument widens into the arm rather than being refused by it. Without
   * this every foreign API that accepts absence would reject every derived
   * argument, which is most of them. */
  if (counterBaseValueOr(counter, 99 as i32) !== direct) return 4 as i32;
  if (counterBaseValueOr(null, 99 as i32) !== (99 as i32)) return 5 as i32;

  // The widened value is the same cell: one call reads it through the base.
  const base: CounterBase = counter;
  if (base.value() !== direct) return 6 as i32;

  /* A whole union crossing into another: `Counter | null` re-tags into
   * `CounterBase | null`, its handle arm widening as it goes. This is the
   * shape a ternary has, so it is what an ordinary optional argument looks
   * like once the value is computed rather than written at the call. */
  if (counterBaseValueOr(optional, 99 as i32) !== direct) return 7 as i32;
  const absent: Counter | null = counter.value() === (0 as i32) ? counter : null;
  if (counterBaseValueOr(absent, 99 as i32) !== (99 as i32)) return 8 as i32;

  counter.dispose();
  return 42 as i32;
}

exit(run());
