import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compileLibArchive, resolveBuildCacheRoot } from "./cc.js";

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
