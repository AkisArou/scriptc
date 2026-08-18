import {
  FixtureValue,
  i32Identity,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

const observed = i32Identity(FixtureValue.answer);
const expected = i32Identity(FixtureValue.answer);
const other = i32Identity(41 as i32);
const equal = observed === expected;
const different = observed !== other;

exit(equal && different ? observed : (1 as i32));
