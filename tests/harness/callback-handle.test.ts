import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");
const runtime = join(repoRoot, "packages/runtime/src");
const fixture = join(repoRoot, "tests/runtime/callback-handle.c");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-callback-handle-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(["none", "address", "thread"] as const)(
  "retained callback native owners, sanitizer=%s",
  (sanitizer) => {
    const unsupported =
      process.platform === "win32" || (sanitizer === "thread" && process.platform !== "linux");
    test.skipIf(unsupported)(
      "preserves explicit-cancel leases and collects receiver-owned cycles",
      () => {
        const binary = join(scratch, `handle-${sanitizer}`);
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
          join(runtime, "scr_callback_handle.c"),
          join(runtime, "scr_native_handle.c"),
          join(runtime, "scr_cycle.c"),
          fixture,
          "-o",
          binary,
        ]);
        expect(execFileSync(binary, { encoding: "utf8" })).toBe("callback handle: ok\n");
      },
      30_000,
    );
  },
);
