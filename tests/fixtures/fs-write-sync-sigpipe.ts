// Harness-only: the parent either closes this program's stdout pipe while the
// wait holds us back (current-offset EPIPE), or leaves it open while a
// positioned write proves the pipe's ESPIPE name/text normalization.
import * as fs from "node:fs";

const positioned = process.argv.length > 2 && process.argv[2] === "positioned";
if (!positioned) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, 100);
}

try {
  if (positioned) {
    console.error("write returned:", fs.writeSync(1, "probe\n", 0));
  } else {
    console.error("write returned:", fs.writeSync(1, "probe\n"));
  }
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (positioned) {
    console.error("caught:", err.name, err.code, err.message);
  } else {
    console.error("caught:", err.name, err.code);
  }
}
