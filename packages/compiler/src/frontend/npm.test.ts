import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { NpmGraphBuilder } from "./npm.js";

const appDir = resolve("virtual-npm-app");
const mainFile = join(appDir, "main.ts");

function hostOf(files: Record<string, string>, directories: readonly string[] = []) {
  const fileMap = new Map(Object.entries(files));
  const directorySet = new Set(directories);
  return {
    readFile: (path: string): string | null => fileMap.get(path) ?? null,
    isFile: (path: string): boolean => fileMap.has(path),
    isDirectory: (path: string): boolean => directorySet.has(path),
    realpath: (path: string): string => path,
  };
}

function fileFormat(source: string): string | null {
  const ambiguous = join(appDir, "ambiguous.js");
  const builder = new NpmGraphBuilder(hostOf({ [ambiguous]: source }));
  const key = builder.addFileImport(mainFile, "./ambiguous.js");
  expect(key).not.toBeNull();
  return builder.moduleFormatOf(key!);
}

describe("Node 24 ambiguous-module classification", () => {
  test.each([
    "await using resource = null;",
    "if (true) { await using resource = null; }",
  ])("top-level await-using syntax is ESM: %s", (source) => {
    expect(fileFormat(source)).toBe("esm");
  });

  test("an outer package type does not cross a node_modules boundary", () => {
    const packageJson = join(appDir, "package.json");
    const entry = join(appDir, "node_modules", "unscoped", "index.js");
    const files = {
      [packageJson]: JSON.stringify({ type: "module" }),
      [entry]: "module.exports = 1;",
    };
    const builder = new NpmGraphBuilder(hostOf(files));
    const key = builder.addFileImport(
      mainFile,
      "./node_modules/unscoped/index.js",
    );
    expect(key).not.toBeNull();
    expect(builder.moduleFormatOf(key!)).toBe("cjs");
  });
});

describe("module-field format overrides", () => {
  const packageDir = join(appDir, "node_modules", "pkg");
  const packageJson = join(packageDir, "package.json");
  const moduleEntry = join(packageDir, "index.js");
  const mainEntry = join(packageDir, "index.cjs");
  const files = {
    [packageJson]: JSON.stringify({
      name: "pkg",
      module: "./index.js",
      main: "./index.cjs",
    }),
    [moduleEntry]: "globalThis.loaded = true;",
    [mainEntry]: "module.exports = true;",
  };
  const directories = [packageDir];

  test("a late bare import refreshes an entry first reached as a file", () => {
    const builder = new NpmGraphBuilder(hostOf(files, directories));
    expect(
      builder.addFileImport(mainFile, "./node_modules/pkg/index.js"),
    ).toBe(moduleEntry);
    expect(builder.moduleFormatOf(moduleEntry)).toBe("cjs");

    builder.addImport(mainFile, "pkg");
    expect(builder.moduleFormatOf(moduleEntry)).toBe("esm");
  });

  test("the final format is independent of discovery order", () => {
    const builder = new NpmGraphBuilder(hostOf(files, directories));
    builder.addImport(mainFile, "pkg");
    expect(
      builder.addFileImport(mainFile, "./node_modules/pkg/index.js"),
    ).toBe(moduleEntry);
    expect(builder.moduleFormatOf(moduleEntry)).toBe("esm");
  });
});
