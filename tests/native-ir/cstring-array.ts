/* A managed string array borrowed as the NUL-terminated `char **` a C API
 * expects.
 *
 * The vector is the CALL's, not the program's: the bytes belong to the managed
 * strings and outlive the call, so what gets built is the pointers alone and
 * what gets released afterwards is the same. The fixture answers
 * `total * 100 + count`, so a wrong pointer and a missing terminator are
 * different wrong answers rather than both being "not 0".
 *
 * Everything lives inside a function because `exit` is libc's: it runs the
 * reference audit from an atexit handler without unwinding module scope, so a
 * top-level array would still be live when the audit counts and would read as
 * a leak this code did not cause.
 */
import {
  cstringArrayMeasure,
  cstringArrayMeasureNamed,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function measure(): number {
  let failures = 0;

  function check(condition: boolean): void {
    if (!condition) failures = failures + 1;
  }

  /* Three strings, ten bytes. */
  check(cstringArrayMeasure(["one", "three", "to"]) === (1003 as i32));

  /* An empty array still crosses as a vector rather than as NULL: a C API
   * distinguishes "no strings" from "no array", and handing it the second
   * would say something the program did not. */
  check(cstringArrayMeasure([]) === (0 as i32));

  /* One element, so the terminator is the only thing separating a right answer
   * from reading past the end. */
  check(cstringArrayMeasure(["x"]) === (101 as i32));

  /* An array the program built at runtime, so nothing here is a literal the
   * emitter could have folded into a constant vector. */
  const built: string[] = [];
  for (let index = 0; index < 4; index = index + 1) {
    built.push("ab");
  }
  check(cstringArrayMeasure(built) === (804 as i32));

  /* The same array twice: the vector is per-call, so borrowing one must not
   * disturb the managed array that outlives it. */
  check(cstringArrayMeasure(built) === (804 as i32));
  check(built.length === 4);

  /* Strings the program still owns afterwards, which is what "borrowed" means:
   * releasing the vector releases the pointers, never the bytes. */
  const kept = ["hello", "world"];
  check(cstringArrayMeasure(kept) === (1002 as i32));
  check(kept[0] === "hello");
  check(kept[1]!.length === 5);

  /* A string carrying an embedded NUL has no `char *` form, so the borrow
   * fails and the call never runs. The half this exit status can see is that
   * the failure is a catchable throw; the half only the sanitized lane can see
   * is that the vector allocated before the bad element is freed on the way
   * out, since the release emitted beside the call never runs. */
  let embeddedNulRejected = false;
  try {
    cstringArrayMeasure(["ok", "a\0b", "also ok"]);
  } catch {
    embeddedNulRejected = true;
  }
  check(embeddedNulRejected);

  /* And the array survives the failure: the borrow owns only the vector, so
   * releasing it on the throwing path must not touch the strings. */
  check(kept[0] === "hello");
  check(cstringArrayMeasure(kept) === (1002 as i32));

  /* The ordering that would strand a vector: the array converts and allocates,
   * then the string beside it throws. The release emitted after the call is
   * not reached on this path and the unwind cannot see a raw allocation, so
   * the conversion has to do it — which only the sanitized lane can confirm. */
  check(cstringArrayMeasureNamed(["ab", "cd"], "xyz") === (405 as i32));
  let strandedRejected = false;
  try {
    cstringArrayMeasureNamed(["ab", "cd"], "x\0y");
  } catch {
    strandedRejected = true;
  }
  check(strandedRejected);

  return failures;
}

exit(measure() === 0 ? (42 as i32) : (1 as i32));
