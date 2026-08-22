import { sharedAcquire, tokenAcquire, tokenOutstanding } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A handle whose identity arm is `none`, and what that means to a program.
 *
 * The runtime interns a cell by foreign pointer only when the type says its
 * identity IS the pointer. A JVM handle says otherwise, because `NewGlobalRef`
 * called twice on one object returns two distinct `jobject`s and the
 * specification forbids comparing references with `==`. So the arm is not a
 * missing optimisation: it is the statement that this platform's references
 * cannot answer "same object", and the runtime must not pretend they can.
 *
 * The fixture hands out ONE object twice, which is what makes the difference
 * observable. Under `pointer` the second acquisition would find the first
 * cell and every assertion below would read differently — so this program
 * fails against the wrong arm rather than passing under both. */
function run(): i32 {
  const first = tokenAcquire();
  const second = tokenAcquire();

  /* The arm's USER-VISIBLE meaning: two arrivals of one object are two
   * managed values, so `===` is false here where the platform's own equality
   * would be true. Someone will meet this and think it a bug, which is why it
   * is asserted as semantics rather than left implicit in the count below. */
  if (first === second) return 1 as i32;
  // The negated spelling lowers too, and a cell is equal to itself.
  if (!(first !== second)) return 7 as i32;
  if (first !== first) return 8 as i32;
  // The same object underneath, which is what makes two values surprising.
  if (first.value() !== (7 as i32)) return 2 as i32;
  if (second.value() !== (7 as i32)) return 3 as i32;
  /* Two references really were taken. Without this the arm could be satisfied
   * by a runtime that skipped the lookup and shared one reference anyway,
   * which would double-release at the end. */
  if (tokenOutstanding() !== (2 as i32)) return 4 as i32;

  /* Each cell owns ITS OWN reference and gives back exactly that one. This is
   * the half that matters where interning is off: one cell releasing twice,
   * or one never releasing, is the defect this arm invites and the one a leak
   * discovered elsewhere would never point back to. */
  first.dispose();
  if (tokenOutstanding() !== (1 as i32)) return 5 as i32;
  second.dispose();
  if (tokenOutstanding() !== (0 as i32)) return 6 as i32;

  /* THE CONTRAST, over the same C object under `identity: "pointer"`. The arm
   * is the only difference between these two types, so this is what stops the
   * assertions above passing for a comparison that answered constantly: here
   * the second acquisition finds the first cell, the two values ARE equal, and
   * interning hands the extra reference straight back. */
  const shared = sharedAcquire();
  const again = sharedAcquire();
  if (shared !== again) return 9 as i32;
  if (tokenOutstanding() !== (1 as i32)) return 10 as i32;
  shared.dispose();
  if (tokenOutstanding() !== (0 as i32)) return 11 as i32;

  return 42 as i32;
}

exit(run());
