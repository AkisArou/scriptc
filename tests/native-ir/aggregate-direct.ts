import type { Pair32, i32 } from "@scriptc/native-abi-fixture";
import { pair32Transform } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

const result = pair32Transform({
  first: 40 as i32,
  second: 2 as i32,
} as Pair32);

exit(result.second);
