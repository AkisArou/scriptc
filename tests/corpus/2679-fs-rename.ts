// The three static rename spellings: synchronous throws, promises reject,
// and the error-first callback runs asynchronously with Error | null.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rename,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename as renamePromise } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rename-"));
const a = join(dir, "a.txt");
const b = join(dir, "b.txt");
const c = join(dir, "c.txt");
const d = join(dir, "d.txt");
const missing = join(dir, "missing.txt");
const other = join(dir, "other.txt");

writeFileSync(a, "alpha");
writeFileSync(b, "stale sync destination");
renameSync(a, b);
console.log("sync:", !existsSync(a), readFileSync(b, "utf8"));

const left = join(dir, "left");
const right = join(dir, "right");
const oldNested = join(left, "nested");
const newNested = join(right, "nested");
mkdirSync(left);
mkdirSync(right);
mkdirSync(oldNested);
renameSync(oldNested, newNested);
console.log("directory move:", !existsSync(oldNested), existsSync(newNested));
try {
  renameSync(missing, other);
} catch (e) {
  if (e instanceof Error) {
    const err = e as NodeJS.ErrnoException;
    console.log(
      "sync error:",
      err.code,
      err.message.includes("rename"),
      err.message.includes("missing.txt' -> '"),
      err.message.endsWith("other.txt'"),
    );
  }
}

async function run(): Promise<void> {
  writeFileSync(c, "stale promise destination");
  await renamePromise(b, c);
  console.log("promise:", !existsSync(b), readFileSync(c, "utf8"));
  try {
    await renamePromise(missing, other);
  } catch (e) {
    if (e instanceof Error) {
      console.log("promise error:", (e as NodeJS.ErrnoException).code, e.message.includes("rename"));
    }
  }

  let renameReturned = false;
  writeFileSync(d, "stale callback destination");
  rename(c, d, (err) => {
    console.log("callback:", renameReturned, err === null, !existsSync(c), readFileSync(d, "utf8"));
    rename(missing, other, (missingErr) => {
      console.log(
        "callback error:",
        missingErr?.code,
        missingErr?.message.includes("rename"),
        missingErr?.message.includes("missing.txt' -> '"),
      );
      rmSync(dir, { recursive: true, force: true });
    });
  });
  renameReturned = true;
}

void run();
