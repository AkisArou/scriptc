import { counterValueOr, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A handle type named ONLY by a slot that admits absence, and by nothing the
 * program ever holds. No counter is created, none is borrowed, and no method
 * is called on one — so every path that reaches the nominal type through a
 * source EXPRESSION is absent here, and the only thing left naming it is the
 * optional parameter itself.
 *
 * The neighbouring program passes null too, but it also creates a counter and
 * reads it, which marks the type through an ordinary expression and leaves
 * this path proven by accident. A framework binding is where the difference
 * shows: a lifecycle handler receives an optional object it hands straight
 * back without ever touching it. */
function run(): i32 {
  if (counterValueOr(null, 42 as i32) !== (42 as i32)) return 1 as i32;
  // Twice, so a first call that happened to work is not the whole evidence.
  if (counterValueOr(null, 7 as i32) !== (7 as i32)) return 2 as i32;
  return 42 as i32;
}

exit(run());
