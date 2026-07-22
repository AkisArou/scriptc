// lstatSync (the no-follow stat), Stats.isSymbolicLink()/mtimeMs, and
// the mkdir lock idiom (RouteStore's acquireLock): mkdirSync as an
// atomic try-lock whose EEXIST is a catchable errno error, staleness
// judged through statSync(...).mtimeMs. Timing facts are BOUNDED (the
// mtime is recent, not an exact tick), so the output is deterministic.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-lstat-"));
writeFileSync(join(dir, "target.txt"), "pointed-at");

// A symlink, made with ln -s (symlinkSync has no lowering yet).
execFileSync("ln", ["-s", join(dir, "target.txt"), join(dir, "link")], { stdio: "pipe" });
const viaStat = statSync(join(dir, "link")); // follows
const viaLstat = lstatSync(join(dir, "link")); // does not
console.log("stat follows:", viaStat.isFile(), viaStat.isSymbolicLink(), viaStat.size);
console.log("lstat sees the link:", viaLstat.isSymbolicLink(), viaLstat.isFile());
console.log("plain file:", lstatSync(join(dir, "target.txt")).isSymbolicLink());
try {
  lstatSync(join(dir, "nope"));
} catch (e) {
  if (e instanceof Error) {
    console.log("lstat missing:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("lstat"));
  }
}

// mtimeMs: a fresh file's mtime is recent (within the last hour) and not
// in the future (a minute of clock skew allowed) — bounded facts.
const now = Date.now();
const mtime = statSync(join(dir, "target.txt")).mtimeMs;
console.log("mtime sane:", now - mtime < 3600_000, mtime <= now + 60_000);

// The lock idiom: mkdirSync succeeds once, then throws catchable EEXIST;
// the holder's staleness reads through statSync(...).mtimeMs.
const lockPath = join(dir, "routes.lock");
function tryLock(): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST") {
      const heldFor = Date.now() - statSync(lockPath).mtimeMs;
      console.log("held, fresh:", heldFor < 10_000);
      return false;
    }
    throw e;
  }
}
console.log("first lock:", tryLock());
console.log("second lock:", tryLock());
rmSync(lockPath, { recursive: true });
console.log("relock after release:", tryLock());

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
