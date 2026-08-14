import { i32Identity, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

exit(i32Identity(42 as i32));

