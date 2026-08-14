import {
  i8Identity,
  u8Identity,
  i16Identity,
  u16Identity,
  i32Identity,
  u32Identity,
  type i8,
  type u8,
  type i16,
  type u16,
  type i32,
  type u32,
} from "@native-typescript/scabi-c-v1-fixture";
import { exit, verifyNarrowIntegers } from "scriptc-native-test";

exit(
  verifyNarrowIntegers(
    i8Identity(-128 as i8),
    u8Identity(255 as u8),
    i16Identity(-32768 as i16),
    u16Identity(65535 as u16),
    i32Identity(-2147483648 as i32),
    u32Identity(4294967295 as u32),
  ),
);
