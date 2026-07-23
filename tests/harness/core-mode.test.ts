/* Core (library) emission mode — the K-fixture conformance suite over the
 * ratified design. Every fixture runs TWICE, once per emission, with the
 * profile's `emission` field flipped by the harness, and outputs (sink
 * message text included) must be identical across the two runs — the
 * "reference/differential emission" posture; core mode has no fallback
 * concept.
 *
 *   K1  symbols-exact       nm over the archive: prefix-carrying external
 *                           definitions equal the declared set, both
 *                           directions; no prefix-carrying undefineds
 *   K2  scalar-roundtrip    f64 (-0, NaN, MAX_SAFE_INTEGER), bool, and the
 *                           u8/u32/i32 plumbing classes
 *   K3  buffer-roundtrip    string/bytes in/out, NUL-termination, NULL with
 *                           len 0, BOTH arena postures over one core
 *   K4  init-rerun          three identical sessions (globals, refcounted
 *                           state, run-once guards all reset)
 *   K5  trap-to-sink-once   the range trap's message + address exactly
 *                           once, no process termination from compiled
 *                           code; a trap during init routes the same
 *   K6  pre-registration    a trap before sink registration aborts
 *   K7  escaped-throw       "Uncaught ..." reaches the sink; the poisoned
 *                           core aborts every later entry deterministically
 *   K8  ambient-audit       no undefined refs to sigaction/signal/
 *                           pthread_create/atexit anywhere in the archive
 *   K9  refusals            SC4002/SC4003/SC4004/SC4005/SC4007 with the
 *                           profile-teaching rider (SC4001 has its own
 *                           suite in core-profile.test.ts)
 *   K10 sanitized-lane      K4/K5/K7 re-run under ASan + the RC audit
 *                           (arming the per-session zero-live-heap seam)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileCore } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/core-mode");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/core-mode");

type Emission = "llvm" | "c";
const EMISSIONS: Emission[] = ["llvm", "c"];

interface BuildOpts {
  sanitize?: boolean;
  /** Patch a declared result-reset symbol into the profile (K3's second
   * arena posture). */
  declaredReset?: string;
}

/** Build one fixture's core archive for one emission: the fixture's
 * profile.json is patched (emission flipped, entry made absolute, posture
 * overridden when asked) into the build dir, then compiled through the
 * real compileCore pipeline. */
async function buildCore(
  fixture: string,
  emission: Emission,
  opts: BuildOpts = {},
): Promise<{ archive: string; outDir: string }> {
  const dir = join(fixtureRoot, fixture);
  const tag = `${fixture}-${emission}${opts.sanitize ? "-san" : ""}${opts.declaredReset !== undefined ? "-reset" : ""}`;
  const outDir = join(cacheDir, tag);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as {
    entry: string;
    emission: string;
    abi: { result_reset_symbol: string | null };
  };
  profile.emission = emission;
  profile.entry = join(dir, profile.entry);
  if (opts.declaredReset !== undefined) profile.abi.result_reset_symbol = opts.declaredReset;
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const result = await compileCore({
    profilePath,
    outDir,
    sanitize: opts.sanitize ?? false,
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  expect(result.backend).toBe(emission);
  return { archive: result.archivePath, outDir };
}

function buildProbe(
  fixture: string,
  archive: string,
  outDir: string,
  opts: { sanitize?: boolean; defines?: string[] } = {},
): string {
  const bin = join(outDir, "probe");
  execFileSync("clang", [
    "-std=c11",
    ...(opts.sanitize ? ["-fsanitize=address"] : []),
    ...(opts.defines ?? []).map((d) => `-D${d}`),
    join(fixtureRoot, fixture, "probe.c"),
    archive,
    "-lm",
    "-o", bin,
  ]);
  return bin;
}

function runProbe(bin: string, args: string[] = []): { stdout: string; status: number | null; signal: string | null } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout ?? "", status: r.status, signal: r.signal };
}

/** nm over the archive: [definedExternal, undefined] symbol sets, macOS/
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

/* ── K2 + K1 + K8: scalars ─────────────────────────────────────────────── */

const SCALARS_EXPECTED = `scalars ready
add: 0.30000000000000004
max-safe exact: 1
nan passthrough: 1
neg zero sign: 1
is_nan(NaN): 1
is_nan(1): 0
invert(0): 1
invert(7): 0
plumb: 40000254995
`;

