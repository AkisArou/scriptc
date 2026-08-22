import { tokenAcquire, tokenOutstanding } from "@scriptc/native-abi-fixture";
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

  /* The user-visible half — that `first === second` is FALSE where the
   * platform's own equality is true — cannot be written yet: comparing two
   * native handles is SC1043, unsupported. So this program asserts the arm
   * through the reference count instead, and the comparison is recorded in
   * docs/open-work.md as the thing that would state it directly. It matters
   * beyond this test: `this === this` across two lifecycle dispatches is the
   * assertion the peer slice needs, and it is not expressible either. */
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

  return 42 as i32;
}

exit(run());
