/* A byte span the callee produced, copied into a managed `Uint8Array`.
 *
 * The one fact that is new: the length arrives BESIDE the pointer, in a slot
 * the compiler owns, where a string's NUL and a vector's terminator carried
 * it in-band. Everything else is the answered ownership question — copy into
 * managed storage, then dispose through the symbol the binding names.
 *
 * The fixture reverses, so the answer depends on order as well as content: a
 * copy that read the right bytes in the wrong place is a different wrong
 * answer from one that read the wrong bytes.
 */
import { bytesAbsent, bytesReverse, type i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function check(): number {
  let failures = 0;
  function ok(condition: boolean): void {
    if (!condition) failures = failures + 1;
  }

  /* A native call used DIRECTLY as a member-access receiver, which is
   * ordinary application code and used to fence: the external-host refusal
   * followed the callee to the declaration it came from and concluded the
   * value had no runtime implementation, when the frontend input had just
   * supplied one. */
  ok(bytesReverse(new Uint8Array([1, 2, 3, 250])).length === 4);
  ok(bytesReverse(new Uint8Array([5, 6]))[0] === 6);

  const out = bytesReverse(new Uint8Array([1, 2, 3, 250]));
  ok(out[0] === 250);
  ok(out[3] === 1);

  /* An empty span is a span, not an absence: the callee allocated something
   * the caller frees, and the answer has a length of zero rather than no
   * length. */
  const empty = bytesReverse(new Uint8Array([]));
  ok(empty.length === 0);

  /* An OFFSET view: the length slot must carry the view's extent, not the
   * buffer's, and the data pointer must start where the view does. A lowering
   * that passed the buffer start would answer 4 bytes reversed instead of 2. */
  const buffer = new Uint8Array([9, 8, 7, 6]);
  const view = buffer.subarray(1, 3);
  const reversed = bytesReverse(view);
  ok(reversed.length === 2);
  ok(reversed[0] === 7);
  ok(reversed[1] === 8);

  /* The managed span owns its bytes: the callee's storage is freed inside the
   * call, so anything still readable here was copied. Held across further
   * allocating calls so a use-after-free has something to land on. */
  const held = bytesReverse(new Uint8Array([11, 22, 33]));
  for (let i = 0; i < 8; i = i + 1) bytesReverse(new Uint8Array([1, 2, 3, 4, 5]));
  ok(held.length === 3);
  ok(held[0] === 33);
  ok(held[2] === 11);

  /* A callee answering NULL where the contract says a span. It is a contract
   * violation, so it is an error the program can catch — not a trap, and not
   * a silently empty span, which would make "absent" indistinguishable from
   * "no bytes". */
  let absentRejected = false;
  try {
    bytesAbsent();
  } catch {
    absentRejected = true;
  }
  ok(absentRejected);

  /* And the program keeps running afterwards, which is what makes it an
   * error rather than an abort. */
  ok(bytesReverse(new Uint8Array([4, 5])).length === 2);

  return failures;
}

exit(check() === 0 ? (42 as i32) : (1 as i32));
