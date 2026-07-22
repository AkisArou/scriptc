// fs.watch: "change" on a rewrite-in-place, "rename" when the name moves,
// the synchronous ENOENT throw (the polling-fallback catch shape), close()
// idempotence, and loop liveness (an open watcher holds the process; the
// program exits once every watcher closes). Each phase closes on its FIRST
// event — kqueue and FSEvents coalesce differently, so exact event counts
// are deliberately unobserved.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-"));
const target = join(dir, "watched.txt");
fs.writeFileSync(target, "seed");

// The unopenable path throws Node's fs error NOW, synchronously.
try {
  fs.watch(join(dir, "missing.txt"));
  console.log("no throw");
} catch (e) {
  if (e instanceof Error) {
    console.log("throws ENOENT:", e.message.startsWith("ENOENT: no such file or directory, watch"));
  }
}

// Phase 2 (started from phase 1's close): the name disappearing delivers
// "rename" to a zero-parameter listener; the FSWatcher | null local is
// the portless watcher shape.
let renameWatcher: fs.FSWatcher | null = null;
function startRenamePhase(): void {
  const mover = join(dir, "mover.txt");
  fs.writeFileSync(mover, "m");
  renameWatcher = fs.watch(mover, () => {
    console.log("rename phase fired");
    if (renameWatcher) {
      renameWatcher.close();
      renameWatcher.close(); // idempotent, like Node
      renameWatcher = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("all closed");
  });
  setTimeout(() => {
    fs.rmSync(mover);
  }, 30);
}

// Phase 1: a rewrite-in-place delivers "change" with the event type.
let changeWatcher: fs.FSWatcher | null = null;
changeWatcher = fs.watch(target, (eventType) => {
  console.log("event:", eventType);
  if (changeWatcher) {
    changeWatcher.close();
    changeWatcher = null;
    startRenamePhase();
  }
});
console.log("watching");
setTimeout(() => {
  fs.appendFileSync(target, "-more");
}, 30);
