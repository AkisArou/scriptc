import { counterDestroyedCount, maybeJudgeWith } from "@scriptc/native-abi-fixture";
import type { Counter, i32 } from "@scriptc/native-abi-fixture";
import { callbacksConfigure, callbacksShutdown, exit } from "scriptc-native-test";

/* The OWNER-SCOPED withheld payload: a handler that ANSWERS while holding a
 * scalar and a subject that may not be there, anchored to a receiver whose
 * disposal cancels it.
 *
 * This is the arm beside the one already proven, and beside is where the
 * defect was. The process-owned withheld payload had a program; the rule that
 * admits a synchronous delivery's payloads was widened in the branch written
 * for that owner and not in the branch next to it, so an answering
 * receiver-anchored handler with the identical payload was refused as an
 * invalid contract. Nothing about the owner bears on whether a payload may be
 * absent — the delivery being synchronous is the whole reason — which is
 * exactly why the two branches had to be checked against each other rather
 * than each against itself.
 *
 * The answer is what makes it distinguishable: the handler's verdict IS the
 * emitting call's result, so a delivery that did not run in the caller's frame
 * would answer with the fixture's own zero rather than the handler's. */
callbacksConfigure();

/* The receiver is scoped to the call rather than held in a module const: a
 * global keeps its cell alive to exit, and the reference audit counts that as
 * a live object — correctly, since nothing released it. An owner-scoped
 * registration can live here precisely because something ends it, which is the
 * difference from the process-owned program next door. */
function run(): i32 {
  const before = counterDestroyedCount();
  const judge = maybeJudgeWith((code: i32, subject: Counter | null): boolean => {
    // Absent: the code alone decides, and reading the subject would be a fault.
    if (subject === null) return code === (7 as i32);
    // Present: the subject answers, which a null could not have done.
    return subject.add(1 as i32) === (5 as i32);
  });

  // Absent, and the handler's own verdict comes back — both ways.
  if (judge.askMaybe(7 as i32, -1 as i32) !== (1 as i32)) return 1 as i32;
  if (judge.askMaybe(3 as i32, -1 as i32) !== (0 as i32)) return 2 as i32;
  // Nothing was created, so nothing is released.
  if (counterDestroyedCount() !== before) return 3 as i32;

  // Present: 4 + 1 answers 5, and the subject's reference comes back.
  if (judge.askMaybe(0 as i32, 4 as i32) !== (1 as i32)) return 4 as i32;
  if (counterDestroyedCount() !== ((before + (1 as i32)) as i32)) return 5 as i32;
  // Present and declining: the verdict is the handler's either way.
  if (judge.askMaybe(0 as i32, 9 as i32) !== (0 as i32)) return 6 as i32;
  if (counterDestroyedCount() !== ((before + (2 as i32)) as i32)) return 7 as i32;

  /* The receiver owns the registration, so disposing it cancels — which is
   * the difference from the process-owned program, where shutdown reports the
   * registration still live because nothing could end it. */
  judge.dispose();
  if (callbacksShutdown() !== (1 as i32)) return 8 as i32;
  return 42 as i32;
}

exit(run());
