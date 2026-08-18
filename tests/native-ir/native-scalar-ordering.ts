/* Ordering an exact native scalar. The comparison happens in the value's
 * own representation — no JavaScript-number conversion anywhere — so the
 * answers follow the declared width and signedness rather than what a
 * double would have said. The unsigned cases are the ones that prove it:
 * a `u32` whose bit pattern is all ones is the largest value of its type,
 * not −1, and only a signedness-aware compare gets that right. */
import {
  i32Identity,
  i64Identity,
  u32Identity,
  u64Identity,
  type i32,
  type i64,
  type u32,
  type u64,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0 as i32;

function check(condition: boolean): void {
  if (!condition) failures = (failures + (1 as i32)) as i32;
}

/* Signed 32-bit, including the width edges. */
const low = i32Identity(-2147483648 as i32);
const high = i32Identity(2147483647 as i32);
const zero = i32Identity(0 as i32);
check(low < zero);
check(low <= zero);
check(high > zero);
check(high >= zero);
check(!(zero < low));
check(!(high <= zero));
check(low <= low);
check(high >= high);

/* Unsigned 32-bit: the all-ones pattern is the maximum, not a negative. */
const max32 = u32Identity(4294967295 as u32);
const one32 = u32Identity(1 as u32);
check(one32 < max32);
check(max32 > one32);
check(!(max32 < one32));

/* 64-bit values keep their BigInt carrier and order at full width, past
 * anything a double could distinguish. */
const bigA = i64Identity(9007199254740993n as i64);
const bigB = i64Identity(9007199254740992n as i64);
check(bigB < bigA);
check(bigA > bigB);
check(i64Identity(-9223372036854775808n as i64) < bigB);
const maxU64 = u64Identity(18446744073709551615n as u64);
check(u64Identity(1n as u64) < maxU64);
check(!(maxU64 < u64Identity(1n as u64)));

exit(failures === (0 as i32) ? (42 as i32) : (1 as i32));
