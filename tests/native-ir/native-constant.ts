import {
  FixtureValue,
  i32Identity,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

exit(i32Identity(FixtureValue.answer));
