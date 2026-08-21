/* A registration nothing in the program owns, travelling every layer.
 *
 * This is the shape a framework dispatch takes when the PLATFORM constructs
 * the receiver: there is no instance to anchor a registration to at the moment
 * one could be made, so the owner is the process and the receiver arrives as
 * an ordinary payload.
 *
 * It exists because each layer's own test proved only its own arm. The
 * validator had a hand-built module, the translator had a manifest, and
 * materialization — which turns a manifest binding into IR — had neither, so
 * a contract that validated and translated still met an internal error one
 * layer further in. Only a program that travels all of them at once reaches
 * the next unexercised layer.
 */
import {
  counterDestroyedCount,
  noticeFire,
  noticeMark,
  noticeWith,
  type Counter,
  type i32,
} from "@scriptc/native-abi-fixture";
import {
  callbacksConfigure,
  callbacksShutdown,
  exit,
} from "scriptc-native-test";

callbacksConfigure();

let firstFailure = 0 as i32;
let checkIndex = 0 as i32;

function check(condition: boolean): void {
  checkIndex = (checkIndex + (1 as i32)) as i32;
  if (!condition && firstFailure === (0 as i32)) firstFailure = checkIndex;
}

/* Registered once and never cancelled: nothing owns it, so there is no handle
 * to hold and no disposal to call. The mark is conditional on the payload
 * being a usable cell, so one observation carries both facts. */
noticeWith((subject: Counter): void => {
  if (subject.add(2 as i32) === (42 as i32)) noticeMark();
});

/* The fixture reads its mark after invoking, so 1 is synchronous delivery and
 * 0 would be a handler that had not run yet. */
check(noticeFire(40 as i32) === (1 as i32));
check(noticeFire(40 as i32) === (1 as i32));
/* Shutdown reports that a registration is STILL LIVE, and that is the arm's
 * defining property rather than a leak. Nothing owns this registration, so
 * nothing cancels it: it outlives every instance because the class does, and
 * the service cannot destroy itself while it stands. An owner-scoped
 * registration answers 1 here because its receiver's disposal took it away. */
check(callbacksShutdown() === (0 as i32));
/* Two invocations, two subjects, two releases — a payload reference never
 * given back would show here. */
check(counterDestroyedCount() === (2 as i32));

exit(firstFailure === (0 as i32) ? (42 as i32) : firstFailure);
