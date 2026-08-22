import { TickSource, tickMark } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* The incomplete platform contract this slice refuses, and the reason it
 * refuses rather than the fact that it does.
 *
 * An instance field needs a managed PEER to live in — a second object beside
 * the native one — and a peer needs a declared answer to what keeps it alive
 * and which platform event ends it. This test's TickSource selection states no
 * terminal event, so admitting the field would mean choosing that policy
 * silently. A platform that states the event takes the ordinary peer path. */
class Ticker extends TickSource {
  private taps = 0;

  override onTick(seed: i32): void {
    this.taps += 1;
    if (seed > (0 as i32)) tickMark();
  }
}

exit(42 as i32);
