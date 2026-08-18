/* A number over a 64-bit or pointer-width slot.
 *
 * Writing one is checked exactly as every narrower width is: a double that is
 * finite, whole, and inside the slot's range converts exactly however wide the
 * slot is, so the ingress does not care about 2^53 at all.
 *
 * Reading one is the direction that can fail, and it fails by the round trip
 * rather than by a bound — 2^60 IS a double, so refusing it would be refusing
 * an exact answer. Only a value the double does not denote throws, and it
 * throws rather than handing back a number one away from the truth. */
import {
  numberI64Identity,
  numberUsizeIdentity,
  wideToNumber,
  type i32,
  type i64,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0;

function check(condition: boolean): void {
  if (!condition) failures = failures + 1;
}

function rejects(action: () => void, kind: "range" | "type"): boolean {
  try {
    action();
  } catch (error) {
    return kind === "range"
      ? error instanceof RangeError
      : error instanceof TypeError;
  }
  return false;
}

let sink = 0;

/* Every refusal below is computed. A literal the compiler can disprove is a
 * compile error where it is written, not a call that could only throw, so a
 * fixture that means to reach the runtime check has to hide the value from
 * the constant folder. */
const one = numberUsizeIdentity(1);
const two = one + one;

/* An ordinary size crosses both ways and stays an ordinary number. */
check(numberUsizeIdentity(0) === 0);
check(numberUsizeIdentity(4096) === 4096);
check(numberUsizeIdentity(4096) / 2 === 2048);
check(numberI64Identity(-1) === -1);

/* Every double that is a whole number in range converts, however wide. 2^60
 * is one of them: sparse among the integers, but exactly a double. */
check(numberI64Identity(1152921504606846976) === 1152921504606846976);

/* The ingress is checked at this width for the same reasons as at 32. */
check(rejects(() => { sink = numberI64Identity(one / two); }, "type"));
check(rejects(() => { sink = numberUsizeIdentity(one - two); }, "type"));
check(rejects(() => { sink = numberI64Identity((one - one) / (one - one)); }, "type"));

/* The egress answers when the double denotes the same integer... */
check(wideToNumber(1152921504606846976n as i64) === 1152921504606846976);
check(wideToNumber(-9007199254740991n as i64) === -9007199254740991);
/* ...and throws when it does not, rather than being one away. */
check(rejects(() => { sink = wideToNumber(9007199254740993n as i64); }, "range"));
check(rejects(() => {
  sink = wideToNumber(9223372036854775807n as i64);
}, "range"));

exit(failures === 0 ? (42 as i32) : (1 as i32));
