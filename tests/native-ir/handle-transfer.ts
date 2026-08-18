/* A callee that takes ownership of a handle argument.
 *
 * The reference moves at the call: everything an explicit disposal does
 * happens to the cell — it stops naming the pointer, its owner edge and
 * children go — except the one part the transfer moved elsewhere, freeing the
 * object. The vault holds the only reference afterwards and can still read
 * it, and the handle this side held is spent, which is the same guarantee
 * `dispose()` gives and for the same reason: nothing here owns a reference
 * any more, so a use is a use-after-dispose rather than a stale pointer
 * crossing the boundary. */
import {
  createCounter,
  createVault,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

let failures = 0 as i32;

function check(condition: boolean): void {
  if (!condition) failures = (failures + (1 as i32)) as i32;
}

function rejects(action: () => void): boolean {
  try {
    action();
  } catch (error) {
    return error instanceof TypeError;
  }
  return false;
}

function runTransfer(): void {
  const vault = createVault();
  const counter = createCounter(7 as i32);
  check(counter.value() === (7 as i32));

  vault.adopt(counter);
  /* The object outlived the transfer; the vault holds it now. */
  check(vault.value() === (7 as i32));
  /* The handle did not: this side gave up its reference. */
  check(rejects(() => {
    check(counter.value() === (7 as i32));
  }));
  /* Twice over — a spent handle stays spent rather than transferring again. */
  check(rejects(() => {
    vault.adopt(counter);
  }));
  check(vault.value() === (7 as i32));
  vault.dispose();
}

runTransfer();

exit(failures === (0 as i32) ? (42 as i32) : (1 as i32));
