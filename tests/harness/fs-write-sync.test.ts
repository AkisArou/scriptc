/* fs.writeSync contracts that need harness control over the native process's
 * descriptors. The ordinary byte/error behavior stays in differential corpus
 * 2685; this test controls stdout's pipe state to pin EPIPE/SIGPIPE and
 * positioned-write ESPIPE behavior. */
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
    test("stdout pipe writes preserve EPIPE and ESPIPE", async () => {
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

      const run = async (args: string[], closeStdout: boolean) => {
        const child = spawn(result.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr!.on("data", (chunk: string) => {
          stderr += chunk;
        });
        if (closeStdout) child.stdout!.destroy();
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        });
        return { outcome, stdout, stderr };
      };

      const current = await run([], true);
      expect(current.outcome).toEqual({ code: 0, signal: null });
      expect(current.stderr).toBe("caught: Error EPIPE\n");

      const positioned = await run(["positioned"], false);
      expect(positioned.outcome).toEqual({ code: 0, signal: null });
      expect(positioned.stdout).toBe("");
      expect(positioned.stderr).toBe("caught: Error ESPIPE ESPIPE: invalid seek, write\n");
    });
  },
);
