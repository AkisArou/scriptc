/* The discriminating half of the bit-pattern rule. The SAME value the hex
 * spelling names is refused when written as a decimal quantity, because the
 * two spellings say different things: `0xFF000000` names bits that fill the
 * slot, `4278190080` names a number no i32 holds. Java draws the line in the
 * same place for the same slot — the hex form compiles, the decimal form is
 * "integer number too large" — and a rule that admitted both would be us
 * deciding what the program meant. This must not build. */
import { numberI32Identity, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

exit(numberI32Identity(4278190080) === -16777216 ? (0 as i32) : (1 as i32));
