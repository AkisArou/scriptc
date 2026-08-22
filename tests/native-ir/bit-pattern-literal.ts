import { numberI32Identity, numberU32Identity } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A bit pattern that fills a signed slot from the top.
 *
 * `0xFF000000` is the colour every Android program writes, and as a decimal
 * quantity it is 4278190080 — which no i32 holds. It is not out of range; it
 * is written from the other end, and the slot is the same width either way.
 * Refusing it taught `| 0`, a spelling that means "reinterpret" and reads as
 * arithmetic.
 *
 * The line between the two readings is the RADIX SPELLING, which is where
 * Java's own grammar puts it for the same slot: `int x = 0xFF000000;` compiles
 * and means -16777216, while `int x = 4278190080;` does not compile at all.
 * Binary and octal say the same thing about bits, so they are admitted too.
 *
 * An unsigned slot needs none of this: there the bits ARE the value the
 * literal states, and it was already proven before this rule is asked. */
function run(): i32 {
  // Opaque black: the top bit set, which is the whole point.
  if (numberI32Identity(0xFF000000) !== -16777216) return 1 as i32;
  // Every radix that names bits, not just hex.
  if (numberI32Identity(0b11111111000000000000000000000000) !== -16777216) return 2 as i32;
  if (numberI32Identity(0o37700000000) !== -16777216) return 3 as i32;
  // All ones is -1, the reading that makes the rule a rule rather than a case.
  if (numberI32Identity(0xFFFFFFFF) !== -1) return 4 as i32;
  // Below the halfway point nothing changes: it was always in range.
  if (numberI32Identity(0x7F000000) !== 2130706432) return 5 as i32;
  /* The same bits in an UNSIGNED slot stay positive, because there the value
   * the literal states is a value the slot holds. */
  if (numberU32Identity(0xFF000000) !== 4278190080) return 6 as i32;
  return 42 as i32;
}

exit(run());