const SCALARS_SYMBOLS = [
  "kt_add", "kt_passthrough", "kt_neg_zero", "kt_is_nan", "kt_invert", "kt_plumb",
  "kt_init", "kt_set_panic_sink", "kt_collect",
];

describe.each(EMISSIONS)("core mode, %s emission", (emission) => {
  test("K1/K2/K8: scalar round-trips, symbol exactness, ambient audit", async () => {
    const { archive, outDir } = await buildCore("scalars", emission);

    // K2: the scripted call sequence.
    const probe = buildProbe("scalars", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SCALARS_EXPECTED);

    // K1: prefix-carrying external definitions equal the declared set
    // exactly, both directions; no prefix-carrying undefineds.
    const { defined, undef } = nmSymbols(archive);
    const prefixDefined = [...defined].filter((s) => s.startsWith("kt_")).sort();
    expect(prefixDefined).toEqual([...SCALARS_SYMBOLS].sort());
    expect([...undef].filter((s) => s.startsWith("kt_"))).toEqual([]);

    // K8: the mechanical ambient audit — the archive references none of
    // the process-disposition or threading surface, and registers no
    // atexit handlers (core teardown is the reset registry).
    for (const banned of ["sigaction", "signal", "pthread_create", "atexit", "setvbuf"]) {
      expect(undef.has(banned), `undefined reference to ${banned}`).toBe(false);
    }
  });

  /* ── K3: buffers, both arena postures over one core ──────────────────── */

  const BUFFERS_EXPECTED = `buffers ready
shout: ABC! (len 4, nul 1)
both live: ABC! / a-b-c
strlen empty (NULL, 0): 0
strlen utf8: 4
wrap: len 4 bytes 60 1 2 62
wrap empty: len 2 bytes 60 62
`;

  test("K3: buffer round-trips + lifetime, auto-reset posture", async () => {
    const { archive, outDir } = await buildCore("buffers", emission);
    const probe = buildProbe("buffers", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  });

  test("K3: buffer lifetime, declared-reset posture (results accumulate)", async () => {
    const { archive, outDir } = await buildCore("buffers", emission, { declaredReset: "kb_reset" });
    const probe = buildProbe("buffers", archive, outDir, { defines: ["DECLARED_RESET"] });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  });

  /* ── K4: init re-run determinism ─────────────────────────────────────── */

  const SESSION = `session start counter=0
bump: 1 2
note: 1 2
recall: a,b
`;

  test("K4: three init sessions are byte-identical", async () => {
    const { archive, outDir } = await buildCore("reinit", emission);
    const probe = buildProbe("reinit", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SESSION + SESSION + SESSION);
  });

  /* ── K5/K6/K7: the trap channel ──────────────────────────────────────── */

  test("K5: a trap delivers to the sink exactly once, host survives", async () => {
    const { archive, outDir } = await buildCore("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["trap"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `traps ready
sink[1]: scriptc: RangeError: array index 9 out of bounds (length 3)
addr: nonzero
survived, sink_calls=1
`,
    );
  });

  test("K5: a trap during init routes to the sink the same way", async () => {
    const { archive, outDir } = await buildCore("init-trap", emission);
    const probe = buildProbe("init-trap", archive, outDir);
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `about to trap
sink[1]: scriptc: RangeError: array index 7 out of bounds (length 3)
survived init trap, sink_calls=1
`,
    );
  });

  test("K7: an escaped throw reaches the sink as 'Uncaught ...'", async () => {
    const { archive, outDir } = await buildCore("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["throw"]);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `traps ready
sink[1]: Uncaught Error: kaput
addr: nonzero
survived, sink_calls=1
`,
    );
  });

  test("K7: the poisoned core aborts every later entry", async () => {
    const { archive, outDir } = await buildCore("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["poisoned"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).toContain("poisoned now");
    expect(run.stdout).not.toContain("UNREACHABLE");
  });

  test("K6: a trap before sink registration aborts", async () => {
    const { archive, outDir } = await buildCore("traps", emission);
    const probe = buildProbe("traps", archive, outDir);
    const run = runProbe(probe, ["preregister"]);
    expect(run.signal).toBe("SIGABRT");
    expect(run.stdout).not.toContain("UNREACHABLE");
  });

  /* ── K10: the sanitized lane (ASan + the RC audit's re-init seam) ────── */

  test("K10: K4 under ASan + RC audit (zero live heap across re-init)", async () => {
    const { archive, outDir } = await buildCore("reinit", emission, { sanitize: true });
    const probe = buildProbe("reinit", archive, outDir, { sanitize: true });
    const run = runProbe(probe);
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(SESSION + SESSION + SESSION);
  });

  test("K10: K5/K7 under ASan", async () => {
    const { archive, outDir } = await buildCore("traps", emission, { sanitize: true });
    const probe = buildProbe("traps", archive, outDir, { sanitize: true });
    const trap = runProbe(probe, ["trap"]);
    expect(trap.status).toBe(0);
    expect(trap.stdout).toContain("survived, sink_calls=1");
    const thrown = runProbe(probe, ["throw"]);
    expect(thrown.status).toBe(0);
    expect(thrown.stdout).toContain("sink[1]: Uncaught Error: kaput");
  });
});

/* ── K9: the SC4xxx refusal family, end to end through compileCore ─────── */

let refusalCounter = 0;
async function refusal(
  source: string,
  profilePatch: Record<string, unknown>,
): Promise<{ code: string; message: string; hint?: string }[]> {
  const outDir = join(cacheDir, `refusal-${refusalCounter++}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "core.ts");
  writeFileSync(entry, source);
  const profile = {
    profile_format: 1,
    name: "refusal-fixture",
    entry,
    emission: "c",
    abi: {
      prefix: "kx_",
      init_symbol: "kx_init",
      sink_register_symbol: "kx_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: [] as unknown[],
    ...profilePatch,
  };
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  const result = await compileCore({ profilePath, outDir });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.diagnostics.map((d) => ({ code: d.code, message: d.message, ...(d.hint !== undefined ? { hint: d.hint } : {}) }));
}

describe("K9: core-mode refusals", () => {
  test("SC4002: unmapped export name", async () => {
    const diags = await refusal(`export function real(): number { return 1; }\n`, {
      exports: [{ export: "nope", symbol: "kx_nope", params: [], returns: "f64" }],
    });
    expect(diags[0]!.code).toBe("SC4002");
    expect(diags[0]!.message).toContain("'nope'");
    expect(diags[0]!.hint).toContain("facade");
  });

  test("SC4003: a parameter outside the marshalling classes", async () => {
    const diags = await refusal(
      `export function take(r: { a: number }): number { return r.a; }\n`,
      { exports: [{ export: "take", symbol: "kx_take", params: ["f64"], returns: "f64" }] },
    );
    expect(diags[0]!.code).toBe("SC4003");
    expect(diags[0]!.message).toContain("parameter 1");
    expect(diags[0]!.hint).toContain("asks 2/3");
  });

  test("SC4003: arity mismatch between profile and signature", async () => {
    const diags = await refusal(`export function two(a: number, b: number): number { return a + b; }\n`, {
      exports: [{ export: "two", symbol: "kx_two", params: ["f64"], returns: "f64" }],
    });
    expect(diags[0]!.code).toBe("SC4003");
    expect(diags[0]!.message).toContain("2 parameter(s)");
  });

  test("SC4004: a mapped async export, with the profile teaching", async () => {
    const diags = await refusal(`export async function tick(): Promise<number> { return 1; }\n`, {
      exports: [{ export: "tick", symbol: "kx_tick", params: [], returns: "f64" }],
      determinism: { teachings: { async: "use the host scheduler entry instead" } },
    });
    expect(diags[0]!.code).toBe("SC4004");
    expect(diags[0]!.hint).toContain("synchronous facade");
    expect(diags[0]!.hint).toContain("use the host scheduler entry instead");
  });

  test("SC4005: a timer anywhere in the graph, teaching verbatim", async () => {
    const diags = await refusal(`setTimeout(() => {}, 1);\nexport function f(): number { return 1; }\n`, {
      exports: [{ export: "f", symbol: "kx_f", params: [], returns: "f64" }],
      determinism: { teachings: { SC4005: "schedule through the embedder frame loop" } },
    });
    expect(diags[0]!.code).toBe("SC4005");
    expect(diags[0]!.message).toContain("timers");
    expect(diags[0]!.hint).toContain("schedule through the embedder frame loop");
  });

  test("SC4007: a generic export", async () => {
    const diags = await refusal(
      `export function id<T>(x: T): T { return x; }\nconsole.log(id(1));\n`,
      { exports: [{ export: "id", symbol: "kx_id", params: ["f64"], returns: "f64" }] },
    );
    expect(diags[0]!.code).toBe("SC4007");
    expect(diags[0]!.hint).toContain("concrete instantiation");
  });
});
