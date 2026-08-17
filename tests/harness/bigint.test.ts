import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const runtime = join(repoRoot, "packages/runtime/src");
const fixture = join(repoRoot, "tests/runtime/bigint.c");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-bigint-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each([false, true])("runtime bigint, sanitize=%s", (sanitize) => {
  test.skipIf(process.platform === "win32")(
    "adds, subtracts, multiplies, compares, and formats past every fixed width",
    () => {
      const binary = join(scratch, sanitize ? "bigint-san" : "bigint-plain");
      execFileSync("clang", [
        "-std=c11",
        "-O1",
        "-g",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        ...(sanitize ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : []),
        "-I",
        runtime,
        join(runtime, "scr_bigint.c"),
        fixture,
        "-o",
        binary,
        // ldexp/frexp/floor for the double crossings.
        "-lm",
      ]);
      expect(execFileSync(binary, { encoding: "utf8" })).toBe("bigint: ok\n");
    },
    30_000,
  );
});
