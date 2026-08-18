import type { NestedPair32, Pair32, i32, i64 } from "@scriptc/native-abi-fixture";
import { nestedPair32Transform } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

const result = nestedPair32Transform({
  left: { first: 40 as i32, second: 2 as i32 } as Pair32,
  right: { first: 3 as i32, second: 4 as i32 } as Pair32,
  marker: 9n as i64,
} as NestedPair32);

exit(result.right.second);
