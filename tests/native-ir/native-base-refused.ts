import { NativeCounter } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A TypeScript class whose base is a NATIVE class. `docs/native-subclassing.md`
 * makes exactly this the public API for a platform whose application model is
 * subclass-based, so it is what a person writes first — and until the peer's
 * lifetime policy is declared, what they get back has to say which of two
 * things they are looking at.
 *
 * Before this refusal existed the message was "extending classes not declared
 * in the program", which is true of the base's TypeScript declaration and
 * sends the reader hunting for a missing import that is already there. */
class Derived extends NativeCounter {}

function run(): i32 {
  const derived = new Derived(1 as i32);
  return derived === null ? (1 as i32) : (42 as i32);
}

exit(run());
