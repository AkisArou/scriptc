import { FixtureValue, numberI32Identity } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A constant whose manifest type is an exact integer, DECLARED as `number`.
 *
 * This is the only spelling a generated surface can use. Type mapping runs
 * from the underlying primitive — `number` to f64, `bigint` to i64 — and a
 * brand does not change it, so a platform's `jint` is `number` however the
 * generator spells it. Requiring the declared type to equal the manifest's
 * therefore admitted every double constant and refused every integer one,
 * which is not a rule anyone chose: the manifest is right that the class file
 * says int, and TypeScript has no spelling that maps to i32.
 *
 * What makes it admissible is exact representability, asked through the same
 * predicate the widening rules ask, so a constant and a payload cannot come to
 * different conclusions about which integers a double carries.
 *
 * The value therefore arrives as a NUMBER and crosses the checked boundary
 * like any other, which is what a program that declared it `number` asked
 * for. `FixtureValue.answer` beside it is the exact spelling, unchanged. */
function run(): i32 {
  if (numberI32Identity(FixtureValue.count) !== 17) return 1 as i32;
  /* The exact spelling keeps its own branch and its own program: reaching
   * `i32Identity` here as well would put two bindings on one C symbol in one
   * module, which the validator refuses by name. */
  /* Arithmetic on it is ordinary number arithmetic, because that is what the
   * declaration says it is — no exact-integer operator is involved. */
  if (numberI32Identity(FixtureValue.count + 3) !== 20) return 3 as i32;
  return 42 as i32;
}

exit(run());
