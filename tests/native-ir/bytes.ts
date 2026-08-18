import { hashBytes } from "@scriptc/native-abi-fixture";
import { exit, verifyBytesHash } from "scriptc-native-test";

let evaluations = 0;

function value(): Uint8Array {
  evaluations++;
  if (evaluations !== 1) return new Uint8Array([0]);

  const owner = new Uint8Array([0xff, 0x41, 0x00, 0x00, 0xa9, 0xf0, 0x9f, 0x99, 0x82, 0xee]);
  const view = owner.subarray(1, 9);
  owner[3] = 0xc3;
  return view;
}

exit(verifyBytesHash(hashBytes(value())));
