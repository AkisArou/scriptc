// Harness-only: the parent closes this program's stdout pipe while the wait
// holds us back, so writeSync must surface EPIPE through catch instead of
// letting SIGPIPE terminate the process.
import * as fs from "node:fs";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sleeper, 0, 0, 100);

try {
  console.error("write returned:", fs.writeSync(1, "probe\n"));
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error("caught:", err.name, err.code);
}
