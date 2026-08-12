/* Multi-instance library mode (the profile's abi.localize_runtime): N
 * library archives built under pairwise-distinct symbol prefixes link into
 * ONE process. The archive build combines the program, runtime, and vendor
 * objects into one relocatable member and demotes every external
 * definition except the profile-declared symbols to a local symbol, so the
 * embedder's linker sees no runtime internals at all — no symbol
 * collisions, and each instance owns a private copy of the whole runtime
 * (allocator, collector, result arena, panic sink, poison flag).
 *
 *   M1 symbols-exact     nm over a localized archive: the external defined
 *                        set equals the profile-declared set EXACTLY (plus
 *                        ASan's one image-registration common in a
 *                        sanitized build), and undefineds stay target-
 *                        runtime/system-API-shaped apart from sanitizer ABI
 *                        references
 *   M2 two-instance run  the acceptance probe: two archives (ma_/mb_), two
 *                        embedder threads (one per instance — the
 *                        documented contract), independent init and
 *                        collect, a deliberate trap in A delivered to A's
 *                        sink exactly once (structured: SC4014, ma_boom,
 *                        A's ctx) while B keeps answering through and after
 *                        the trap window; B's sink never fires. Runs per
 *                        emission and once with mixed emissions (one
 *                        archive per backend).
 *   M3 profile shape     abi.localize_runtime is strictly boolean (SC4001)
 *   M4 target posture    localization is per OBJECT FORMAT: ELF and COFF
 *                        localize from any host, Mach-O runs the macOS
 *                        host linker — so a macos target off a darwin
 *                        host, and any host outside darwin/linux/win32,
 *                        refuses SC3002 before emission with the pairing
 *                        named
 *
 * Thread-instanced state (the profile's abi.instance_per_thread): every
 * mutable static in the archive — runtime internals, module globals,
 * run-once guards, regex literal caches — compiles as thread-local
 * storage, so ONE linked archive serves one independent instance per
 * embedder thread through the unchanged entry family (the calling thread
 * is the instance selector).
 *
 *   M6 four threads      one archive, four embedder threads with distinct
 *                        workloads: concurrent instance-local inits,
 *                        independent state and collects, a deliberate trap
 *                        on thread 0 delivered to ITS sink exactly once
 *                        (SC4014, mt_boom, its ctx) poisoning only its
 *                        instance while the other three keep answering
 *                        through and after the trap window; sanitized in
 *                        the SCRIPTC_SAN=1 flavor like M1/M2
 *   M6 inspect TLS       deterministic two-thread runtime seam proving
 *                        circular-target pointers cannot cross instances
 *   M7 composition       a thread-instanced AND runtime-localized archive
 *                        coexists with a second different-prefix localized
 *                        archive in one process (both mechanisms at once);
 *                        the localized link surface stays exactly the
 *                        declared set, with M1's one ASan
 *                        image-registration common in a sanitized build
 *   M8 sanitized rerun   M6 re-run explicitly under ASan (the K10
 *                        precedent: the plain flavor carries an
 *                        instrumented pairing too)
 *   M9 profile shape     abi.instance_per_thread is strictly boolean
 *                        (SC4001)
 *
 * Cross-target localization (SCRIPTC_CROSS=1 — zig on PATH, the
 * library-cross lane's gate; never part of the default suites):
 *
 *   M10 cross conformance  per cross target and emission: localized a/b
 *                        archives build, the external defined set equals
 *                        the declared set exactly (host nm reads ELF,
 *                        COFF, and Mach-O alike), no prefix-carrying
 *                        undefined escapes, the ambient audit holds, and
 *                        the two-archive probe LINKS with the target's
 *                        libc (plus the documented win32 embedder libs)
 *   M11 cross execution  the M2 acceptance probe runs on the real target:
 *                        linux triples in the differential containers
 *                        (SCRIPTC_LINUX=1), the windows triple on the ssh
 *                        box (SCRIPTC_WIN=1) — including the M7-style
 *                        thread-instanced+localized composition there
 *
 * Windows hosts run M1/M2/M6/M7 natively through the same gates as darwin
 * and linux: probes compile with `zig cc` (the box's toolchain), archives
 * carry CRLF-normalized probe output (the mingw CRT's text-mode stdout),
 * and symbol checks ride llvm-nm when plain nm is absent.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary, loadLibraryProfile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/library-mode/multi");
const localizationTest =
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    ? test
    : test.skip;
/* win32 boxes commonly carry llvm-nm (LLVM) rather than a bare nm; darwin's
 * nm IS llvm-nm and linux binutils nm reads its own objects. */
