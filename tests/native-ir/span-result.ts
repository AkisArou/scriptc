/* UTF-8 text crossing as a pointer and a length rather than a terminator.
 *
 * The projection exists for exactly one reason — text that may contain NUL —
 * and only a program that reads PAST the embedded NUL can tell a correct
 * lowering from one that scanned for a terminator. The wrong answer here is
 * not a crash or an empty string; it is "na", which is a shorter string that
 * looks entirely reasonable.
 *
 * Both nullabilities run, because absence is a value in one and a broken
 * contract in the other, and the two share every line of the copy. */
import {
  spanLabel,
  spanLabelMaybe,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const label = spanLabel();
  /* Five bytes, not two: a terminator scan stops at index 2 and answers "na"
   * with length 2, which is the failure this program exists to name. */
  if (label.length !== 5) return 1 as i32;
  if (label !== "na\u0000me") return 2 as i32;
  /* The tail after the NUL is what a scanning copy loses entirely. */
  if (label.charCodeAt(3) !== 109) return 3 as i32;

  const present = spanLabelMaybe(1 as i32);
  if (present === null) return 4 as i32;
  if (present.length !== 5) return 5 as i32;

  /* Absence is a VALUE here: the callee answering NULL is an ordinary answer
   * rather than a contract it broke, which is the whole difference between
   * this binding and the one above. */
  if (spanLabelMaybe(-1 as i32) !== null) return 6 as i32;
  return 42 as i32;
}

exit(run());
