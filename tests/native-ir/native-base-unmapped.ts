import { UnmappedSource, tickMark } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* A base the native surface DECLARES and maps no handle type to.
 *
 * This is what a selection that dropped a type looks like from the program's
 * side, and the program is not what is wrong — a person reading the source
 * finds a class extending a class, exactly as the platform documents it. The
 * fix is in the packaging, so the diagnostic names the surface.
 *
 * Until this refused, the class fell through to ordinary collection and
 * compiled in SILENCE: no registration was emitted, the override was never
 * reached, and the first sign of trouble was an undefined symbol from a
 * support file naming nothing to do with the cause. A class that overrides
 * nothing while claiming to override something is exactly the partial
 * projection `docs/architecture.md` forbids. */
class Ticker extends UnmappedSource {
  override onTick(seed: i32): void {
    if (seed > (0 as i32)) tickMark();
  }
}

exit(42 as i32);
