import type { Padded, f64, i32, u8, u64 } from "@scriptc/native-abi-fixture";
import { paddedRoundtrip } from "@scriptc/native-abi-fixture";
import { exit, verifyPadded } from "scriptc-native-test";

function roundtripAgain(value: Padded): Padded {
  return paddedRoundtrip(value);
}

const result = roundtripAgain({
  tag: 7 as u8,
  value: 4277009102n as u64,
  ratio: 0.5 as f64,
} as Padded);

if (!result) exit(1 as i32);
exit(verifyPadded(result, result.tag, result.value, result.ratio));
