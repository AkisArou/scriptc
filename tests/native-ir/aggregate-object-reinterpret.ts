import type { Padded, f64, u8, u64 } from "@scriptc/native-abi-fixture";
import { paddedRoundtrip } from "@scriptc/native-abi-fixture";

const ordinaryObject = {
  tag: 7 as u8,
  value: 4277009102n as u64,
  ratio: 0.5 as f64,
};

paddedRoundtrip(ordinaryObject as Padded);
