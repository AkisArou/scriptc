import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  cacheTargetIdentity,
  compileC,
  compileLibArchive,
  resolveBuildCacheRoot,
  runtimeFingerprint,
  stageRuntimeObjects,
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "./cc.js";

const scratch: string[] = [];
const TEST_CACHE_IDENTITY = "cc-cache-tests-v1";

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the production cache root follows overrides, platform defaults, and the hard disable", () => {
  expect(resolveBuildCacheRoot({ SCRIPTC_NO_CACHE: "1" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "/var/tmp/custom" }, "linux", "/home/tester")).toBe(
    "/var/tmp/custom",
  );
  expect(resolveBuildCacheRoot({ XDG_CACHE_HOME: "/var/tmp/xdg" }, "linux", "/home/tester")).toBe(
    "/var/tmp/xdg/scriptc/build",
  );
  expect(resolveBuildCacheRoot({}, "darwin", "/Users/tester")).toBe(
    "/Users/tester/Library/Caches/scriptc/build",
  );
  expect(resolveBuildCacheRoot({ LOCALAPPDATA: "/Users/tester/AppData/Local" }, "win32", "/Users/tester")).toBe(
    "/Users/tester/AppData/Local/scriptc/cache/build",
  );
});

test("native cache identities separate host architectures while cross targets remain explicit", () => {
  expect(cacheTargetIdentity({ target: null }, "darwin", "arm64")).toBe("native:darwin:arm64");
  expect(cacheTargetIdentity({ target: null }, "darwin", "x64")).toBe("native:darwin:x64");
  expect(cacheTargetIdentity({ target: "x86_64-linux-gnu.2.36" }, "darwin", "arm64")).toBe(
    "cross:x86_64-linux-gnu.2.36",
  );
});

test("the toolchain environment joins cache identities", () => {
  const base = toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/one" });
  expect(toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/two" })).not.toBe(base);
  // PATH is deliberately absent: an already-identified content hit remains
  // usable when the compiler is no longer installed/reachable.
  expect(toolchainEnvironmentFingerprint({ PATH: "", CPATH: "/headers/one" })).toBe(base);
  expect(
    toolchainEnvironmentFingerprint({
      PATH: "/usr/bin",
      CPATH: "/headers/one",
      SCRIPTC_CACHE_MAX_MB: "1",
    }),
  ).toBe(base);

  expect(toolchainEnvironmentCachePolicy({ MACOSX_DEPLOYMENT_TARGET: "14.0" })).toEqual({
    completeArtifacts: true,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ LIBRARY_PATH: "/libraries" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ CPATH: "/headers" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
});

test("the runtime fingerprint includes the textually included Ryū sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-fingerprint-"));
  scratch.push(dir);
  const rtDir = join(dir, "src");
  const ryuDir = join(dir, "vendor", "ryu");
  await Promise.all([mkdir(rtDir, { recursive: true }), mkdir(ryuDir, { recursive: true })]);
  await Promise.all([
    writeFile(join(rtDir, "scr_number.c"), '#include "../vendor/ryu/d2s.c"\n'),
    writeFile(join(ryuDir, "d2s.c"), "int ryu_probe = 1;\n"),
  ]);
  const first = await runtimeFingerprint(rtDir);
  await writeFile(join(ryuDir, "d2s.c"), "int ryu_probe = 200;\n");
  expect(await runtimeFingerprint(rtDir)).not.toBe(first);
});

test("staged runtime objects survive removal of their cache names and are promoted in the LRU", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-stage-"));
  scratch.push(dir);
  const cachedObject = join(dir, "cache", "scr_number.o");
  const source = join(dir, "runtime", "scr_number.c");
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(cachedObject, "cached object bytes");
  const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(cachedObject, pinnedTime, pinnedTime);
  const staged = await stageRuntimeObjects(new Map([[source, cachedObject]]), join(dir, "stage"));
  expect((await stat(cachedObject)).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
  await rm(cachedObject);
  expect(await readFile(staged.get(source)!)).toEqual(Buffer.from("cached object bytes"));
});

