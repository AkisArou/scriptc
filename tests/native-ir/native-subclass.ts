import { TickSource, tickFire } from "@scriptc/native-abi-fixture";
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
 * `super.onTick(seed)` reaches the BASE implementation. It is a distinct
 * binding from the one the platform calls, which is what makes it static: were
 * it the same, it would redispatch to this override and never terminate. On
 * Android reaching the base is not optional — an Activity that skips
 * `super.onCreate` throws SuperNotCalled before it draws.
 *
 * `this` IS the native handle. With no managed fields there is no second
 * object, so the identity the handle cell already keeps is the whole of it. */
callbacksConfigure();

class Ticker extends TickSource {
  override onTick(seed: i32): void {
    // The base marks by `seed`, so what it did is observable from outside.
    super.onTick(seed);
    // And `this` reaches an inherited member, over the same object.
    super.onTick(this.value());
  }
}

function run(): i32 {
  /* Each fire resets the mark, runs the override, and the override reaches the
   * base twice: once with the seed, once with the receiver's own value, which
   * the fixture created FROM that seed. So a fire of 5 marks 10. */
  if (tickFire(5 as i32) !== (10 as i32)) return 1 as i32;
  if (tickFire(9 as i32) !== (18 as i32)) return 2 as i32;
  // Nothing owns the registration, so shutdown reports it still live.
  if (callbacksShutdown() !== (0 as i32)) return 3 as i32;
  return 42 as i32;
}

exit(run());
