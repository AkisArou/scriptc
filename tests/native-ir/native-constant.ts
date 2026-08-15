import {
  FixtureValue,
  i32Identity,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

exit(i32Identity(FixtureValue.answer));
