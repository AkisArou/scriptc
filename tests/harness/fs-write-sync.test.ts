/* fs.writeSync contracts that need harness control over the native process's
 * descriptors. The ordinary byte/error behavior stays in differential corpus
 * 2685; this test closes the stdout pipe before the write to pin SIGPIPE. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(process.platform === "win32")(
  `fs.writeSync descriptor errors${sanitize ? " (sanitized)" : ""}`,
  () => {
    test("a closed stdout pipe throws EPIPE instead of terminating with SIGPIPE", async () => {
      const outDir = join(cacheDir, `fs-write-sync${sanitize ? "-san" : ""}`);
      const result = await compile(join(repoRoot, "tests/fixtures/fs-write-sync-sigpipe.ts"), {
        outPath: join(outDir, "sigpipe"),
        outDir,
        sanitize,
        backend: "c",
      });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }

      const child = spawn(result.binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.destroy();
      child.stderr!.setEncoding("utf8");
      let stderr = "";
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });

      expect(outcome).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("caught: Error EPIPE\n");
    });
  },
);
