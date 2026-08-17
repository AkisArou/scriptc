/* A retained callback the native side ASKS rather than tells. It is
 * registered once and invoked during the emitting call, and the value it
 * answers with is that call's result — the shape every gboolean-returning
 * toolkit signal has, where a handler says whether it consumed an event and
 * cannot say so after the event is gone.
 *
 * Nothing here is queued: the assertions after each ask see the answer and
 * the handler's writes immediately, which is the whole difference from the
 * delivered flavor. */
import { askFor, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  exit,
} from "scriptc-native-test";

callbacksConfigure();

let failures = 0 as i32;
let seen = 0 as i32;

function check(condition: boolean): void {
  if (!condition) failures = (failures + (1 as i32)) as i32;
}

/* The registration handle lives inside a function so its managed cell is
 * released before exit, which the RC audit in the sanitized build checks. */
function runAnswers(): void {
  const asker = askFor((value): i32 => {
    /* The handler runs inside the call below, so a write here is visible to
     * the line after it. */
    seen = value;
    return (value + (1 as i32)) as i32;
  });

  check(asker.ask(41 as i32) === (42 as i32));
  check(seen === (41 as i32));
  check(asker.ask(-1 as i32) === (0 as i32));
  check(seen === (-1 as i32));
  check(asker.asked() === (2 as i32));
  asker.dispose();
}

runAnswers();
check(callbacksShutdown() === (1 as i32));

exit(failures === (0 as i32) ? (42 as i32) : (1 as i32));
