/* Synchronous delivery holding an OBJECT, in both of its forms.
 *
 * The pair is the point. Handle payloads were reachable on the queued path and
 * synchronous delivery was reachable with exact scalars, so two complete lists
 * agreed while the shape they imply — a handler running inside the caller's
 * frame with a managed cell in its hands — was reachable from neither.
 *
 * Each subject is created per invocation and arrives OWNED: the reference
 * crosses with the payload and the handler's cell is what gives it back. That
 * is the only spelling a JNI local reference has once promoted, which is why
 * this shape rather than a borrowed one. */
import {
  counterDestroyedCount,
  judgeWith,
  tellMark,
  tellWith,
  type Counter,
  type i32,
} from "@scriptc/native-abi-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  exit,
} from "scriptc-native-test";

callbacksConfigure();

/* Reports WHICH check failed rather than how many, so a backend that differs
 * says where. */
let checkIndex = 0 as i32;
let firstFailure = 0 as i32;

function check(condition: boolean): void {
  checkIndex = (checkIndex + (1 as i32)) as i32;
  if (!condition && firstFailure === (0 as i32)) firstFailure = checkIndex;
}

/* Registrations live inside functions so their cells are released before the
 * destroyed count is read. */
function runTold(): void {
  /* The mark is conditional on the payload being usable, so one observation
   * carries both facts: a raw pointer has no `add` to call, and a handler that
   * had not run yet leaves the count at zero. The fixture reads its mark AFTER
   * invoking, which is what makes queued delivery distinguishable. */
  const teller = tellWith((subject: Counter): void => {
    if (subject.add(2 as i32) === (42 as i32)) tellMark();
  });
  check(teller.tell(40 as i32) === (1 as i32));
  teller.dispose();
}

/* The `onKeyDown` shape: answers a boolean while holding both a scalar and an
 * object. The answer is the emitting call's result, so a late delivery would
 * answer with the fixture's own zero rather than the handler's verdict. */
function runAsked(): void {
  const judge = judgeWith((code: i32, subject: Counter): boolean =>
    subject.add(code) === (50 as i32)
  );
  check(judge.ask(8 as i32, 42 as i32) === (1 as i32));
  check(judge.ask(1 as i32, 42 as i32) === (0 as i32));
  judge.dispose();
}

runTold();
runAsked();
check(callbacksShutdown() === (1 as i32));

/* Three invocations, three subjects, three releases. This is what would catch
 * a payload reference that was never given back — and the sanitizer lane is
 * what would catch one given back twice. */
check(counterDestroyedCount() === (3 as i32));

exit(firstFailure === (0 as i32) ? (42 as i32) : firstFailure);
