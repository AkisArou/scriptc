// Static fs/promises.open and FileHandle: defaults, shared close state,
// current-offset/positioned reads and writes, whole-file operations, stat,
// Buffer identity in result records, and rejection behavior.
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-2686-${process.pid}.txt`);
const missing = path.join(os.tmpdir(), `scr-2686-missing-${process.pid}.txt`);
fs.writeFileSync(scratch, "abcdef");

async function main(): Promise<void> {
  const handle = await open(scratch, "r+");
  const alias = handle;
  console.log("open:", handle.fd >= 0, alias.fd === handle.fd);

  const first = Buffer.alloc(3);
  const firstResult = await handle.read(first);
  console.log("read current:", firstResult.bytesRead, firstResult.buffer === first, first.toString());

  const positioned = Buffer.alloc(2);
  const positionedResult = await handle.read(positioned, 0, 2, 4);
  console.log("read positioned:", positionedResult.bytesRead, positioned.toString());

  const stringResult = await handle.write("XY");
  console.log("write string:", stringResult.bytesWritten, stringResult.buffer);
  const source = Buffer.from("QZ");
  const bytesResult = await handle.write(source, 0, 2, 1);
  console.log("write bytes:", bytesResult.bytesWritten, bytesResult.buffer === source);

  console.log("readFile current:", await handle.readFile("utf8"));
  const stats = await handle.stat();
  console.log("stat:", stats.isFile(), stats.size);

  await alias.close();
  console.log("closed:", handle.fd, alias.fd);
  await handle.close();
  console.log("closed twice:", handle.fd);
  try {
    await handle.readFile("utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("closed rejection:", err.name, err.code, err.message);
  }

  const writer = await fs.promises.open(scratch, "w+");
  await writer.writeFile("hello", "utf-8");
  await writer.appendFile(Buffer.from("!"));
  const all = Buffer.alloc(6);
  const allResult = await writer.read(all, null, null, 0);
  console.log("whole writes:", allResult.bytesRead, all.toString());
  try {
    await writer.read(Buffer.alloc(1), 0, -1, 0);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("explicit length:", err.name, err.code);
  }
  await writer.close();

  const defaults = await open(scratch);
  const bytes = await defaults.readFile();
  console.log("defaults:", bytes.toString(), defaults.fd >= 0);
  await defaults.close();

  try {
    await open(missing);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("open rejection:", err.name, err.code);
  }

  fs.unlinkSync(scratch);
}

void main();
