import { makeNested, useNested } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A handle type whose declaration name is DOTTED, which is how a platform's
 * inner class projects: `View$OnClickListener` spelled `View.OnClickListener`.
 *
 * A nested class lives on the VALUE side of its owner's merged symbol, so
 * reading the owner's instance type finds no such property and the type
 * resolves to nothing. The failure then surfaces far from its cause — as a
 * parameter mapping to 'unknown' at whatever binding takes one, which on the
 * platform is `setOnClickListener`.
 *
 * Both positions are exercised, because they fail together and a fix could
 * plausibly reach only one: the type as a RESULT, and the type as the
 * PARAMETER that first reported the problem. */
function run(): i32 {
  const nested = makeNested(7 as i32);
  return useNested(nested) !== (7 as i32) ? (1 as i32) : (42 as i32);
}

exit(run());
