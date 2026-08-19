/* A NUL-terminated vector the callee produced, copied into a managed
 * `string[]`.
 *
 * The copy is what makes the result independent of the callee's storage, and
 * the two shapes prove it from opposite sides: a borrowed vector the receiver
 * keeps must survive being read twice, and an owned one must be freed through
 * the symbol the binding names — with the copy already made, so nothing the
 * program keeps points into memory the release just reclaimed.
 *
 * Everything is inside a function because `exit` is libc's: the reference
 * audit runs from an atexit handler without unwinding module scope.
 */
import {
  createCounter,
  cstringArrayMade,
  cstringMade,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function check(): number {
  let failures = 0;

  function ok(condition: boolean): void {
    if (!condition) failures = failures + 1;
  }

  /* Borrowed. The receiver keeps the vector, so reading it twice is the same
   * vector and neither read may free it. */
  const counter = createCounter(0 as i32);
  const first = counter.tags();
  ok(first.length === 3);
  ok(first[0] === "alpha");
  ok(first[2] === "gamma");
  const second = counter.tags();
  ok(second.length === 3);
  ok(second[1] === "beta");
  /* The copies are independent of each other and of the vector: mutating one
   * managed array says nothing about the next read. */
  first.push("delta");
  ok(first.length === 4);
  ok(counter.tags().length === 3);
  counter.dispose();

  /* Owned. The elements are copied before the named symbol frees the vector,
   * so these strings outlive storage that is already gone. */
  const made = cstringArrayMade(3 as i32);
  ok(made !== null);
  if (made !== null) {
    ok(made.length === 3);
    ok(made[0] === "s0");
    ok(made[2] === "s2");
  }

  /* Empty is a vector, not an absence: the terminator is at slot zero. */
  const empty = cstringArrayMade(0 as i32);
  ok(empty !== null);
  if (empty !== null) ok(empty.length === 0);

  /* Absent is not empty. A negative count answers NULL, and the projection
   * says so as a value rather than as a failure. */
  ok(cstringArrayMade(-1 as i32) === null);

  /* One element instead of many, and the same question afterwards: the bytes
   * are copied into managed storage, then the pointer is freed through the
   * symbol the binding names. What survives cannot point into what is gone. */
  const owned = cstringMade(4 as i32);
  ok(owned === "abcd");
  ok(cstringMade(0 as i32) === "");
  ok(cstringMade(-1 as i32) === null);
  /* Held past several more calls, so a use-after-free would have something to
   * land on rather than reading storage nothing else has claimed yet. */
  const held = cstringMade(6 as i32);
  for (let i = 0; i < 8; i = i + 1) cstringMade(12 as i32);
  ok(held === "abcdef");

  /* Read it enough times that a leaked vector or a double free would be a
   * pattern rather than a coincidence — the sanitized lane is what sees it. */
  let total = 0;
  for (let i = 0; i < 32; i = i + 1) {
    const batch = cstringArrayMade(4 as i32);
    if (batch !== null) total = total + batch.length;
  }
  ok(total === 128);

  return failures;
}

exit(check() === 0 ? (42 as i32) : (1 as i32));
