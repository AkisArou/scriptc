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
 *                        Darwin ASan's one image-registration common in a
 *                        sanitized build), and undefineds stay libc/libm-
 *                        shaped apart from sanitizer ABI references
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
 *   M4 target posture    localization is host-native: a cross-target build
 *                        refuses SC3002 before emission
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary, loadLibraryProfile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/library-mode/multi");
const localizationTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
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
  const defined = parse(execFileSync("nm", ["-gU", archive], { encoding: "utf8" }));
  const undef = parse(execFileSync("nm", ["-u", archive], { encoding: "utf8" }));
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
  localizationTest("M1: external definitions equal the declared set exactly", async () => {
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
      // Darwin ASan's image-wide registration guard is the sole sanitized
      // exception: keeping its COMMON shared makes the final Mach-O image
      // register its ASan globals exactly once when N archives contribute
      // module constructors.
      const toolchainDefinitions =
        sanitize && process.platform === "darwin"
          ? ["___asan_globals_registered"]
          : [];
      expect([...defined].sort()).toEqual([...declared, ...toolchainDefinitions].sort());
      // Undefineds: no runtime-internal or prefix-carrying reference
      // escapes; libc/libm (and sanitizer ABI) references keep their global
      // binding.
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
  const bin = join(outDir, `probe-${tag}`);
  mkdirSync(outDir, { recursive: true });
  execFileSync("clang", [
    "-std=c11",
    "-pthread",
    ...(sanitize ? ["-fsanitize=address"] : []),
    join(fixtureDir, "probe.c"),
    archiveA,
    archiveB,
    "-lm",
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
    expect(run.stdout).toBe(PROBE_EXPECTED);
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

test("M4: a cross-target build refuses runtime localization with SC3002", async () => {
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
  const prevCc = process.env["SCRIPTC_CC"];
  const prevTarget = process.env["SCRIPTC_TARGET"];
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = "x86_64-linux-musl";
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("x86_64-linux-musl");
      expect(result.diagnostics[0]!.message).toContain("runtime-localized");
    }
  } finally {
    if (prevCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = prevCc;
    if (prevTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = prevTarget;
  }
});

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
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe("SC3002");
      expect(result.diagnostics[0]!.message).toContain("win32");
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
