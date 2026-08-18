/* The checked-number boundary: plain JavaScript numbers cross into exact
 * integer slots. Every conversion is checked at the boundary — finite,
 * integral, in range — and every failure is a catchable TypeError after which
 * execution continues. Results widen exactly, so ordinary arithmetic and
 * ordering work on what comes back. */
import {
  type NumberPair32,
  numberF32Identity,
  numberF64Identity,
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

function rejects(action: () => void): boolean {
  try {
    action();
  } catch {
    return true;
  }
  return false;
}

/* Happy conversions at the width edges, and -0 as integer zero. */
check(numberI32Identity(2147483647) === 2147483647);
check(numberI32Identity(-2147483648) === -2147483648);
check(numberU32Identity(4294967295) === 4294967295);
check(numberU8Identity(255) === 255);
check(numberI16Identity(-32768) === -32768);
check(numberI32Identity(-0) === 0);

/* The result is an ordinary number: arithmetic and ordering just work. */
const seven = numberI32Identity(7);
check(seven + 1 === 8);
check(seven < 100);
check(seven * 2 === 14);

/* Each failure class throws a catchable TypeError and leaves the program
 * running. Every invalid value is computed from a widened result rather than
 * spelled as a literal: a literal would be refused at compile time (see
 * number-literal-refused.ts), and the point here is to prove the runtime
 * check, not the constant fold. */
const zero = numberI32Identity(0);
const one = numberI32Identity(1);
check(rejects(() => {
  numberI32Identity(zero / zero);
}));
check(rejects(() => {
  numberI32Identity(one / zero);
}));
check(rejects(() => {
  numberI32Identity(-one / zero);
}));
check(rejects(() => {
  numberI32Identity(one + 0.5);
}));
check(rejects(() => {
  numberI32Identity(one * 2147483648);
}));
check(rejects(() => {
  numberI32Identity(one * -2147483649);
}));
check(rejects(() => {
  numberU32Identity(-one);
}));
check(rejects(() => {
  numberU8Identity(one * 256);
}));

/* A double slot is the same projection with nothing to convert: the source
 * value is already the representation the ABI wants, so every number
 * crosses — fractions and the infinities included. */
check(numberF64Identity(0.5) === 0.5);
check(numberF64Identity(one / zero) === Infinity);
check(numberF64Identity(-1.5) + 1.5 === 0);
check(numberF64Identity(zero / zero) !== numberF64Identity(zero / zero));

/* A 32-bit float slot is the one crossing in this family that is not exact.
 * Ingress rounds to nearest float, so a decimal that is not a float comes
 * back changed — visibly and by exactly the amount binary32 allows — while
 * egress is exact, because every float is a double. Values that ARE floats
 * round-trip untouched, and a magnitude past the float range rounds to an
 * infinity, which is what IEEE says and not what C's undefined conversion
 * would have left to the target. */
check(numberF32Identity(0.5) === 0.5);
check(numberF32Identity(-0.25) === -0.25);
check(numberF32Identity(16777216) === 16777216);
const rounded = numberF32Identity(0.1);
check(rounded !== 0.1);
check(rounded > 0.09999999 && rounded < 0.10000001);
check(numberF32Identity(one * 1e39) === Infinity);
check(numberF32Identity(-one * 1e39) === -Infinity);
check(numberF32Identity(zero / zero) !== numberF32Identity(zero / zero));

/* A struct with number-projected fields constructs from plain literals and
 * reads back as plain numbers. */
const transformed = numberPair32Transform({ first: 40, second: 2 } as NumberPair32);
check(transformed.first === 2);
check(transformed.second === 42);
check(transformed.first + transformed.second === 44);
check(transformed.first < transformed.second);

exit(failures === 0 ? (42 as i32) : (1 as i32));
