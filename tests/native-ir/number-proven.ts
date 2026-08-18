/* Tier 2 of the numeric model: the boundary check disappears wherever the
 * number facts already know the value fits. Every crossing below is proven
 * by a different route — a widened result fed back, a struct field read, a
 * callback payload, a guarded value, a loop induction — and the harness
 * asserts that the emitted translation unit contains no conversion helper
 * at all. The values are the assertions: a wrong proof would convert a
 * value the slot cannot hold and the arithmetic below would notice. */
import {
  callScopedNumber,
  type NumberPair32,
  numberI16Identity,
  numberI32Identity,
  numberPair32Transform,
  numberU8Identity,
  numberU32Identity,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0;

function check(condition: boolean): void {
  if (!condition) failures = failures + 1;
}

/* A widened result is inside the slot it was read from, so feeding it
 * straight back needs nothing checked. The width edges are the interesting
 * ones: they are exactly the values a wrong interval would drop. */
const low = numberI32Identity(-2147483648);
const high = numberI32Identity(2147483647);
check(numberI32Identity(low) === -2147483648);
check(numberI32Identity(high) === 2147483647);
check(numberU32Identity(numberU32Identity(4294967295)) === 4294967295);

/* A number-projected field read carries the same fact as a result. */
const pair = numberPair32Transform({ first: 40, second: 2 } as NumberPair32);
check(numberI32Identity(pair.second) === 42);
check(numberI32Identity(pair.first) === 2);

/* A guard is a proof: inside the branch the value cannot leave the range
 * the comparison established, so a narrower slot accepts it. */
const measured = numberI32Identity(200);
if (measured >= 0 && measured <= 255) {
  check(numberU8Identity(measured) === 200);
}
if (measured > -32768 && measured < 32767) {
  check(numberI16Identity(measured) === 200);
}

/* A loop induction is whole and bounded by its own condition. */
let total = 0;
for (let index = 0; index < 10; index = index + 1) {
  total = total + numberU8Identity(index);
}
check(total === 45);

/* A callback payload arrives widened from the exact slot the trampoline
 * stored, so passing it on is another free crossing. */
const answer = callScopedNumber((value): i32 => {
  check(numberI32Identity(value) === 21);
  return 42 as i32;
}, 21);
check(answer === 42);

exit(failures === 0 ? (42 as i32) : (1 as i32));
