import { subscribe, type i32 } from "@scriptc/native-abi-fixture";
import {
  callbacksConfigureAttached,
  callbacksObserveAttached,
} from "scriptc-native-test";

callbacksConfigureAttached();

const subscription = subscribe((value): void => {
  callbacksObserveAttached(value);
  queueMicrotask((): void => {
    callbacksObserveAttached(42 as i32);
  });
});

subscription.emit(41 as i32);
