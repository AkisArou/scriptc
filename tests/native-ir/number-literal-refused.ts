/* The other half of tier 1: a literal the boundary can never accept. 256 is
 * outside every `u8`, so this call has exactly one possible outcome — a
 * TypeError — and a program with only one outcome is a defect the compiler
 * reports rather than a runtime failure it defers. This must not build. */
import { numberU8Identity, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

exit(numberU8Identity(256) === 256 ? (0 as i32) : (1 as i32));
