import { expect, test } from "vitest";
import { sandboxHostSchedule } from "../../scripts/sandbox-platform.mjs";

const files = ["native-a.test.ts", "native-b.test.ts"];

test("Darwin runs native files and kqueue contracts locally", () => {
  expect(sandboxHostSchedule("darwin", files)).toEqual({
    darwinContracts: true,
    localInvariantFiles: files,
    remoteInvariantFiles: [],
  });
});

test("Linux runs its supported native files locally without Darwin contracts", () => {
  expect(sandboxHostSchedule("linux", files)).toEqual({
    darwinContracts: false,
    localInvariantFiles: files,
    remoteInvariantFiles: [],
  });
});

test("other hosts retain native-file coverage in Linux Sandboxes", () => {
  expect(sandboxHostSchedule("win32", files)).toEqual({
    darwinContracts: false,
    localInvariantFiles: [],
    remoteInvariantFiles: files,
  });
});
