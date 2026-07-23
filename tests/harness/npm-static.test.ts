/* --npm-static: opted-in npm packages' shipped JS compiles STATICALLY as
 * program modules (no island) — the slice-2 pilot. Three tiers pinned
 * here:
 *
 *   1. GREEN pilots (escape-string-regexp, slash — real packages, vendored
 *      under tests/fixtures/npm-static): fully static builds whose stdout
 *      byte-matches Node across the argv-free programs.
 *   2. HONEST PARTIALS (ms, picocolors, commander): the packages COMPILE
 *      (preflight admits them; the coverage report says "static") but
 *      carry runtime fences on driven paths — the coverage numbers are
 *      pinned so the frontier only moves deliberately.
 *   3. The FALLBACK contract: a package whose preflight refuses (an
 *      unshimmed-builtin require inside its files) drops back to the
 *      island under --dynamic with a coverage note — never a build
 *      failure, and the flag never changes a flagless build.
 *
 * The flag defaults OFF: nothing here touches the production npm/island
 * lanes (npm.test.ts, vercel-e2e.test.ts pin those). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const pilotRoot = join(fixturesRoot, "npm-static");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: Buffer;
  exitCode: number;
}

async function runBinary(cmd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "buffer" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout)) throw err;
    return { stdout: e.stdout, exitCode: e.code };
  }
}

/** Compile one pilot statically (no --dynamic — the whole point) with the
 * named packages opted in; cache-keyed over the program and the vendored
 * packages. */
