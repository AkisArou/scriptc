/* The named operations on an exact scalar: division, remainder, and the two
 * shifts, plus the conversions to and from an ordinary number. They are
 * functions rather than operators because TypeScript types arithmetic over a
 * branded number as a plain number — an operator expression could not carry
 * the exact type even if the lowering wanted it to — and because no syntax
 * could name a conversion's direction.
 *
 * Every case C leaves undefined is a case the operands can reach and the
 * width cannot answer, so it throws a catchable RangeError instead. */
import {
  f64,
  i32,
  i64,
  u32,
  u64,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

let failures = 0 as i32;

function check(condition: boolean): void {
  if (!condition) failures = (failures + (1 as i32)) as i32;
}

/* An operation with no answer is a RangeError: the operands have the type it
 * asked for and it is their values that leave nothing to return. */
function rejects(action: () => void): boolean {
  try {
    action();
  } catch (error) {
    return error instanceof RangeError;
  }
  return false;
}

/* A value that cannot cross into a slot is a TypeError, the same answer the
 * checked boundary gives — it is the kind of the value that is wrong for the
 * destination, not the result of a computation. */
function rejectsIngress(action: () => void): boolean {
  try {
    action();
  } catch (error) {
    return error instanceof TypeError;
  }
  return false;
}

/* Division truncates toward zero, exactly as the C it lowers to. */
check(i32.div(7 as i32, 2 as i32) === (3 as i32));
check(i32.div(-7 as i32, 2 as i32) === (-3 as i32));
check(i32.rem(-7 as i32, 2 as i32) === (-1 as i32));
check(u32.div(4294967295 as u32, 2 as u32) === (2147483647 as u32));

/* The signed minimum has no quotient over -1 at its width, so the division
 * throws — but its remainder is 0, which does fit, so that answers. */
check(rejects(() => {
  i32.div(-2147483648 as i32, -1 as i32);
}));
check(i32.rem(-2147483648 as i32, -1 as i32) === (0 as i32));
check(rejects(() => {
  i32.div(1 as i32, 0 as i32);
}));
check(rejects(() => {
  i32.rem(1 as i32, 0 as i32);
}));

/* Shifts neither mask the count nor reinterpret it: a count at or past the
 * width has no meaning and throws. */
check(i32.shl(1 as i32, 31 as i32) === (-2147483648 as i32));
check(i32.shr(-8 as i32, 2 as i32) === (-2 as i32));
check(i32.shr(-1 as i32, 31 as i32) === (-1 as i32));
check(u32.shr(2147483648 as u32, 31 as u32) === (1 as u32));
check(rejects(() => {
  i32.shl(1 as i32, 32 as i32);
}));
check(rejects(() => {
  i32.shl(1 as i32, -1 as i32);
}));

/* 64-bit values divide and shift at their own width, past anything a double
 * could distinguish. */
check(i64.div(9007199254740993n as i64, 2n as i64) === (4503599627370496n as i64));
check(i64.rem(9007199254740993n as i64, 2n as i64) === (1n as i64));
check(i64.shl(1n as i64, 62n as i64) === (4611686018427387904n as i64));
check(rejects(() => {
  i64.div(-9223372036854775808n as i64, -1n as i64);
}));

/* Egress up to 32 bits is total: every value of the slot is a double. */
check(i32.toNumber(-2147483648 as i32) === -2147483648);
check(u32.toNumber(4294967295 as u32) === 4294967295);
check(i32.toNumber(7 as i32) / 2 === 3.5);
check(`${i32.toNumber(42 as i32)}` === "42");

/* Egress at 64 bits answers only when the double denotes the same integer.
 * 2^60 is exactly a double, so it crosses; 2^60 + 1 is not, so it throws
 * rather than handing back a number one away from the truth. */
check(i64.toNumber(1152921504606846976n as i64) === 1152921504606846976);
check(i64.toNumber(-9007199254740991n as i64) === -9007199254740991);
check(rejects(() => {
  i64.toNumber(1152921504606846977n as i64);
}));
check(rejects(() => {
  u64.toNumber(18446744073709551615n as u64);
}));

/* Ingress is the same check the boundary performs, reached by name. */
check(i32.fromNumber(42) === (42 as i32));
check(i64.fromNumber(1000000000000000000) === (1000000000000000000n as i64));
check(rejectsIngress(() => {
  i32.fromNumber(2147483648);
}));
check(rejectsIngress(() => {
  i32.fromNumber(1.5);
}));
check(i32.toNumber(i32.fromNumber(-5)) === -5);

/* A branded double converts in both directions without converting anything:
 * the slot is the number. */
check(f64.toNumber(0.5 as f64) === 0.5);
check(f64.fromNumber(1.5) === (1.5 as f64));
check(f64.toNumber(f64.fromNumber(-0.25)) === -0.25);

exit(failures === (0 as i32) ? (42 as i32) : (1 as i32));
