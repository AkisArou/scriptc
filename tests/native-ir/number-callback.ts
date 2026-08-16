/* A number-projected callback payload: the queued invocation stores the exact
 * i32 the emitter passed, and the delivery widens it to a plain number when it
 * reads the value back. The call-scoped flavor widens the same way without a
 * queue. Both handlers receive ordinary numbers and do ordinary arithmetic. */
import {
  callScopedFloat,
  callScopedNumber,
  subscribeNumber,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  callbacksWaitAndDispatch,
  exit,
} from "scriptc-native-test";

callbacksConfigure();
let failures = 0;

function check(condition: boolean): void {
  if (!condition) failures = failures + 1;
}

let received = -1;

/* The subscription handle lives inside a function so its managed cell is
 * released before exit, which the RC audit in the sanitized build checks. */
function runRetained(): void {
  const subscription = subscribeNumber((value): void => {
    /* A plain number: halving it would be impossible on an exact payload. */
    received = value / 2;
  });
  subscription.emit(84 as i32);
  callbacksWaitAndDispatch(1 as i32);
  subscription.dispose();
}

runRetained();
check(received === 42);
check(received < 100);
check(callbacksShutdown() === (1 as i32));

/* Call-scoped: the handler's parameter widens before the synchronous call. */
const answer = callScopedNumber((value): i32 => {
  check(value === 21);
  check(value + 1 === 22);
  return 42 as i32;
}, 21);
check(answer === 42);
check(answer / 2 === 21);

/* A 32-bit float payload widens the same way, and every float is a double,
 * so the handler sees exactly what the caller stored. The value passed in is
 * rounded on the way to the slot — 0.25 survives that untouched. */
const floated = callScopedFloat((value): i32 => {
  check(value === 0.25);
  check(value * 4 === 1);
  return 7 as i32;
}, 0.25);
check(floated === 7);

exit(failures === 0 ? (42 as i32) : (1 as i32));
