import { subscribe, type i32 } from "@scriptc/native-abi-fixture";
import {
  callbacksActive,
  callbacksConfigure,
  callbacksShutdown,
  callbacksWaitAndDispatch,
  exit,
  verifyRetained,
} from "scriptc-native-test";

callbacksConfigure();
let total = 0 as i32;

function run(): i32 {
  total = 0 as i32;
  const subscription = subscribe((value): void => {
    total = (total + value) as i32;
    queueMicrotask((): void => {
      total = (total * (2 as i32)) as i32;
    });
  });

  subscription.emit(5 as i32);
  callbacksWaitAndDispatch(1 as i32);
  subscription.emitForeign(37 as i32);
  callbacksWaitAndDispatch(2 as i32);
  const activeBefore = callbacksActive();

  subscription.dispose();
  const activeAfter = callbacksActive();
  const shutdown = callbacksShutdown();
  return verifyRetained(total, activeBefore, activeAfter, shutdown);
}

exit(run());
