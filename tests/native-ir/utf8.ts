import { hashUtf8 } from "@scriptc/native-abi-fixture";
import { exit, verifyUtf8Hash } from "scriptc-native-test";

let evaluations = 0;

function value(): string {
  evaluations++;
  return evaluations === 1 ? "A\0é🙂" : "";
}

exit(verifyUtf8Hash(hashUtf8(value())));