test("cache hits honor the current umask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-environment-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldUmask = process.umask();

  try {
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("one"); return 0; }\n');
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];

    process.umask(0o022);
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") expect((await stat(firstOut)).mode & 0o777).toBe(0o755);

    // A hit populated under a permissive umask adopts the current restrictive
    // one instead of restoring the cached file's broader mode.
    process.umask(0o077);
    const hitOut = join(dir, "hit");
    await compileC({ cPath, outPath: hitOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") expect((await stat(hitOut)).mode & 0o777).toBe(0o700);
    expect(await readdir(join(cacheRoot, "bin"))).toHaveLength(1);

    process.umask(0o022);
    const firstArchivePath = join(dir, "first.lib.a");
    await compileLibArchive({ cPath, outPath: firstArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(firstArchivePath);
    process.umask(0o077);
    const hitArchivePath = join(dir, "hit.lib.a");
    await compileLibArchive({ cPath, outPath: hitArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(hitArchivePath)).toEqual(firstArchive);
    if (process.platform !== "win32") expect((await stat(hitArchivePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(1);
  } finally {
    process.umask(oldUmask);
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("mutable compiler inputs bypass caches when files change in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-ambient-input-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const headers = join(dir, "headers");
  const headerPath = join(headers, "cache_probe.h");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldCpath = process.env["CPATH"];

  try {
    await mkdir(headers);
    await writeFile(
      cPath,
      '#include <stdio.h>\n#include <cache_probe.h>\nint main(void) { puts(CACHE_PROBE); return 0; }\n',
    );
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    process.env["CPATH"] = headers;

    await writeFile(headerPath, '#define CACHE_PROBE "one"\n');
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

    // The environment spelling is unchanged; only a file behind it moves.
    await writeFile(headerPath, '#define CACHE_PROBE "two"\n');
    const secondOut = join(dir, "second");
    await compileC({ cPath, outPath: secondOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");

    const firstArchivePath = join(dir, "first.lib.a");
    await compileLibArchive({ cPath, outPath: firstArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(firstArchivePath);
    await writeFile(headerPath, '#define CACHE_PROBE "three"\n');
    const secondArchivePath = join(dir, "second.lib.a");
    await compileLibArchive({ cPath, outPath: secondArchivePath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(secondArchivePath)).not.toEqual(firstArchive);

    // CPATH can mutate behind a stable string, so no cache tier is populated.
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldCpath === undefined) delete process.env["CPATH"];
    else process.env["CPATH"] = oldCpath;
  }
});

test("complete binary hits precede missing vendor prerequisite materialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-vendor-hit-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorCacheRoot = join(dir, "vendor-cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  const oldPath = process.env["PATH"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorCacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, '#include <stdio.h>\nint main(void) { puts("cached"); return 0; }\n');

    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("cached");
    expect(await readdir(join(cacheRoot, "bin"))).toHaveLength(1);
    expect((await stat(vendorCacheRoot)).isDirectory()).toBe(true);

    // Simulate a package reinstall: the per-package vendor build disappears,
    // while the per-user complete executable remains. An empty PATH turns any
    // attempted prerequisite rebuild into an immediate failure.
    await rm(vendorCacheRoot, { recursive: true, force: true });
    process.env["PATH"] = "";
    const hitOut = join(dir, "hit");
    await compileC({
      cPath,
      outPath: hitOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      regex: true,
    });
    expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("cached");
    await expect(stat(vendorCacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  }
});

test("arbitrary C bypasses persistent artifacts so same-path header edits cannot go stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-arbitrary-c-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const cPath = join(dir, "program.c");
  const headerPath = join(dir, "value.h");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(
      cPath,
      '#include <stdio.h>\n#include "value.h"\nint main(void) { puts(VALUE); return 0; }\n',
    );
    await writeFile(headerPath, '#define VALUE "one"\n');
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");

    await writeFile(headerPath, '#define VALUE "two"\n');
    const secondOut = join(dir, "second");
    await compileC({ cPath, outPath: secondOut });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("two");
    await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });

    const archiveOut = join(dir, "program.lib.a");
    await compileLibArchive({ cPath, outPath: archiveOut });
    expect((await stat(archiveOut)).isFile()).toBe(true);
    await expect(stat(join(cacheRoot, "lib"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("cached translation units keep the compiler-visible source path in their identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-source-path-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const aPath = join(dir, "a.c");
  const bPath = join(dir, "b.c");
  const source = '#include <stdio.h>\nint main(void) { puts(__FILE__); return 0; }\n';
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];

  try {
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    await Promise.all([writeFile(aPath, source), writeFile(bPath, source)]);
    const aOut = join(dir, "a-out");
    const bOut = join(dir, "b-out");
    await compileC({ cPath: aPath, outPath: aOut, cacheIdentity: TEST_CACHE_IDENTITY });
    await compileC({ cPath: bPath, outPath: bOut, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(execFileSync(aOut, { encoding: "utf8" }).trim()).toBe(aPath);
    expect(execFileSync(bOut, { encoding: "utf8" }).trim()).toBe(bPath);
    expect(await readdir(join(cacheRoot, "bin"))).toHaveLength(2);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
  }
});

test("system libraries relink after an in-place rebuild while runtime objects remain cached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-system-library-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const libDir = join(dir, "lib");
  const cPath = join(dir, "program.c");
  const libSource = join(dir, "probe.c");
  const libObject = join(dir, "probe.o");
  const library = join(libDir, "libscriptc_cache_probe.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldLibraryPath = process.env["LIBRARY_PATH"];

  const rebuildLibrary = async (value: number): Promise<void> => {
    await writeFile(libSource, `int scriptc_cache_probe(void) { return ${value}; }\n`);
    execFileSync("clang", ["-c", libSource, "-o", libObject]);
    execFileSync("ar", ["rcs", library, libObject]);
  };

  try {
    await mkdir(libDir);
    await writeFile(
      cPath,
      '#include <stdio.h>\nextern int scriptc_cache_probe(void);\nint main(void) { printf("%d\\n", scriptc_cache_probe()); return 0; }\n',
    );
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    process.env["LIBRARY_PATH"] = libDir;

    await rebuildLibrary(1);
    const firstOut = join(dir, "first");
    await compileC({
      cPath,
      outPath: firstOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      systemLibraries: ["scriptc_cache_probe"],
    });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("1");

    await rebuildLibrary(2);
    const secondOut = join(dir, "second");
    await compileC({
      cPath,
      outPath: secondOut,
      cacheIdentity: TEST_CACHE_IDENTITY,
      systemLibraries: ["scriptc_cache_probe"],
    });
    expect(execFileSync(secondOut, { encoding: "utf8" }).trim()).toBe("2");

    // The ambient library prevents a stale complete-binary hit, but the safe
    // runtime-object half of the persistent cache remains active.
    await expect(stat(join(cacheRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const objectSets = await readdir(join(cacheRoot, "obj"), { withFileTypes: true });
    expect(objectSets.some((entry) => entry.isDirectory() && !entry.name.startsWith("build-"))).toBe(true);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldLibraryPath === undefined) delete process.env["LIBRARY_PATH"];
    else process.env["LIBRARY_PATH"] = oldLibraryPath;
  }
});

test("library archives hit by content, invalidate on edits, and reuse runtime objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-lib-cache-"));
  scratch.push(dir);
  const xdgCacheHome = join(dir, "xdg-cache");
  const cacheRoot = join(xdgCacheHome, "scriptc", "build");
  const cPath = join(dir, "program.c");
  const outPath = join(dir, "program.lib.a");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldXdgCacheHome = process.env["XDG_CACHE_HOME"];
  const oldPath = process.env["PATH"];

  try {
    // No SCRIPTC_CACHE_DIR: this exercises the production-default activation,
    // with XDG_CACHE_HOME redirecting the per-user root into disposable space.
    delete process.env["SCRIPTC_CACHE_DIR"];
    process.env["XDG_CACHE_HOME"] = xdgCacheHome;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int scriptc_cache_probe = 1;\n");
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    const firstArchive = await readFile(outPath);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(1);

    const objectSets = await readdir(join(cacheRoot, "obj"), { withFileTypes: true });
    const objectSet = objectSets.find((entry) => entry.isDirectory() && !entry.name.startsWith("build-"));
    expect(objectSet).toBeDefined();
    const objectDir = join(cacheRoot, "obj", objectSet!.name);
    const objectNames = await readdir(objectDir);
    expect(objectNames.length).toBeGreaterThan(10);
    const pinnedTime = new Date("2000-01-01T00:00:00.000Z");
    await Promise.all(objectNames.map((name) => utimes(join(objectDir, name), pinnedTime, pinnedTime)));

    // A content hit needs no compiler or archiver. Empty PATH makes any
    // accidental subprocess invocation fail while filesystem cache access
    // remains available.
    process.env["PATH"] = "";
    await rm(outPath, { force: true });
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    expect(await readFile(outPath)).toEqual(firstArchive);

    // The hard disable bypasses the same valid entry in both directions.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    await rm(outPath, { force: true });
    await expect(
      compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY }),
    ).rejects.toThrow(/failed compiling/);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(1);

    // An edit invalidates the complete archive but retains the library-flavor
    // runtime object set. Only the changed program TU is compiled again.
    process.env["PATH"] = oldPath;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int scriptc_cache_probe = 2;\n");
    await compileLibArchive({ cPath, outPath, cacheIdentity: TEST_CACHE_IDENTITY });
    const editedArchive = await readFile(outPath);
    expect(editedArchive).not.toEqual(firstArchive);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(2);
    for (const name of objectNames) {
      expect((await stat(join(objectDir, name))).mtimeMs).toBeGreaterThan(pinnedTime.getTime());
    }

    // BSD ar preserves member mtimes, so containers assembled from old cached
    // objects need not be byte-identical to a fresh archive. Their object
    // members must be byte-identical, and a successful disabled build must
    // publish nothing into the cache.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const uncachedOut = join(dir, "program.uncached.lib.a");
    await compileLibArchive({ cPath, outPath: uncachedOut, cacheIdentity: TEST_CACHE_IDENTITY });
    const cachedMembers = join(dir, "cached-members");
    const uncachedMembers = join(dir, "uncached-members");
    await Promise.all([mkdir(cachedMembers), mkdir(uncachedMembers)]);
    execFileSync("ar", ["x", outPath], { cwd: cachedMembers });
    execFileSync("ar", ["x", uncachedOut], { cwd: uncachedMembers });
    const memberNames = await readdir(cachedMembers);
    expect(await readdir(uncachedMembers)).toEqual(memberNames);
    for (const name of memberNames) {
      expect(await readFile(join(uncachedMembers, name))).toEqual(await readFile(join(cachedMembers, name)));
    }
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(2);
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldXdgCacheHome === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = oldXdgCacheHome;
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  }
});
