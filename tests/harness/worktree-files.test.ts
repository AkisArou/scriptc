import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { filterExistingWorktreePaths } from "../../scripts/worktree-files.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("archive path filtering omits unstaged deletions across stream chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-worktree-files-"));
  roots.push(root);
  writeFileSync(join(root, "kept.ts"), "");
  writeFileSync(join(root, "blocking"), "");

  const input = Readable.from([
    Buffer.from("ke"),
    Buffer.from("pt.ts\0deleted.ts\0block"),
    Buffer.from("ing/child.ts\0"),
  ]);
  const chunks: Buffer[] = [];
  for await (const chunk of input.pipe(filterExistingWorktreePaths(root))) {
    chunks.push(Buffer.from(chunk));
  }

  expect(Buffer.concat(chunks)).toEqual(Buffer.from("kept.ts\0"));
});
