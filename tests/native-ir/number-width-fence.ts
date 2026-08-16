/* The width fence: a number projection over a 64-bit slot must refuse to
 * compile. An f64 carries at most 53 bits of integer injectively, so widening
 * an i64 would silently lose precision — the binding is structurally invalid
 * and this program must never build. */
import { numberI64Identity, type i32 } from "@native-typescript/scabi-c-v1-fixture";
import { exit } from "scriptc-native-test";

exit(numberI64Identity(1) === 1 ? (0 as i32) : (1 as i32));
