/* The answer-as-a-field shape, both directions.
 *
 * A C predicate with an out-parameter answers two things at once: whether it
 * worked, and what it found. Flattened into one record, the answer becomes a
 * field read as C's own truth test while the value beside it is read as an
 * ordinary number — two readings of two int32 slots in one struct.
 *
 * The reading is the TOTAL one: nonzero is true, and nothing here can throw.
 * That is what a C predicate means, and it is why a field read stays a field
 * read rather than becoming a call site with a check after it.
 */
import {
  type Answered,
  answeredAbove,
  answeredRaw,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0;

function check(condition: boolean): void {
  if (!condition) failures = failures + 1;
}

/* The answer and the value are independent: a false answer still hands back
 * what it looked at, which is the whole reason this shape exists. */
const above = answeredAbove(7 as i32, 3 as i32);
check(above.answered);
check(above.value === 7);

const below = answeredAbove(2 as i32, 3 as i32);
check(!below.answered);
check(below.value === 2);

/* The answer is an ordinary boolean, so it composes like one. */
check(above.answered && !below.answered);
check((above.answered ? 1 : 0) + (below.answered ? 1 : 0) === 1);

/* Writing is the inverse of reading: constructing with `true` stores the
 * canonical 1 that the same truth test reads back. */
check(answeredRaw({ answered: true, value: 5 } as Answered) === (1 as i32));
check(answeredRaw({ answered: false, value: 5 } as Answered) === (0 as i32));
check(({ answered: true, value: 9 } as Answered).answered);

/* The value beside the answer is an ordinary number, widened exactly out of
 * its slot, so it does arithmetic without being converted back first. */
check(above.value + below.value === 9);
check(above.value > below.value);

/* A second crossing, so the field survives a real call rather than only a
 * construction the emitter could have folded away. */
const equal = answeredAbove(3 as i32, 3 as i32);
check(!equal.answered);
check(equal.value === 3);

exit(failures === 0 ? (42 as i32) : (1 as i32));
