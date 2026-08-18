import {
  FixtureValue,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

const combined = FixtureValue.combine(
  32 as i32,
  8 as i32,
  2 as i32,
);

exit(combined);
