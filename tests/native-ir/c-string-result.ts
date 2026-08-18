import {
  counterDestroyedCount,
  counterVerify,
  createCounter,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

function run(): i32 {
  const copied = createCounter(42 as i32).label();
  if (copied !== "native ✓") return 1 as i32;

  const absent = createCounter(0 as i32).label();
  if (absent !== null) return 2 as i32;

  const required = createCounter(42 as i32).requiredLabel();
  if (required !== "native ✓") return 3 as i32;

  const violating = createCounter(0 as i32);
  try {
    violating.requiredLabel();
    violating.dispose();
    return 4 as i32;
  } catch (error) {
    violating.dispose();
    if (
      error instanceof Error &&
      error.message ===
        "@scriptc/native-abi-fixture.Counter.requiredLabel returned null"
    ) {
      return counterVerify(
        0 as i32,
        counterDestroyedCount(),
        0 as i32,
        4 as i32,
      );
    }
    return 5 as i32;
  }
}

exit(run());
