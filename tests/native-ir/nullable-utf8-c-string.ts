import { nullableCStringObserve, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

function selected(present: boolean): string | null {
  return present ? "native" : null;
}

const directNull = nullableCStringObserve(null);
const directString = nullableCStringObserve("native");
const unionString = nullableCStringObserve(selected(true));
const unionNull = nullableCStringObserve(selected(false));

exit(
  directNull === 1 as i32 &&
      directString === 2 as i32 &&
      unionString === 2 as i32 &&
      unionNull === 1 as i32
    ? 42 as i32
    : 0 as i32,
);