const nmTool = ((): string | null => {
  for (const tool of process.platform === "win32" ? ["llvm-nm", "nm"] : ["nm"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status === 0) return tool;
  }
  return null;
})();
/* Probes are plain-C embedder hosts: clang on darwin/linux, `zig cc` on
 * win32 (the windows box's C toolchain — winpthreads rides -pthread). */
const probeCc = process.platform === "win32" ? ["zig", "cc"] : ["clang"];
/* The documented win32 embedder link line beyond the CRT (library-cross
 * pins the same set): advapi32 (CSPRNG, GetUserNameA), iphlpapi
 * (GetAdaptersAddresses), ws2_32 (inet_ntop/htonl). */
const WIN32_EMBEDDER_LIBS = ["-ladvapi32", "-liphlpapi", "-lws2_32"];
/* The mingw CRT's text-mode stdout writes CRLF from the PROBE's own printf
 * — a plain-C embedder host fact, folded back for comparison. */
const normalizeProbeOut = (out: string): string =>
  process.platform === "win32" ? out.replaceAll("\r\n", "\n") : out;
/* Suite-flavor segment (the library suites' convention): the plain and
 * SCRIPTC_SAN=1 suites may run concurrently and must never share build
 * dirs. */
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const flavor = sanitize ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-multi", flavor);

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

/** Build one instance's localized archive for one emission: the fixture
 * profile is patched (emission flipped, entry made absolute) into the
 * build dir, then compiled through the real compileLibrary pipeline.
 * Memoized per (instance, emission) — the probe pairings reuse builds. */
