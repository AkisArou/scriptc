/* Tier 1 of the numeric model: a literal argument to a checked-number
 * parameter is proven where it is written, so the boundary check disappears
 * from the generated code entirely. Every spelling folds to the same double
 * before the emitter sees it, so hex, exponent, and a signed zero are proven
 * exactly like a plain decimal is. The harness asserts the absence of the
 * conversion helper in the emitted translation unit; this program asserts the
 * constants still arrive intact. */
import {
  numberI16Identity,
  numberI32Identity,
  numberU8Identity,
  numberU32Identity,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0;

function check(condition: boolean): void {
  if (!condition) failures = failures + 1;
}

/* Plain decimals, including both width edges. */
check(numberI32Identity(7) === 7);
check(numberI32Identity(-2147483648) === -2147483648);
check(numberI32Identity(2147483647) === 2147483647);
check(numberU32Identity(4294967295) === 4294967295);

/* Non-decimal spellings fold before lowering, so they are proven too. */
check(numberU8Identity(0xff) === 255);
check(numberI32Identity(1e3) === 1000);
check(numberI16Identity(0b101) === 5);
check(numberI32Identity(1_000_000) === 1000000);

/* A negative zero converts to zero, matching the runtime check's rule. */
check(numberI32Identity(-0) === 0);

/* The widened results are ordinary numbers regardless of how they arrived. */
check(numberI32Identity(20) + numberI32Identity(22) === 42);
check(numberI16Identity(-32768) < 0);

exit(failures === 0 ? (42 as i32) : (1 as i32));
