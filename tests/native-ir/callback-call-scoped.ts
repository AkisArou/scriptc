import type { i32 } from "@native-typescript/scabi-c-v1-fixture";
import { callScoped } from "@native-typescript/scabi-c-v1-fixture";
import { exit, verifyCallScoped } from "scriptc-native-test";

const captured = 42 as i32;
const forwarded = callScoped((value) => value, 42 as i32);
const fromCapture = callScoped((_value) => captured, 0 as i32);

exit(verifyCallScoped(forwarded, fromCapture));
