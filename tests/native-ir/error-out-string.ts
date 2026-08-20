/* A failable call whose result is an owned string.
 *
 * The failure arrives in a slot and reads nothing, so the result is free to
 * mean something — which is the whole reason the error-out contract exists.
 * What has to be true is an ORDERING: the unwind precedes both the copy and
 * the release, so on the failing path neither runs.
 *
 * The fixture makes that observable rather than merely asserted. On failure it
 * answers a dangling non-null pointer, so a lowering that copied before
 * unwinding would read unmapped memory and one that released before unwinding
 * would free a pointer it never owned. Both are crashes under the sanitizer
 * rather than wrong answers, which is the point of choosing that value.
 */
import { errorOutLabel, fixtureErrorsOutstanding, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function check(): number {
  let failures = 0;
  function ok(condition: boolean): void {
    if (!condition) failures = failures + 1;
  }

  /* Success: the bytes are copied, then the pointer is freed through the
   * symbol the binding names. */
  ok(errorOutLabel(7 as i32) === "code7");
  ok(errorOutLabel(0 as i32) === "code0");

  /* Failure: the slot is non-null, so the call throws before the result is
   * looked at. The message comes from the error object, which is released. */
  let threw = false;
  try {
    errorOutLabel(-1 as i32);
  } catch {
    threw = true;
  }
  ok(threw);

  /* And the error object did not survive its own message. */
  ok(fixtureErrorsOutstanding() === (0 as i32));

  /* Enough of each that a leak or a double free is a pattern rather than a
   * coincidence, and interleaved so neither path can clean up after the
   * other. */
  for (let i = 0; i < 16; i = i + 1) {
    ok(errorOutLabel(7 as i32) === "code7");
    try {
      errorOutLabel(-1 as i32);
    } catch {
      /* expected */
    }
  }
  ok(fixtureErrorsOutstanding() === (0 as i32));

  return failures;
}

exit(check() === 0 ? (42 as i32) : (1 as i32));