const built = new Map<string, Promise<string>>();
function buildInstance(instance: "a" | "b", emission: Emission): Promise<string> {
  const key = `${instance}-${emission}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(fixtureDir, `profile_${instance}.json`), "utf8")) as {
        entry: string;
        emission: string;
      };
      profile.emission = emission;
      profile.entry = join(fixtureDir, profile.entry);
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const result = await compileLibrary({ profilePath, outDir, sanitize });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      expect(result.backend).toBe(emission);
      return result.archivePath;
    })();
    built.set(key, archive);
  }
  return archive;
}

/** nm over an archive: [definedExternal, undefined] symbol sets, macOS/
 * Linux leading-underscore normalized away. */
function nmSymbols(archive: string): { defined: Set<string>; undef: Set<string> } {
  const parse = (out: string): Set<string> => {
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      const sym = line.trim().split(/\s+/).pop();
      if (sym === undefined || sym === "" || sym.endsWith(":")) continue;
      set.add(sym.replace(/^_/, ""));
    }
    return set;
  };
  const defined = parse(execFileSync(nmTool!, ["-gU", archive], { encoding: "utf8" }));
  const undef = parse(execFileSync(nmTool!, ["-u", archive], { encoding: "utf8" }));
  return { defined, undef };
}

const A_SYMBOLS = ["ma_boom", "ma_bump", "ma_calls_seen", "ma_collect", "ma_init", "ma_set_panic_sink"];
const B_SYMBOLS = ["mb_add", "mb_collect", "mb_init", "mb_set_panic_sink", "mb_sum_to"];

const PROBE_EXPECTED = `multi-a ready
multi-b ready
a: bump(1) x200 -> 201, calls_seen 200, trap fell through 0
a sink: calls=1 ctx_ok=1 fields=3 code=[SC4014] symbol=[ma_boom] text_printable=1 addr_nonzero=1
b: concurrent sums_ok=1 adds_ok=1 reached_200=1
b: post-trap answers ok=1
b sink: calls=0
`;

/* ── M1: the localized archive's exact link surface ─────────────────────── */

describe.each(EMISSIONS)("localized archive symbols, %s emission", (emission) => {
  localizationTest("M1: external definitions equal the declared set exactly", async (ctx) => {
    if (nmTool === null) ctx.skip("no nm/llvm-nm on PATH for the symbol-exactness check");
    const [archiveA, archiveB] = await Promise.all([
      buildInstance("a", emission),
      buildInstance("b", emission),
    ]);
    for (const [archive, declared] of [
      [archiveA, A_SYMBOLS],
      [archiveB, B_SYMBOLS],
    ] as const) {
      const { defined, undef } = nmSymbols(archive);
      // The WHOLE defined set — a classic archive additionally defines
      // every runtime internal; a localized one defines nothing else.
      // ASan's image-wide registration guard is the sole sanitized
      // exception: keeping its COMMON shared makes the final image
      // register its ASan globals exactly once when N archives contribute
      // module constructors — Mach-O and ELF spell the same discipline
      // with one underscore of decoration between them.
      const toolchainDefinitions = sanitize
        ? [process.platform === "darwin" ? "___asan_globals_registered" : "__asan_globals_registered"]
        : [];
      expect([...defined].sort()).toEqual([...declared, ...toolchainDefinitions].sort());
      // Undefineds: no runtime-internal or prefix-carrying reference
      // escapes; target-runtime/system-API (and sanitizer ABI) references
      // keep their global binding.
      expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
      // The ambient audit holds through the combine step: no
      // process-disposition or threading surface, no atexit teardown.
      for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
        expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
      }
    }
  });
});

/* ── M2: the two-instance, two-thread acceptance probe ──────────────────── */

function buildProbe(archiveA: string, archiveB: string, outDir: string, tag: string): string {
  const bin = join(outDir, `probe-${tag}${process.platform === "win32" ? ".exe" : ""}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync(probeCc[0]!, [
    ...probeCc.slice(1),
    "-std=c11",
    "-pthread",
    ...(sanitize ? ["-fsanitize=address"] : []),
    join(fixtureDir, "probe.c"),
    archiveA,
    archiveB,
    "-lm",
    ...(process.platform === "win32" ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

const PAIRINGS: { tag: string; a: Emission; b: Emission }[] = [
  { tag: "llvm-llvm", a: "llvm", b: "llvm" },
  { tag: "c-c", a: "c", b: "c" },
  // Two embedder builds need not share a backend: one archive per emission
  // links and runs the same.
  { tag: "llvm-c", a: "llvm", b: "c" },
];

describe.each(PAIRINGS)("two instances, one process ($tag)", ({ tag, a, b }) => {
  localizationTest("M2: independent state and collects; a trap reaches only its own sink, once", async () => {
    const [archiveA, archiveB] = await Promise.all([buildInstance("a", a), buildInstance("b", b)]);
    const probe = buildProbe(archiveA, archiveB, join(cacheDir, "probes"), tag);
    const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(normalizeProbeOut(run.stdout)).toBe(PROBE_EXPECTED);
  });
});

/* ── M3: profile shape ───────────────────────────────────────────────────── */

test("M3: abi.localize_runtime is strictly boolean", () => {
  const dir = join(cacheDir, "profile-shape");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "profile.json");
  const base = {
    profile_format: 1,
    name: "shape",
    entry: "lib.ts",
    emission: "llvm",
    abi: {
      prefix: "sp_",
      init_symbol: "sp_init",
      sink_register_symbol: "sp_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
      localize_runtime: "yes",
    },
    exports: [],
  };
  for (const invalid of ["yes", null] as const) {
    writeFileSync(path, JSON.stringify({
      ...base,
      abi: { ...base.abi, localize_runtime: invalid },
    }));
    const refused = loadLibraryProfile(path);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics[0]!.code).toBe("SC4001");
      expect(refused.diagnostics[0]!.message).toContain("abi.localize_runtime");
    }
  }
  // The boolean forms load, and absence means false.
  for (const [value, expected] of [[true, true], [false, false], [undefined, false]] as const) {
    const abi: Record<string, unknown> = { ...base.abi };
    if (value === undefined) delete abi["localize_runtime"];
    else abi["localize_runtime"] = value;
    writeFileSync(path, JSON.stringify({ ...base, abi }));
    const loaded = loadLibraryProfile(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.profile.localizeRuntime).toBe(expected);
  }
});

/* ── M4: host-native posture ─────────────────────────────────────────────── */

test("M4: a macos cross target refuses runtime localization off a darwin host with SC3002", async () => {
  const outDir = join(cacheDir, "cross-refusal");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
    entry: string;
  };
  profile.entry = join(fixtureDir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  // compileLibrary reads SCRIPTC_CC/SCRIPTC_TARGET at call time; the
  // refusal fires before any toolchain runs, so zig need not exist here.
  // Mach-O localization runs the macOS host linker, so a macos target is
  // exactly the pairing a non-darwin host still refuses.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = "x86_64-macos";
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("x86_64-macos");
      expect(result.diagnostics[0]!.message).toContain("runtime-localized");
      expect(result.diagnostics[0]!.message).toContain("linux hosts");
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
});

test.each([
  ["aarch64-windows-gnu", "COFF localization currently requires x86_64"],
  ["x86-linux-gnu", "cross-ELF localization currently requires x86_64 or aarch64"],
] as const)(
  "M4: unsupported localization object class %s refuses before emission with SC3002",
  async (target, reason) => {
    const outDir = join(cacheDir, `object-class-refusal-${target}`);
    mkdirSync(outDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
      entry: string;
    };
    profile.entry = join(fixtureDir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const prevCc = process.env["SCRIPTC_CC"];
    const prevTarget = process.env["SCRIPTC_TARGET"];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = target;
    try {
      const result = await compileLibrary({ profilePath, outDir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics[0]!.code).toBe("SC3002");
        expect(result.diagnostics[0]!.message).toContain(target);
        expect(result.diagnostics[0]!.message).toContain(reason);
      }
    } finally {
      if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = prevCc;
      if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = prevTarget;
    }
  },
);

test("M4: an unsupported native host refuses runtime localization with SC3002", async () => {
  const outDir = join(cacheDir, "native-refusal");
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
    entry: string;
  };
  profile.entry = join(fixtureDir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  delete process.env["SCRIPTC_CC"];
  delete process.env["SCRIPTC_TARGET"];
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "freebsd" });
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("freebsd");
      expect(result.diagnostics[0]!.message).toContain("runtime-localized");
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
});

