import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const runtime = join(repoRoot, "packages/runtime/src");
const fixture = join(repoRoot, "tests/runtime/owner-gateway.c");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-owner-gateway-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each([false, true])("runtime owner gateway, sanitize=%s", (sanitize) => {
  test.skipIf(process.platform === "win32")(
    "preserves producer FIFO, lifecycle, and exact event ownership",
    () => {
      const binary = join(scratch, sanitize ? "gateway-san" : "gateway-plain");
      execFileSync("clang", [
        "-std=c11",
        "-O1",
        "-g",
        "-Wall",
        "-Wextra",
        "-Werror",
        // Existing runtime documentation spells a pointer pair as
        // `*pem/*len`, which Clang diagnoses as a nested comment.
        "-Wno-comment",
        "-pedantic",
        "-pthread",
        ...(sanitize ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : []),
        "-I",
        runtime,
        join(runtime, "scr_owner_gateway.c"),
        fixture,
        "-o",
        binary,
      ]);
      expect(execFileSync(binary, { encoding: "utf8" })).toBe("owner gateway: ok\n");
    },
    30_000,
  );
});
