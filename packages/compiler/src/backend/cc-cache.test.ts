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
  toolchainEnvironmentFingerprint,
} from "./cc.js";

const scratch: string[] = [];

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

test("staged runtime objects survive removal of their cache names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-object-stage-"));
  scratch.push(dir);
  const cachedObject = join(dir, "cache", "scr_number.o");
  const source = join(dir, "runtime", "scr_number.c");
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(cachedObject, "cached object bytes");
  const staged = await stageRuntimeObjects(new Map([[source, cachedObject]]), join(dir, "stage"));
  await rm(cachedObject);
  expect(await readFile(staged.get(source)!)).toEqual(Buffer.from("cached object bytes"));
});

test("cache hits invalidate on compiler environment changes and honor the current umask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cache-environment-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const firstHeaders = join(dir, "headers-one");
  const secondHeaders = join(dir, "headers-two");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldCpath = process.env["CPATH"];
  const oldUmask = process.umask();

  try {
    await Promise.all([mkdir(firstHeaders), mkdir(secondHeaders)]);
    await Promise.all([
      writeFile(join(firstHeaders, "cache_probe.h"), '#define CACHE_PROBE "one"\n'),
      writeFile(join(secondHeaders, "cache_probe.h"), '#define CACHE_PROBE "two"\n'),
      writeFile(
        cPath,
        '#include <stdio.h>\n#include <cache_probe.h>\nint main(void) { puts(CACHE_PROBE); return 0; }\n',
      ),
    ]);
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    process.env["CPATH"] = firstHeaders;

    process.umask(0o022);
    const firstOut = join(dir, "first");
    await compileC({ cPath, outPath: firstOut });
    expect(execFileSync(firstOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") expect((await stat(firstOut)).mode & 0o777).toBe(0o755);

    // A hit populated under a permissive umask adopts the current restrictive
    // one instead of restoring the cached file's broader mode.
    process.umask(0o077);
    const hitOut = join(dir, "hit");
    await compileC({ cPath, outPath: hitOut });
    expect(execFileSync(hitOut, { encoding: "utf8" }).trim()).toBe("one");
    if (process.platform !== "win32") expect((await stat(hitOut)).mode & 0o777).toBe(0o700);
    expect(await readdir(join(cacheRoot, "bin"))).toHaveLength(1);

    // CPATH is an implicit clang input. Changing it must miss both the final
    // artifact cache and the per-flavor runtime-object cache.
    process.env["CPATH"] = secondHeaders;
    const changedOut = join(dir, "changed");
    await compileC({ cPath, outPath: changedOut });
    expect(execFileSync(changedOut, { encoding: "utf8" }).trim()).toBe("two");
    if (process.platform !== "win32") expect((await stat(changedOut)).mode & 0o777).toBe(0o700);
    expect(await readdir(join(cacheRoot, "bin"))).toHaveLength(2);

    process.env["CPATH"] = firstHeaders;
    const firstArchivePath = join(dir, "first.lib.a");
    await compileLibArchive({ cPath, outPath: firstArchivePath });
    const firstArchive = await readFile(firstArchivePath);
    process.env["CPATH"] = secondHeaders;
    const secondArchivePath = join(dir, "second.lib.a");
    await compileLibArchive({ cPath, outPath: secondArchivePath });
    expect(await readFile(secondArchivePath)).not.toEqual(firstArchive);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(2);
  } finally {
    process.umask(oldUmask);
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldCpath === undefined) delete process.env["CPATH"];
    else process.env["CPATH"] = oldCpath;
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
    await compileLibArchive({ cPath, outPath });
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
    await compileLibArchive({ cPath, outPath });
    expect(await readFile(outPath)).toEqual(firstArchive);

    // The hard disable bypasses the same valid entry in both directions.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    await rm(outPath, { force: true });
    await expect(compileLibArchive({ cPath, outPath })).rejects.toThrow(/failed compiling/);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(1);

    // An edit invalidates the complete archive but retains the library-flavor
    // runtime object set. Only the changed program TU is compiled again.
    process.env["PATH"] = oldPath;
    delete process.env["SCRIPTC_NO_CACHE"];
    await writeFile(cPath, "int scriptc_cache_probe = 2;\n");
    await compileLibArchive({ cPath, outPath });
    const editedArchive = await readFile(outPath);
    expect(editedArchive).not.toEqual(firstArchive);
    expect(await readdir(join(cacheRoot, "lib"))).toHaveLength(2);
    for (const name of objectNames) {
      expect((await stat(join(objectDir, name))).mtimeMs).toBe(pinnedTime.getTime());
    }

    // BSD ar preserves member mtimes, so containers assembled from old cached
    // objects need not be byte-identical to a fresh archive. Their object
    // members must be byte-identical, and a successful disabled build must
    // publish nothing into the cache.
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const uncachedOut = join(dir, "program.uncached.lib.a");
    await compileLibArchive({ cPath, outPath: uncachedOut });
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
