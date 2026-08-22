import {
  createFrameCounter,
  frameExpectedManagedCells,
  frameGlobalPromotions,
  frameLocalReleases,
  frameManagedCells,
  frameResourceReset,
  type i32,
} from "@scriptc/native-abi-fixture";
import { exit } from "scriptc-native-test";

/* The first resource-specialization observer has two arms that cannot agree
 * accidentally. The first value is used only by synchronous borrowed native
 * calls and must never become a stable managed handle. The second enters a
 * managed array, so it escapes the foreign frame and must retain today's
 * stable path. Counts describe resource operations, not generated spelling or
 * elapsed time. */
function nonEscaping(): i32 {
  frameResourceReset();
  {
    const counter = createFrameCounter(40 as i32);
    if (counter.add(2 as i32) !== (42 as i32)) return 10 as i32;
  }
  if (frameGlobalPromotions() !== (0 as i32)) return 11 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 12 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(0 as i32)) return 13 as i32;
  return 0 as i32;
}

function escaping(): i32 {
  frameResourceReset();
  {
    const counter = createFrameCounter(41 as i32);
    const retained = [counter];
    if (retained[0]!.add(1 as i32) !== (42 as i32)) return 20 as i32;
  }
  if (frameGlobalPromotions() !== (1 as i32)) return 21 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 22 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(1 as i32)) return 23 as i32;
  return 0 as i32;
}

const local = nonEscaping();
if (local !== (0 as i32)) exit(local);
const stable = escaping();
exit(stable === (0 as i32) ? (42 as i32) : stable);
