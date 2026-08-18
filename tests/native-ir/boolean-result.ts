import {
  nativeFalse,
  nativeInvalidBoolean,
  nativeNot,
  nativeTrue,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function invalidBooleanThroughCaller(): boolean {
  return nativeInvalidBoolean();
}

let invalidRejected = false;
try {
  invalidBooleanThroughCaller();
} catch {
  invalidRejected = true;
}

if (
  nativeTrue() &&
  !nativeFalse() &&
  nativeNot(false) &&
  !nativeNot(true) &&
  invalidRejected
) {
  exit(42 as i32);
} else {
  exit(0 as i32);
}
