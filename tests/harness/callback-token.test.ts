import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const runtime = join(repoRoot, "packages/runtime/src");
const fixture = join(repoRoot, "tests/runtime/callback-token.c");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-callback-token-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(["none", "address", "thread"] as const)(
  "retained callback token, sanitizer=%s",
  (sanitizer) => {
    const unsupported =
      process.platform === "win32" || (sanitizer === "thread" && process.platform !== "linux");
    test.skipIf(unsupported)(
      "linearizes close with admission and releases every invocation lease",
      () => {
        const binary = join(scratch, `token-${sanitizer}`);
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
          fixture,
          "-o",
          binary,
        ]);
        expect(execFileSync(binary, { encoding: "utf8" })).toBe("callback token: ok\n");
      },
      30_000,
    );
  },
);