/* ── M5: caller-visible archive publication ─────────────────────────────── */

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "M5: localization archives privately before atomically installing the caller-visible output",
  async () => {
    const outDir = join(cacheDir, "atomic-publication");
    const binDir = join(outDir, "bin");
    const outPath = join(outDir, "localized.lib.a");
    mkdirSync(binDir, { recursive: true });
    const profile = JSON.parse(readFileSync(join(fixtureDir, "profile_a.json"), "utf8")) as {
      entry: string;
    };
    profile.entry = join(fixtureDir, profile.entry);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    const oldPath = process.env["PATH"];
    const oldCc = process.env["SCRIPTC_CC"];
    const oldTarget = process.env["SCRIPTC_TARGET"];
    const oldRealAr = process.env["SCRIPTC_TEST_REAL_AR"];
    const oldForbiddenOutput = process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"];
    const originalAr = (oldPath ?? "")
      .split(delimiter)
      .map((entry) => join(entry === "" ? process.cwd() : entry, "ar"))
      .find((candidate) => existsSync(candidate));
    expect(originalAr).toBeDefined();

    const wrapper = join(binDir, "ar");
    writeFileSync(
      wrapper,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT" ]; then
    echo "archiver received caller-visible output" >&2
    exit 97
  fi
done
exec "$SCRIPTC_TEST_REAL_AR" "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    process.env["PATH"] = `${binDir}${delimiter}${oldPath ?? ""}`;
    process.env["SCRIPTC_TEST_REAL_AR"] = originalAr!;
    process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"] = outPath;
    delete process.env["SCRIPTC_CC"];
    delete process.env["SCRIPTC_TARGET"];
    try {
      const result = await compileLibrary({ profilePath, outDir, outPath, sanitize });
      expect(result.ok, result.ok ? undefined : result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")).toBe(true);
      expect(existsSync(outPath)).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = oldPath;
      if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = oldCc;
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
      if (oldRealAr === undefined) delete process.env["SCRIPTC_TEST_REAL_AR"];
      else process.env["SCRIPTC_TEST_REAL_AR"] = oldRealAr;
      if (oldForbiddenOutput === undefined) delete process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"];
      else process.env["SCRIPTC_TEST_FORBIDDEN_ARCHIVE_OUTPUT"] = oldForbiddenOutput;
    }
  },
);

/* ── M6/M7/M8: thread-instanced state (abi.instance_per_thread) ──────────── */

const threadFixtureDir = join(repoRoot, "tests/library-mode/thread-instances");

/** Build the thread-instances fixture's archive for one emission: same
 * patch-and-compile shape as buildInstance, plus abi overrides (M7 turns
 * localize_runtime on) and an explicit sanitize override (M8's ASan
 * pairing inside the plain flavor). Memoized like buildInstance. */
function buildThreaded(
  emission: Emission,
  opts: { localize?: boolean; sanitize?: boolean } = {},
): Promise<string> {
  const sanitized = opts.sanitize ?? sanitize;
  const key = `t-${emission}${opts.localize === true ? "-loc" : ""}${sanitized ? "-san" : ""}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
        entry: string;
        emission: string;
        abi: Record<string, unknown>;
      };
      profile.emission = emission;
      profile.entry = join(threadFixtureDir, profile.entry);
      if (opts.localize === true) profile.abi["localize_runtime"] = true;
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const result = await compileLibrary({ profilePath, outDir, sanitize: sanitized });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      }
      expect(result.backend).toBe(emission);
      return result.archivePath;
    })();
    built.set(key, archive);
  }
  return archive;
}

function buildThreadProbe(
  source: string,
  archives: string[],
  tag: string,
  opts: { sanitize?: boolean } = {},
): string {
  const outDir = join(cacheDir, "probes");
  const bin = join(outDir, `probe-${tag}${process.platform === "win32" ? ".exe" : ""}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync(probeCc[0]!, [
    ...probeCc.slice(1),
    "-std=c11",
    "-pthread",
    ...((opts.sanitize ?? sanitize) ? ["-fsanitize=address"] : []),
    source,
    ...archives,
    "-lm",
    ...(process.platform === "win32" ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

const THREADED_EXPECTED = `t0: bump x100 -> 101, calls_seen 100, sums_ok=1, clocks_ok=1, trap fell through 0
t0 sink: calls=1 ctx_ok=1 fields=3 code=[SC4014] symbol=[mt_boom] addr_nonzero=1
t1: bump x150 -> 151, calls_seen 150, sums_ok=1, clocks_ok=1, post_ok=1
t2: bump x200 -> 201, calls_seen 200, sums_ok=1, clocks_ok=1, post_ok=1
t3: bump x250 -> 251, calls_seen 250, sums_ok=1, clocks_ok=1, post_ok=1
survivor sinks: 0 0 0
`;

describe.each(EMISSIONS)("thread-instanced archive, %s emission", (emission) => {
  localizationTest("M6: four threads, one archive: independent instances; a trap reaches only its own thread's sink, once", async () => {
    const archive = await buildThreaded(emission);
    const probe = buildThreadProbe(join(threadFixtureDir, "probe.c"), [archive], `t-${emission}`);
    const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(normalizeProbeOut(run.stdout)).toBe(THREADED_EXPECTED);
  });
});

/* The inspect-TLS probe's dead-strip technique (function/data sections +
 * gc-sections over deliberately-unresolved runtime references) is an
 * ELF/Mach-O link idiom; win32 hosts cover the seam through M6's archive
 * probes. */
const inspectTlsTest =
  process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
inspectTlsTest("M6: util.inspect circular-reference state is thread-local", () => {
  const outDir = join(cacheDir, "inspect-tls-probe");
  const bin = join(outDir, "probe");
  mkdirSync(outDir, { recursive: true });
  execFileSync("clang", [
    "-std=c11",
    "-pthread",
    "-DSCR_LIB",
    "-DSCR_THREAD_INSTANCES",
    "-ffunction-sections",
    "-fdata-sections",
    "-Wno-comment",
    ...(sanitize ? ["-fsanitize=address"] : []),
    "-I", join(repoRoot, "packages/runtime/src"),
    join(threadFixtureDir, "probe_inspect.c"),
    join(repoRoot, "packages/runtime/src/scr_inspect.c"),
    process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections",
    "-o", bin,
  ]);
  const env =
    sanitize && process.platform === "linux"
      ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" }
      : process.env;
  const run = spawnSync(bin, { encoding: "utf8", timeout: 60_000, env });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("1 1 1\n");
});

localizationTest("M7: thread-instanced and runtime-localized archives compose in one process", async (ctx) => {
  if (nmTool === null) ctx.skip("no nm/llvm-nm on PATH for the symbol-exactness check");
  const [archiveT, archiveB] = await Promise.all([
    buildThreaded("llvm", { localize: true }),
    buildInstance("b", "c"),
  ]);
  // The composed archive's link surface stays exactly the declared set:
  // thread-local storage adds no external definitions (M1's one Darwin
  // ASan image-registration common included in a sanitized build), and the
  // TLS access machinery undefineds are the platform runtime's, never
  // scriptc's.
  const { defined, undef } = nmSymbols(archiveT);
  const toolchainDefinitions = sanitize
    ? [process.platform === "darwin" ? "___asan_globals_registered" : "__asan_globals_registered"]
    : [];
  expect([...defined].sort()).toEqual(
    [
      "mt_boom", "mt_bump", "mt_calls_seen", "mt_collect", "mt_init", "mt_perf_now", "mt_set_panic_sink", "mt_sum_to", "mt_uptime",
      ...toolchainDefinitions,
    ].sort(),
  );
  expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("mt_") || s.startsWith("mb_"))).toEqual([]);
  const probe = buildThreadProbe(join(threadFixtureDir, "probe_pair.c"), [archiveT, archiveB], "t-pair");
  const run = spawnSync(probe, { encoding: "utf8", timeout: 60_000 });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(normalizeProbeOut(run.stdout)).toBe(`multi-b ready
t0: bump x100 -> 101, calls_seen 100, sums_ok=1, trap fell through 0
t0 sink: calls=1 ctx_ok=1 code=[SC4014] symbol=[mt_boom]
t1: bump x200 -> 201, calls_seen 200, sums_ok=1, post_ok=1
b: sums_ok=1 adds_ok=1 post_ok=1
other sinks: t1=0 b=0
`);
});

/* ASan has no x86_64-windows-gnu runtime; the sanitized pairing stays a
 * darwin/linux contract. */
const asanTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
asanTest("M8: M6 under ASan", async () => {
  const archive = await buildThreaded("llvm", { sanitize: true });
  const probe = buildThreadProbe(join(threadFixtureDir, "probe.c"), [archive], "t-asan", { sanitize: true });
  // An instance's lifetime is its thread's, with no teardown at thread
  // exit (the documented contract) — once the worker threads end, their
  // thread-local roots are gone and Linux LSan's unreachable-at-exit
  // accounting would flag contractually-held state. Point it away exactly
  // as the sanitized suite lanes do; Apple ASan carries no leak checker.
  const env =
    process.platform === "linux" ? { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } : process.env;
  const run = spawnSync(probe, { encoding: "utf8", timeout: 120_000, env });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(THREADED_EXPECTED);
});

/* ── M9: profile shape ───────────────────────────────────────────────────── */

test("M9: abi.instance_per_thread is strictly boolean", () => {
  const dir = join(cacheDir, "profile-shape-thread");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "profile.json");
  const base = {
    profile_format: 1,
    name: "shape",
    entry: "lib.ts",
    emission: "llvm",
    abi: {
      prefix: "sp_",
      init_symbol: "sp_init",
      sink_register_symbol: "sp_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [],
  };
  for (const invalid of [1, "yes", null] as const) {
    writeFileSync(path, JSON.stringify({
      ...base,
      abi: { ...base.abi, instance_per_thread: invalid },
    }));
    const refused = loadLibraryProfile(path);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.diagnostics[0]!.code).toBe("SC4001");
      expect(refused.diagnostics[0]!.message).toContain("abi.instance_per_thread");
    }
  }
  // The boolean forms load, and absence means false.
  for (const [value, expected] of [[true, true], [false, false], [undefined, false]] as const) {
    const abi: Record<string, unknown> = { ...base.abi };
    if (value !== undefined) abi["instance_per_thread"] = value;
    writeFileSync(path, JSON.stringify({ ...base, abi }));
    const loaded = loadLibraryProfile(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.profile.instancePerThread).toBe(expected);
  }
});

/* ── M10/M11: cross-target localization (SCRIPTC_CROSS=1) ─────────────────
 * Gated exactly like library-cross.test.ts: zig on PATH is the lane's hard
 * requirement, execution legs additionally gate on the docker daemon
 * (SCRIPTC_LINUX=1) and the ssh box (SCRIPTC_WIN=1). Never part of the
 * default suites. */

const crossOn = process.env["SCRIPTC_CROSS"] === "1";

/* The embedder-relevant cross list (library-cross's, minus the macos
 * triple off darwin hosts — Mach-O localization runs the macOS host
 * linker, and M4 pins that refusal). */
const CROSS_TARGETS = [
  "aarch64-linux-gnu.2.36",
  "x86_64-linux-gnu.2.36",
  "x86_64-linux-musl",
  "x86_64-windows-gnu",
  ...(process.platform === "darwin" ? (["x86_64-macos"] as const) : []),
] as const;
type CrossTarget = (typeof CROSS_TARGETS)[number];

/** buildInstance with SCRIPTC_CC/SCRIPTC_TARGET threaded through the env
 * the cc driver reads (the library-cross pattern — tests in this file run
 * sequentially and every build is awaited, so the flips never interleave).
 * Cross builds are plain-flavor: the sanitized lanes stay host contracts. */
function buildInstanceCross(
  instance: "a" | "b",
  emission: Emission,
  target: CrossTarget,
): Promise<string> {
  const key = `x-${instance}-${emission}-${target}`;
  let archive = built.get(key);
  if (archive === undefined) {
    archive = (async () => {
      const outDir = join(cacheDir, key);
      mkdirSync(outDir, { recursive: true });
      const profile = JSON.parse(readFileSync(join(fixtureDir, `profile_${instance}.json`), "utf8")) as {
        entry: string;
        emission: string;
      };
      profile.emission = emission;
      profile.entry = join(fixtureDir, profile.entry);
      const profilePath = join(outDir, "profile.json");
      writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      const prevCc = process.env["SCRIPTC_CC"];
      const prevTarget = process.env["SCRIPTC_TARGET"];
      process.env["SCRIPTC_CC"] = "zigcc";
      process.env["SCRIPTC_TARGET"] = target;
      try {
        const result = await compileLibrary({ profilePath, outDir });
        if (!result.ok) {
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        }
        expect(result.backend).toBe(emission);
        return result.archivePath;
      } finally {
        if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
        else process.env["SCRIPTC_CC"] = prevCc;
        if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
        else process.env["SCRIPTC_TARGET"] = prevTarget;
      }
    })();
    built.set(key, archive);
  }
  return archive;
}

/** Cross-link the two-archive probe with `zig cc` — the target's libc/libm
 * plus the documented win32 embedder libs. Link success is itself an
 * assertion: every undefined in the localized member resolved against
 * exactly what an embedder links. */
function buildCrossProbe(archives: string[], source: string, tag: string, target: CrossTarget): string {
  const outDir = join(cacheDir, "probes");
  mkdirSync(outDir, { recursive: true });
  const bin = join(outDir, `probe-${tag}${target.includes("windows") ? ".exe" : ""}`);
  execFileSync("zig", [
    "cc",
    "-std=c11",
    "-target", target,
    "-pthread",
    source,
    ...archives,
    "-lm",
    ...(target.includes("windows") ? WIN32_EMBEDDER_LIBS : []),
    "-o", bin,
  ]);
  return bin;
}

describe.skipIf(!crossOn)("cross-target localization", () => {
  test("zig is on PATH", () => {
    try {
      execFileSync("zig", ["version"], { encoding: "utf8" });
    } catch {
      throw new Error("SCRIPTC_CROSS=1 needs zig on PATH (zigup) — the lane cross-compiles with `zig cc`.");
    }
  });

  describe.each(CROSS_TARGETS)("target %s", (target) => {
    describe.each(EMISSIONS)("%s emission", (emission) => {
      test("M10: localized archives cross-build; symbols exact, ambient audit holds, probe links", async () => {
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        for (const [archive, declared] of [
          [archiveA, A_SYMBOLS],
          [archiveB, B_SYMBOLS],
        ] as const) {
          const { defined, undef } = nmSymbols(archive);
          expect([...defined].sort()).toEqual([...declared].sort());
          expect([...undef].filter((s) => s.startsWith("scr_") || s.startsWith("ma_") || s.startsWith("mb_"))).toEqual([]);
          for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
            for (const spelling of [banned, `_imp_${banned}`]) {
              expect(undef.has(spelling), `undefined reference to ${spelling}`).toBe(false);
            }
          }
        }
        buildCrossProbe([archiveA, archiveB], join(fixtureDir, "probe.c"), `x-${emission}-${target}`, target);
      });
    });
  });

  /* ── M11: execution where infrastructure exists ─────────────────────── */
  describe("M11 execution probes", () => {
    const linuxOn = process.env["SCRIPTC_LINUX"] === "1";
    const winOn = process.env["SCRIPTC_WIN"] === "1";
    const nodeVersion = (): string => readFileSync(join(repoRoot, ".node-version"), "utf8").trim();

    test.skipIf(!linuxOn).for([
      ["aarch64-linux-gnu.2.36", "llvm"],
      ["x86_64-linux-gnu.2.36", "llvm"],
      ["x86_64-linux-gnu.2.36", "c"],
      ["x86_64-linux-musl", "llvm"],
    ] as const)(
      "M11: the two-instance probe runs in the container (%s, %s emission)",
      async ([target, emission]) => {
        const archiveA = await buildInstanceCross("a", emission, target);
        const archiveB = await buildInstanceCross("b", emission, target);
        const probe = buildCrossProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `x-run-${emission}-${target}`,
          target,
        );
        const distro = target.includes("linux-musl") ? "alpine" : "bookworm";
        const out = execFileSync(
          "docker",
          [
            "run", "--rm",
            "--platform", target.startsWith("x86_64") ? "linux/amd64" : "linux/arm64",
            "-v", `${repoRoot}:${repoRoot}`,
            `node:${nodeVersion()}-${distro}`,
            probe,
          ],
          { encoding: "utf8", timeout: 240_000 },
        );
        expect(out).toBe(PROBE_EXPECTED);
      },
      300_000,
    );

    test.skipIf(!winOn).for(EMISSIONS)(
      "M11: the two-instance probe runs on the Windows box (%s emission)",
      async (emission) => {
        const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
        const dirWin = "C:\\Users\\rdp\\work\\scriptc-mloc-lane";
        const archiveA = await buildInstanceCross("a", emission, "x86_64-windows-gnu");
        const archiveB = await buildInstanceCross("b", emission, "x86_64-windows-gnu");
        const probe = buildCrossProbe(
          [archiveA, archiveB],
          join(fixtureDir, "probe.c"),
          `x-run-${emission}-win`,
          "x86_64-windows-gnu",
        );
        const ssh = (cmd: string): string =>
          execFileSync("ssh", ["-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", timeout: 120_000 });
        try {
          ssh(`cmd /c if not exist ${dirWin} mkdir ${dirWin}`);
          execFileSync("scp", ["-q", probe, `${host}:C:/Users/rdp/work/scriptc-mloc-lane/probe-${emission}.exe`], {
            timeout: 120_000,
          });
          const out = ssh(`cd /d ${dirWin} && probe-${emission}.exe`);
          // The PROBE's printf rides the mingw CRT's text-mode stdout
          // (CRLF) — the library-cross windows leg's one normalization.
          expect(out.replaceAll("\r\n", "\n")).toBe(PROBE_EXPECTED);
        } finally {
          try {
            ssh(`cmd /c rmdir /S /Q ${dirWin}`);
          } catch {
            /* cleanup is best-effort — never mask the real failure */
          }
        }
      },
      300_000,
    );

    test.skipIf(!winOn)(
      "M11: a thread-instanced and runtime-localized archive runs on the Windows box",
      async () => {
        const host = process.env["SCRIPTC_WIN_HOST"] ?? "windows-dev";
        const dirWin = "C:\\Users\\rdp\\work\\scriptc-mloc-lane-t";
        const key = "x-t-llvm-win";
        let archive = built.get(key);
        if (archive === undefined) {
          archive = (async () => {
            const outDir = join(cacheDir, key);
            mkdirSync(outDir, { recursive: true });
            const profile = JSON.parse(readFileSync(join(threadFixtureDir, "profile_t.json"), "utf8")) as {
              entry: string;
              emission: string;
              abi: Record<string, unknown>;
            };
            profile.emission = "llvm";
            profile.entry = join(threadFixtureDir, profile.entry);
            profile.abi["localize_runtime"] = true;
            const profilePath = join(outDir, "profile.json");
            writeFileSync(profilePath, JSON.stringify(profile, null, 2));
            const prevCc = process.env["SCRIPTC_CC"];
            const prevTarget = process.env["SCRIPTC_TARGET"];
            process.env["SCRIPTC_CC"] = "zigcc";
            process.env["SCRIPTC_TARGET"] = "x86_64-windows-gnu";
            try {
              const result = await compileLibrary({ profilePath, outDir });
              if (!result.ok) {
                throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
              }
              return result.archivePath;
            } finally {
              if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
              else process.env["SCRIPTC_CC"] = prevCc;
              if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
              else process.env["SCRIPTC_TARGET"] = prevTarget;
            }
          })();
          built.set(key, archive);
        }
        const probe = buildCrossProbe(
          [await archive],
          join(threadFixtureDir, "probe.c"),
          "x-run-t-win",
          "x86_64-windows-gnu",
        );
        const ssh = (cmd: string): string =>
          execFileSync("ssh", ["-o", "ConnectTimeout=15", host, cmd], { encoding: "utf8", timeout: 120_000 });
        try {
          ssh(`cmd /c if not exist ${dirWin} mkdir ${dirWin}`);
          execFileSync("scp", ["-q", probe, `${host}:C:/Users/rdp/work/scriptc-mloc-lane-t/probe-t.exe`], {
            timeout: 120_000,
          });
          const out = ssh(`cd /d ${dirWin} && probe-t.exe`);
          expect(out.replaceAll("\r\n", "\n")).toBe(THREADED_EXPECTED);
        } finally {
          try {
            ssh(`cmd /c rmdir /S /Q ${dirWin}`);
          } catch {
            /* cleanup is best-effort — never mask the real failure */
          }
        }
      },
      300_000,
    );
  });
});
