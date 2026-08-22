import { Host, hostOutstanding, hostRun } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { callbacksConfigure, exit } from "scriptc-native-test";

/* An instance FIELD on a class whose base is native.
 *
 * This is the observer for the peer, written before the peer exists. What it
 * asks is the only thing that matters about the design: does state written in
 * one lifecycle dispatch survive to the next one on the same object?
 *
 * It cannot be answered by interning. The host declares `identity: "none"` —
 * the arm a JVM handle declares, because `NewGlobalRef` twice on one object
 * returns two distinct references and the specification forbids comparing them
 * — so the two dispatches arrive as two distinct managed cells. A peer kept on
 * the cell would be rebuilt for the second dispatch and the field would read
 * zero. Only something stored on the FOREIGN OBJECT can carry it across, which
 * is what the peer slot is.
 *
 * The number is the discriminator rather than a boolean: a surviving peer
 * reports the seed, a rebuilt one reports 0, and a peer that was never
 * associated reports -1 because the fixture never heard from the handler at
 * all. Three outcomes, three distinct values, so a failure says which of them
 * happened instead of only that something did. */
callbacksConfigure();

class Widget extends Host {
  private taps: i32 = 0 as i32;

  override onOpen(seed: i32): void {
    this.taps = seed;
  }

  override onSettle(): void {
    this.report(this.taps);
  }
}

function run(): i32 {
  if (hostRun(5 as i32) !== (5 as i32)) return 1 as i32;
  // A second run is a NEW object, so its peer must start clean rather than
  // inheriting the first one's — the same rule a recreated Activity follows.
  if (hostRun(9 as i32) !== (9 as i32)) return 2 as i32;
  // The terminal dispatch must also cut the registration root. Correct field
  // identity with a peer that leaked past both platform objects is not the
  // lifecycle policy this feature promises.
  if (hostOutstanding() !== (0 as i32)) return 3 as i32;
  return 42 as i32;
}

exit(run());
