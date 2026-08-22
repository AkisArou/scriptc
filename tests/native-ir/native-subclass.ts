import { TickSource, tickFire, tickMark } from "@scriptc/native-abi-fixture";
import type { i32 } from "@scriptc/native-abi-fixture";
import { callbacksConfigure, callbacksShutdown, exit } from "scriptc-native-test";

/* A TypeScript class whose base is a NATIVE class — the program shape
 * `docs/native-subclassing.md` specifies, and the one a person writes for a
 * platform whose application model is subclass-based.
 *
 * Nothing here constructs a Ticker. The fixture does, the way a framework
 * does, and calls the override on it — which is why the registration is
 * anchored to the CLASS and the receiver arrives as `this` rather than as an
 * argument the program threads through.
 *
 * `this` IS the native handle. With no managed fields there is no second
 * object to associate, so the identity the handle cell already keeps is the
 * whole of it — and an instance field is exactly what would introduce the
 * peer whose lifetime this platform has not declared. */
callbacksConfigure();

class Ticker extends TickSource {
  override onTick(seed: i32): void {
    /* `this` reaches an inherited native member, which is the property that
     * makes the base real rather than decorative. */
    if (this.value() === seed) tickMark();
  }
}

function run(): i32 {
  // Fired twice, so a single lucky delivery is distinguishable.
  if (tickFire(5 as i32) !== (1 as i32)) return 1 as i32;
  if (tickFire(9 as i32) !== (1 as i32)) return 2 as i32;
  // Nothing owns the registration, so shutdown reports it still live.
  if (callbacksShutdown() !== (0 as i32)) return 3 as i32;
  return 42 as i32;
}

exit(run());
