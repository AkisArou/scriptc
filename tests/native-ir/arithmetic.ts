import { type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

const added = ((2147483647 as i32) + (43 as i32)) as i32;
const subtracted = (added - (-2147483648 as i32)) as i32;
const multiplied = ((2147483647 as i32) * (2 as i32)) as i32;
const product = (multiplied * (-21 as i32)) as i32;
const combined = (subtracted + product) as i32;

exit((combined - (42 as i32)) as i32);
