// Static three-argument fs/promises.writeFile: utf8's string and object
// spellings, creation mode (which does not re-apply to existing files),
// and syscall failures delivered as promise rejections.
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-fsp-write-"));
const encoded = join(dir, "encoded.txt");
const modeFile = join(dir, "mode.txt");

await writeFile(encoded, "first", "utf-8");
await writeFile(encoded, "second", { encoding: "utf8" });
console.log("encoded:", readFileSync(encoded, "utf8"));

await writeFile(modeFile, "created", { mode: 0o600, encoding: "utf-8" });
accessSync(modeFile, constants.W_OK);
await writeFile(modeFile, "rewritten", { mode: 0o400 });
accessSync(modeFile, constants.W_OK);
console.log("mode:", readFileSync(modeFile, "utf8"));

try {
  const rejected = writeFile(join(dir, "missing", "file.txt"), "x", { mode: 0o600 });
  console.log("promise returned");
  await rejected;
  console.log("no rejection");
} catch (e) {
  if (e instanceof Error) {
    console.log("rejected:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("open"));
  }
}

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
