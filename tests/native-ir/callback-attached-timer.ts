import { subscribe, type i32 } from "@scriptc/native-abi-fixture";
import {
  callbacksConfigureAttachedTimer,
  callbacksObserveAttached,
} from "scriptc-native-test";

callbacksConfigureAttachedTimer();

const subscription = subscribe((value): void => {
  callbacksObserveAttached(value);
  queueMicrotask((): void => {
    callbacksObserveAttached(42 as i32);
  });
});

setTimeout((): void => {
  callbacksObserveAttached(43 as i32);
}, 50);
subscription.emit(41 as i32);
