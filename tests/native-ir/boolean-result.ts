import {
  nativeFalse,
  nativeInvalidBoolean,
  nativeTrue,
  type i32,
} from "@native-typescript/scabi-c-v1-fixture";
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

if (nativeTrue() && !nativeFalse() && invalidRejected) {
  exit(42 as i32);
} else {
  exit(0 as i32);
}
