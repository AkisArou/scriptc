import {
  counterDestroyedCount,
  maybeFire,
  maybeMark,
  maybeWith,
} from "@scriptc/native-abi-fixture";
import type { Counter, i32 } from "@scriptc/native-abi-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  exit,
} from "scriptc-native-test";

/* A payload the emitter may WITHHOLD, in both of its arms.
 *
 * The pair is the whole point. A handler that only ever receives an object
 * proves nothing about absence, and one that only ever receives null proves
 * nothing about the reference — and the two share a slot, so a lowering that
 * confused them still compiles. Only a program that takes both through one
 * registration can tell them apart.
 *
 * The handler marks rather than reporting, because a mark is observable from
 * the emitting call and a captured variable would have to be a box. Absence
 * marks unconditionally; presence marks only when the object answers, so one
 * counter distinguishes "saw null", "saw a live object", and "saw an object
 * that did not answer". */
callbacksConfigure();

maybeWith((subject: Counter | null): void => {
  if (subject === null) {
    maybeMark();
    return;
  }
  if (subject.add(2 as i32) === (9 as i32)) maybeMark();
});

function run(): i32 {
  const before = counterDestroyedCount();

  // Present: the subject starts at 7, answers 9, and its cell releases it.
  if (maybeFire(7 as i32) !== (1 as i32)) return 1 as i32;
  if (counterDestroyedCount() !== ((before + (1 as i32)) as i32)) return 2 as i32;

  /* Absent: a negative seed withholds the subject. The handler sees null —
   * not a trap, not a cell wrapping NULL — and nothing is released, because
   * nothing was created and the destructor never sees a pointer the library
   * did not give. */
  if (maybeFire(-1 as i32) !== (1 as i32)) return 3 as i32;
  if (counterDestroyedCount() !== ((before + (1 as i32)) as i32)) return 4 as i32;

  /* Present again, which is what proves the absent delivery left the
   * registration intact rather than merely surviving it. This subject answers
   * 42 instead of 9, so the handler declines to mark and the reference is
   * still given back. */
  if (maybeFire(40 as i32) !== (0 as i32)) return 5 as i32;
  if (counterDestroyedCount() !== ((before + (2 as i32)) as i32)) return 6 as i32;

  // Nothing owns the registration, so shutdown reports it still live.
  if (callbacksShutdown() !== (0 as i32)) return 7 as i32;
  return 42 as i32;
}

exit(run());
