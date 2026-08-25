import {
  createFrameCounter,
  createFrameCounterMaybe,
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
    if (counter.value() !== (40 as i32)) return 9 as i32;
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

function discarded(): i32 {
  frameResourceReset();
  createFrameCounter(42 as i32);
  if (frameGlobalPromotions() !== (0 as i32)) return 60 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 61 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(0 as i32)) return 62 as i32;
  return 0 as i32;
}

function nestedBorrowed(): i32 {
  frameResourceReset();
  if (createFrameCounter(40 as i32).add(2 as i32) !== (42 as i32)) {
    return 63 as i32;
  }
  if (frameGlobalPromotions() !== (0 as i32)) return 64 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 65 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(0 as i32)) return 66 as i32;
  return 0 as i32;
}

function nullableNonEscapingPresent(): i32 {
  frameResourceReset();
  {
    const counter = createFrameCounterMaybe(40 as i32);
    if (counter === null) return 30 as i32;
    if (counter.add(2 as i32) !== (42 as i32)) return 31 as i32;
  }
  if (frameGlobalPromotions() !== (0 as i32)) return 32 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 33 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(0 as i32)) return 34 as i32;
  return 0 as i32;
}

function nullableNonEscapingAbsent(): i32 {
  frameResourceReset();
  {
    const counter = createFrameCounterMaybe(-1 as i32);
    if (counter !== null) return 40 as i32;
  }
  if (frameGlobalPromotions() !== (0 as i32)) return 41 as i32;
  if (frameLocalReleases() !== (0 as i32)) return 42 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(0 as i32)) return 43 as i32;
  return 0 as i32;
}

function nullableEscaping(): i32 {
  frameResourceReset();
  {
    const counter = createFrameCounterMaybe(41 as i32);
    if (counter === null) return 50 as i32;
    const retained = [counter];
    if (retained[0]!.add(1 as i32) !== (42 as i32)) return 51 as i32;
  }
  if (frameGlobalPromotions() !== (1 as i32)) return 52 as i32;
  if (frameLocalReleases() !== (1 as i32)) return 53 as i32;
  if (frameManagedCells() !== frameExpectedManagedCells(1 as i32)) return 54 as i32;
  return 0 as i32;
}

const local = nonEscaping();
if (local !== (0 as i32)) exit(local);
const stable = escaping();
if (stable !== (0 as i32)) exit(stable);
const ignored = discarded();
if (ignored !== (0 as i32)) exit(ignored);
const nested = nestedBorrowed();
if (nested !== (0 as i32)) exit(nested);
const nullablePresent = nullableNonEscapingPresent();
if (nullablePresent !== (0 as i32)) exit(nullablePresent);
const nullableAbsent = nullableNonEscapingAbsent();
if (nullableAbsent !== (0 as i32)) exit(nullableAbsent);
const nullableStable = nullableEscaping();
exit(nullableStable === (0 as i32) ? (42 as i32) : nullableStable);
