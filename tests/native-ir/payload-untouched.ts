import {
  counterDestroyedCount,
  noticeFire,
  noticeMark,
  noticeWith,
} from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  exit,
} from "scriptc-native-test";

/* A payload the handler NEVER TOUCHES. The parameter is declared and its type
 * arrives by contextual typing, so the program never writes the nominal type
 * anywhere — no construction, no method call, no annotation naming it. The
 * only thing left mentioning it is the callback signature the contract
 * carries.
 *
 * This is what a framework handler looks like. A lifecycle method is handed an
 * object it forwards or ignores, and the neighbouring process-owned program
 * calls `subject.add(...)`, which marks the type through an ordinary
 * expression and leaves this path proven by accident.
 *
 * The reference still has to come back: the emitter took one before the
 * handler ran, and the cell's destructor gives it back whether the handler
 * reads the payload or not. That is what the destroyed count observes. */
callbacksConfigure();
noticeWith((subject): void => {
  if (subject !== null) noticeMark();
});

function run(): i32 {
  const before = counterDestroyedCount();
  if (noticeFire(4 as i32) !== (1 as i32)) return 1 as i32;
  /* One subject created, one released — an untouched payload is released on
   * exactly the same footing as a read one. */
  if (counterDestroyedCount() !== ((before + (1 as i32)) as i32)) return 2 as i32;
  if (noticeFire(9 as i32) !== (1 as i32)) return 3 as i32;
  if (counterDestroyedCount() !== ((before + (2 as i32)) as i32)) return 4 as i32;
  /* Nothing owns the registration, so nothing can cancel it: shutdown reports
   * it still live. That is the arm's defining property, not a leak. */
  if (callbacksShutdown() !== (0 as i32)) return 5 as i32;
  return 42 as i32;
}

exit(run());
