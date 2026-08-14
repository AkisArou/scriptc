import { subscribe, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import {
  callbacksActive,
  callbacksConfigure,
  callbacksShutdown,
  callbacksWaitAndDrain,
  exit,
  verifyRetained,
} from "scriptc-native-test";

callbacksConfigure();

let total = 0 as i32;
const subscription = subscribe((value): void => {
  total = (total + value) as i32;
});

subscription.emit(5 as i32);
callbacksWaitAndDrain(1 as i32);
subscription.emitForeign(37 as i32);
callbacksWaitAndDrain(2 as i32);
const activeBefore = callbacksActive();

subscription.dispose();
const activeAfter = callbacksActive();
const shutdown = callbacksShutdown();
exit(verifyRetained(total, activeBefore, activeAfter, shutdown));
