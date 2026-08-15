import type { PairF64, f64 } from "@native-typescript/scabi-c-v1-fixture";
import { pairF64Transform, pairF64Verify } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

const result = pairF64Transform({
  first: 1.5 as f64,
  second: 2.5 as f64,
} as PairF64);

exit(pairF64Verify(result));
