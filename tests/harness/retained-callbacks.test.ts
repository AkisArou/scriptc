import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const runtime = join(repoRoot, "packages/runtime/src");
const fixture = join(repoRoot, "tests/runtime/retained-callbacks.c");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-retained-callbacks-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(["none", "address", "thread"] as const)(
  "retained callback instance service, sanitizer=%s",
  (sanitizer) => {
    const unsupported =
      process.platform === "win32" || (sanitizer === "thread" && process.platform !== "linux");
    test.skipIf(unsupported)(
      "roots closures, delivers foreign payloads, and fences reentrant shutdown",
      () => {
        const binary = join(scratch, `retained-${sanitizer}`);
        execFileSync("clang", [
          "-std=c11",
          "-O1",
          "-g",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wno-comment",
          "-pedantic",
          "-pthread",
          ...(sanitizer === "address"
            ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
            : sanitizer === "thread"
              ? ["-fsanitize=thread", "-fno-omit-frame-pointer"]
              : []),
          "-I",
          runtime,
          join(runtime, "scr_owner_gateway.c"),
          join(runtime, "scr_callback_token.c"),
          join(runtime, "scr_callback_table.c"),
          join(runtime, "scr_retained_callbacks.c"),
          fixture,
          "-o",
          binary,
        ]);
        expect(execFileSync(binary, { encoding: "utf8" })).toBe("retained callbacks: ok\n");
      },
      30_000,
    );
  },
);