async function buildStatic(entry: string, npmStatic: string[] | "auto"): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(pilotRoot, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash
    .update(npmStatic === "auto" ? "auto" : npmStatic.join(","))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `npm-static-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    npmStatic,
    // Pinned: the suite pins --npm-static's FRONTEND frontier (coverage
    // numbers, fence sites); the backend lane is held fixed so those pins
    // move only when the frontend moves.
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "npm-static pilot failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe(`npm-static pilots${sanitize ? " (sanitized)" : ""}`, () => {
  // Tier 1: fully static, byte-exact against Node. ms's driven surface —
  // BOTH the parse and format directions — joined when implicit-any
  // monomorphization and aliased-typeof narrowing landed; its one
  // remaining fence sits on the garbage-input path (pinned below), which
  // ms-cli.ts deliberately never drives.
  test.for([
    ["escape-string-regexp", "escape-cli.ts"],
    ["slash", "slash-cli.ts"],
    ["ms", "ms-cli.ts"],
    // dualist pins the "node" exports condition: Node runs ./node.js
    // (yaml's browser-vs-node shape) and the opted-in resolution must
    // land on the SAME artifact, never the browser build.
    ["dualist", "dualist-cli.ts"],
  ] as const)("%s compiles statically and byte-matches Node", async ([pkg, file]) => {
    const entry = join(pilotRoot, file);
    const binary = await buildStatic(entry, [pkg]);
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  // Tier 1, auto mode: the eligibility heuristics pick escape-string-regexp
  // (own .d.ts, unminified, no transform markers) without naming it.
  test("--npm-static=auto opts the eligible pilot in", () => {
    const { coverage } = analyze(join(pilotRoot, "escape-cli.ts"), { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([
      { package: "escape-string-regexp", status: "static" },
    ]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);
  }, 120_000);

  // Auto's runtime-JS probe anchors at the IMPORTING file, not the entry:
  // shouty is installed only in inner/'s node_modules (the pnpm-monorepo
  // shape — vercel's CLI deps live in packages/cli/node_modules while the
  // analysis driver sits outside every package realm), so an entry-anchored
  // probe answers "no runtime JS entry resolves" for an ordinary install.
  test("--npm-static=auto probes runtime JS from the importing file's realm", async () => {
    const entry = join(pilotRoot, "nested/main.ts");
    const { coverage } = analyze(entry, { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([{ package: "shouty", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);
    const binary = await buildStatic(entry, "auto");
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(binary, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  // Auto refuses ms: it ships no own .d.ts (the declared-claim criterion),
  // so the import keeps today's story — and the explicit opt-in below is
  // the user's override.
  test("--npm-static=auto refuses a package with no own .d.ts", () => {
    const { coverage } = analyze(join(pilotRoot, "ms-cli.ts"), { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([
      {
        package: "ms",
        status: "fallback",
        detail: "auto: it ships no own .d.ts declaration surface",
      },
    ]);
  }, 120_000);

  // ms's coverage, pinned: aliased-typeof narrowing carried the entry
  // conditional (`var type = typeof val` — the checker only narrows const
  // aliases), and the whole driven surface is static. What remains is
  // parse()'s undefined-returning GARBAGE paths against its JSDoc
  // `@return {Number}` claim: two bare `return;`s stay runtime fences,
  // and the switch's `return undefined` now COMPILES to the stranded-unit
  // trap (divergence 335) — the same loud TypeError, thrown by compiled
  // code instead of a deferred fence. Node answers undefined there, a
  // value the declared representation cannot hold, so each path traps
  // loudly instead of misbehaving. The frontier only moves deliberately.
  test("ms compiles static with the JSDoc-contradicting undefined returns pinned", () => {
    const { coverage } = analyze(join(pilotRoot, "ms-cli.ts"), { npmStatic: ["ms"] });
    expect(coverage.npmStatic).toEqual([{ package: "ms", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0); // builds — fences are runtime
    const fences = coverage.runtimeFences ?? [];
    expect(fences.length).toBe(2);
    for (const f of fences) {
      expect(f.message).toMatch(/bare 'return'/);
    }
  }, 120_000);

  // Tier 2: commander opts in and COMPILES as program modules — the
  // coverage floor is pinned (≥85% of ~1200 statements static) so frontier
  // regressions surface here, while the remaining runtime fences keep the
  // differential on the island lane (npm.test.ts) for now. Implicit-any
  // monomorphization moved the driven frontier BEHIND the typed-value →
  // untyped-param boundary (methods like _registerCommand and local
  // helpers like knownBy now instantiate per argument types); the next
  // fences are implicit-any FIELD writes of class instances (`cmd.parent
  // = this` — the field inferred `any` from its ctor null) and
  // getter/setter JSDoc union returns (`cmd.name()` → string | Command).
  test("commander compiles static at the pinned coverage floor", () => {
    const { coverage } = analyze(join(fixturesRoot, "commander-calc/calc-npm-static.ts"), {
      npmStatic: ["commander"],
    });
    expect(coverage.npmStatic).toEqual([{ package: "commander", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0); // builds — fences are runtime
    const total = coverage.stats.statementsTotal + (coverage.unreached?.stats.statementsTotal ?? 0);
    const failed = coverage.stats.statementsFailed + (coverage.unreached?.stats.statementsFailed ?? 0);
    expect(total).toBeGreaterThan(1000); // the whole package joined the program
    expect((total - failed) / total).toBeGreaterThanOrEqual(0.85);
  }, 180_000);

  // Tier 3: the island fallback — esbundled's chunk requires "net", an
  // unshimmed-builtin edge preflight refuses for a static package, so the
  // opt-in DROPS with a note and the --dynamic build keeps the exact
  // island behavior lazybuiltin.ts pins in npm.test.ts.
  test("a preflight-refused package falls back to the island with a note", () => {
    const { coverage } = analyze(join(fixturesRoot, "npm/divergent/lazybuiltin.ts"), {
      dynamic: true,
      npmStatic: ["esbundled"],
    });
    const statuses = coverage.npmStatic ?? [];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.package).toBe("esbundled");
    expect(statuses[0]?.status).toBe("fallback");
    expect(coverage.preflightFailed).toBe(false);
  }, 120_000);

  // AUTO drops a package whose opt-in breaks the PROGRAM's own typecheck
  // (the .d.ts-overload vs inferred-surface gap — commander's chaining
  // shape in miniature): chainy's declared `name(): string / name(v):
  // this` overloads admit the chained spelling, its inferred surface
  // (`string | Chainy`) does not, so auto answers fallback with the
  // inferred-surface note and the program stays analyzable. Explicit
  // opt-ins keep the errors (the user asked for exactly that package).
  test("auto falls back when the program fails against an inferred surface", () => {
    const { coverage } = analyze(join(pilotRoot, "chainy-cli.ts"), { npmStatic: "auto" });
    expect(coverage.npmStatic).toEqual([
      {
        package: "chainy",
        status: "fallback",
        detail: "auto: the program does not typecheck against its inferred surface",
      },
    ]);
    expect(coverage.preflightFailed).toBe(false);
  }, 120_000);

  // Checker errors in node_modules JS the opt-in never NAMED never gate
  // the build: maxNodeModuleJsDepth (active on every --npm-static load)
  // admits ANY node_modules JS the checker's resolution touches — the
  // punycode-through-@types/node shape — and those files' errors are the
  // same foreign-tsconfig story as an opted-in package's own. typegapped
  // ships no .d.ts, its JS does not typecheck here, and it stays on the
  // island while escape-string-regexp compiles statically beside it.
  test("a non-opted node_modules JS file's checker errors never gate the build", () => {
    const { coverage } = analyze(join(pilotRoot, "typegap-mix.ts"), {
      dynamic: true,
      npmStatic: ["escape-string-regexp"],
    });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toHaveLength(0);
    expect(coverage.npmStatic).toEqual([{ package: "escape-string-regexp", status: "static" }]);
  }, 120_000);

  // WORKSPACE-LINKED packages: node_modules/wslinked is a symlink whose
  // realpath lies outside every node_modules (the monorepo-internal
  // install every workspace tool produces). The opt-in compiles its
  // shipped dist statically as program modules — the fs shadow hides the
  // declaration twins along the realpath'd internal edges, resolution
  // lands on the runtime JS, and the binary byte-matches Node.
  test("a workspace-linked package compiles statically under --npm-static", async () => {
    const entry = join(fixturesRoot, "npm/cases/workspace-linked/main.ts");
    const { coverage } = analyze(entry, { npmStatic: ["wslinked"] });
    expect(coverage.npmStatic).toEqual([{ package: "wslinked", status: "static" }]);
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.stats.statementsFailed).toBe(0);

    const outDir = join(cacheDir, "npm-static-workspace");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outPath: join(outDir, "program"), outDir, sanitize, npmStatic: ["wslinked"] });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry]),
      runBinary(result.binaryPath, []),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  // The FLAGLESS classification of the same workspace link: an npm import
  // like any other — island-capable sites (per-package attribution naming
  // 'wslinked'), never "nothing installed resolves it".
  test("a workspace-linked package classifies as an npm import without flags", () => {
    const { coverage } = analyze(join(fixturesRoot, "npm/cases/workspace-linked/main.ts"));
    expect(coverage.preflightFailed).toBe(false);
    const all = JSON.stringify(coverage.diagnostics);
    expect(all).toContain("wslinked");
    expect(all).not.toContain("nothing installed resolves");
  }, 120_000);
});
