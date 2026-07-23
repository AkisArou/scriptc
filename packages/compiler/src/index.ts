import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compileC, resolveCc, targetPlatform } from "./backend/cc.js";
import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule, LlvmUnsupportedError } from "./backend/llvm/emitter.js";
import { checkerPanicDiag, iceDiag, isCheckerPanic, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesAssert, moduleUsesDc, moduleUsesDgram, moduleUsesDynAsync, moduleUsesDynInvoke, moduleUsesEmitter, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesInspect, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesRegex, moduleUsesSearchParams, moduleUsesStream, moduleUsesSymbol, moduleUsesTls, moduleUsesZlib } from "./ir/nodes.js";
import { serializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";
import { checkPreflight, isNodeTypesPath, loadProgram, resolveNpmImport, type LoadResult } from "./frontend/program.js";
import { npmStaticIneligibleReason, npmStaticOffenders, npmStaticPackageOfPath } from "./frontend/npm-static.js";
import { provenanceSources } from "./frontend/provenance-registry.js";
import { resolveBareModule } from "./frontend/resolve.js";
import { isJsSourceFileName } from "./frontend/shared.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./frontend/lowering/lowerer.js";
import type { CoverageInput, NpmStaticStatus } from "./coverage/report.js";

export const VERSION = "0.0.1";

export { compileC, runtimeSrcDir, type CcOptions } from "./backend/cc.js";
export { emitModule } from "./backend/emission/emitter.js";
export type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
export { renderAll, renderDiagnostic } from "./diagnostics/render.js";
export { renderCoverage, type CoverageInput } from "./coverage/report.js";
export {
  generateSurfaceManifest,
  renderSurfaceManifest,
  MANIFEST_SCHEMA_VERSION,
  type SurfaceManifest,
  type SurfaceManifestEntry,
} from "./coverage/surface-manifest.js";
export { validateModule } from "./ir/validate.js";
export { ISLAND_SURFACE, type IslandFnEntry } from "./frontend/lowering/surfaces.js";
export { ambientDtsPath, overridesDtsPath } from "./frontend/program.js";
export { resolveProvenanceSources } from "./frontend/provenance.js";
export {
  setProvenanceSources,
  type ProvenancePackageSource,
  type ProvenanceSources,
} from "./frontend/provenance-registry.js";
export * as ir from "./ir/nodes.js";

export interface CompileOptions {
  /** Output executable path. Default: <outDir>/<stem>. */
  outPath: string;
  /** Where intermediates (program.c, program.ir.json) land. */
  outDir: string;
  emitIr?: boolean;
  sanitize?: boolean;
  /** Embed the dynamic-island engine (--dynamic). Off = the static default:
   * island constructs are diagnostics and nothing about codegen or linking
   * changes. */
  dynamic?: boolean;
  /** Code generator for the program TU. Unset (the release default): the
   * LLVM backend emits LLVM IR text (.ll) that rides the SAME clang
   * command line in the program-TU seat, and a program outside the LLVM
   * tier falls back to the reference C backend transparently — the IR is
   * backend-agnostic, so only the emit retries; CompileResult records the
   * lane (`backend`, plus `llvmRefusal` when the fallback engaged). ONLY a
   * tier refusal (LlvmUnsupportedError) falls back — every real diagnostic
   * and every ICE fails the build on either lane. Explicit `llvm` is the
   * debugging/CI pin and keeps the fail-loudly contract: an out-of-tier
   * program is diagnostic SC3001 naming the first unsupported construct,
   * never a silent lane change. Explicit `c` pins the C backend. */
  backend?: "c" | "llvm";
  /** --npm-static: package names whose shipped, unminified JS compiles
   * STATICALLY as program modules (inference types the bodies; statements
   * the lowering cannot prove become runtime fences). "auto" opts in every
   * directly-imported package passing the eligibility heuristics (own
   * .d.ts, unminified JS, no build-transform markers). A package whose
   * preflight refuses marks itself an offender and falls back to the
   * island (--dynamic) or the requires-dynamic diagnostic (static builds)
   * — never a silent misbuild. Off by default: nothing changes without
   * the flag. */
  npmStatic?: readonly string[] | "auto";
}

export type CompileResult =
  /** `cPath` is the generated program TU next to the binary: the .ll under
   * the LLVM backend (the default lane), the .c under the C backend (same
   * seat, same lifecycle — --keep-c in the CLI governs both). `backend` is
   * the code generator that ACTUALLY emitted the TU; `llvmRefusal` is
   * present iff the default lane fell back to C, carrying the tier
   * refusal's machine-readable kind tag ("npmEmbedding", "stmt:...", ...). */
  | { ok: true; binaryPath: string; cPath: string; irPath?: string; backend: "c" | "llvm"; llvmRefusal?: string }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

/** The LLVM backend's tier refusal as a diagnostic. SC3xxx = backend
 * coverage (the program is fine — this backend doesn't compile it yet);
 * the parenthesized kind tag is machine-readable for the differential
 * harness's histogram. */
function llvmRefusalDiag(err: LlvmUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

export interface AnalyzeResult {
  coverage: CoverageInput;
  sourceTexts: Map<string, string>;
}

/** The platform the BUILD is for — the SCRIPTC_TARGET triple's OS under a
 * cross compile, the host's otherwise. The frontend needs it too (the
 * whole program compiles for ONE platform, so path.sep / os.EOL literals
 * and the path-module binding are compile-time constants); a malformed
 * SCRIPTC_CC/SCRIPTC_TARGET combination reports at compileC exactly as
 * before, so analysis falls back to the host here rather than throwing. */
function buildTargetPlatform(): string {
  try {
    return targetPlatform(resolveCc());
  } catch {
    return process.platform;
  }
}

export interface AnalyzeOptions {
  /** Analyze as a --dynamic build (island constructs lower instead of
   * producing requires-dynamic diagnostics). */
  dynamic?: boolean;
  /** --npm-static (see CompileOptions.npmStatic): the analysis compiles
   * opted-in packages' JS as program modules and the coverage report
   * carries each package's static/fallback status. */
  npmStatic?: readonly string[] | "auto";
}

/* ── the frontend, one pipeline shape ───────────────────────────────────
 * Load → preflight → lowering all ride the ONE tsgo program (program.ts +
 * lowering/ over the ts7 adapter) — the native TypeScript compiler is the
 * only frontend since the phase-4 flip retired the 5.9.3 pipeline
 * (typescript@5.9.3 survives solely as the sanctioned islands: npm.ts's
 * parse scan and lower-comptime's transpileModule). Everything after
 * lowering is IR-world, so analyze() and compile() consume this one
 * Frontend shape. */
interface Frontend {
  preflight: ScrDiagnostic[];
  /** The entry source file's text (emitModule's header comment input). */
  entryText: () => string;
  sourceTexts: () => Map<string, string>;
  lower: (opts: LowerOptions) => LowerResult;
  /** --npm-static: each requested (or auto-detected) package's outcome —
   * compiled statically, or fallen back with the first refusal reason. */
  npmStatic: NpmStaticStatus[];
  /** Releases the frontend's resources (the spawned tsgo server). Call
   * exactly once, after the last lower(). */
  dispose: () => void;
}

/** --npm-static=auto: one throwaway load finds every bare npm import the
 * program's own modules make, then the eligibility heuristics
 * (npm-static.ts) pick the packages whose shipped JS is worth attempting.
 * Rejected candidates report their reason so the coverage output says why
 * auto skipped them. */
function detectAutoPackages(load: LoadResult, statuses: NpmStaticStatus[]): string[] {
  const seen = new Map<string, string>(); // package → typesFile
  for (const sf of [...load.moduleOrder, load.entry]) {
    if (sf.fileName.includes("/node_modules/")) continue;
    for (const stmt of sf.statements) {
      if (!ts7IsImportWithStringSpec(stmt)) continue;
      const spec = (stmt as { moduleSpecifier: { text: string } }).moduleSpecifier.text;
      if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("node:") || spec.startsWith("#")) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm === null || isNodeTypesPath(npm.typesFile)) continue;
      if (!seen.has(npm.packageName)) seen.set(npm.packageName, npm.typesFile);
    }
  }
  const chosen: string[] = [];
  for (const [pkg, typesFile] of seen) {
    const jsEntry = resolveBareModule(load.entry.fileName, pkg, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isJsSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
    );
    if (reason === null) chosen.push(pkg);
    else statuses.push({ package: pkg, status: "fallback", detail: `auto: ${reason}` });
  }
  return chosen;
}

/** Duck-typed import-declaration test (the ts7 AST types stay inside the
 * frontend; this file only needs the specifier text). */
function ts7IsImportWithStringSpec(stmt: unknown): stmt is { moduleSpecifier: { text: string } } {
  const s = stmt as { kind?: unknown; moduleSpecifier?: { text?: unknown } };
  return typeof s.moduleSpecifier?.text === "string";
}

function runFrontend(entryPath: string, npmStatic?: readonly string[] | "auto"): Frontend {
  const statuses: NpmStaticStatus[] = [];
  let requested: string[] = [];
  if (npmStatic === "auto") {
    const scout = loadProgram(entryPath);
    try {
      checkPreflight(scout);
      requested = detectAutoPackages(scout, statuses);
    } finally {
      scout.dispose();
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
  }

  // The all-or-nothing fallback loop: a preflight diagnostic ANCHORED in
  // an opted-in package's files (an unsupported require form, a builtin
  // fence) — or an offender the resolution itself reported — drops that
  // package from the set and the whole frontend reloads without it, so
  // its import takes the ordinary island path. Static compilation of a
  // package must never turn a working --dynamic build into a build
  // failure.
  let load = loadProgram(entryPath, { npmStatic: requested });
  let preflight = checkPreflight(load);
  const effective = new Set(requested);
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) reasons.set(pkg, `${d.code}: ${d.message}`);
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "fallback", detail: reasons.get(p)! });
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective });
    preflight = checkPreflight(load);
  }
  // AUTO mode's last resort: an opt-in can change the PROGRAM's OWN
  // typecheck (the inferred surface replaces the shipped .d.ts — the
  // commander name()/description() chaining shape, or a package consumed
  // for type-only imports), and those SC0001s anchor in USER files no
  // offender attribution reaches. Auto promised eligibility detection,
  // not a broken program: each remaining package is probed ALONE-dropped
  // (n is the direct-import count — a handful of extra analysis loads);
  // culprits whose removal clears the errors fall back with a note, and
  // if no subset typechecks, everything drops. Explicit opt-ins keep the
  // errors (the user asked for exactly these packages and the errors are
  // the actionable answer).
  if (npmStatic === "auto" && effective.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      statuses.push({
        package: p,
        status: "fallback",
        detail: "auto: the program does not typecheck against its inferred surface",
      });
    };
    // Attribute per package by probing each SOLO (culprits are almost
    // always independent — each package's inferred surface breaks its own
    // import sites), then reload with the survivors; interaction effects
    // that still fail drop everything left.
    for (const p of [...effective]) {
      const probe = loadProgram(entryPath, { npmStatic: [p] });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: effective });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }

  const finalLoad = load;
  return {
    preflight,
    entryText: () => finalLoad.entry.text,
    sourceTexts: () =>
      new Map<string, string>([finalLoad.entry, ...finalLoad.moduleOrder].map((sf) => [sf.fileName, sf.text])),
    lower: (opts) => lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, { ...opts, startupCrash: finalLoad.startupCrash ?? null }),
    npmStatic: statuses,
    dispose: finalLoad.dispose,
  };
}

/** Analysis without codegen: how much of the program compiles statically.
 * Unlike compile(), lowering diagnostics are data here, not failure. */
export function analyze(entryPath: string, opts: AnalyzeOptions = {}): AnalyzeResult {
  const fe = runFrontend(entryPath, opts.npmStatic);
  try {
    const emptyStats = { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 };

    const preflight = fe.preflight;
    // Import-FORM fences don't stop the analysis: the module graph is still
    // computable (a fenced import contributes no edges), the imported
    // bindings poison at their use sites, and the fences join the blockers
    // list beside statement-level ones — the report shows a statement
    // percentage instead of stopping at the import lines. Everything else —
    // tsc errors, config incompatibilities, circular imports — still stops
    // at preflight (no trustworthy program to lower). Builds are unchanged:
    // compile() fails on every preflight diagnostic exactly as before.
    const IMPORT_FENCES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"]);
    if (preflight.some((d) => !IMPORT_FENCES.has(d.code))) {
      return {
        coverage: {
          file: entryPath,
          dynamic: opts.dynamic ?? false,
          stats: emptyStats,
          diagnostics: preflight,
          ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
          preflightFailed: true,
        },
        sourceTexts: fe.sourceTexts(),
      };
    }
    // Coverage is whole-program by design: builds stop at what the entry
    // reaches, but the analysis additionally lowers the unreached remainder
    // (throwaway) so the report covers everything the source declares — with
    // the unreached share in its own group.
    const lowered = fe.lower({
      dynamic: opts.dynamic ?? false,
      coverage: true,
      targetPlatform: buildTargetPlatform(),
    });
    const provenance = provenanceSources();
    return {
      coverage: {
        file: entryPath,
        dynamic: opts.dynamic ?? false,
        stats: lowered.stats,
        // The import fences report as blockers alongside the statement-level
        // ones (use sites of the fenced bindings emit matching diagnostics,
        // which the report groups with these).
        diagnostics: [...preflight, ...lowered.diagnostics],
        ...(lowered.runtimeFences.length > 0 ? { runtimeFences: lowered.runtimeFences } : {}),
        ...(lowered.unreached ? { unreached: lowered.unreached } : {}),
        ...(lowered.npmBuiltins ? { npmBuiltins: lowered.npmBuiltins } : {}),
        ...(lowered.npmLazyTraps ? { npmLazyTraps: lowered.npmLazyTraps } : {}),
        ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
        // --provenance-sources: the per-package attribution inputs (the
        // report aggregates statsByFile under each package's source dir).
        ...(provenance !== null ? { provenance } : {}),
        ...(lowered.statsByFile ? { statsByFile: lowered.statsByFile } : {}),
        ...(lowered.provenanceElided ? { provenanceElided: lowered.provenanceElided } : {}),
        preflightFailed: false,
      },
      sourceTexts: fe.sourceTexts(),
    };
  } finally {
    fe.dispose();
  }
}

/** The whole pipeline: load → preflight → lower → validate → emit C → clang. */
export async function compile(entryPath: string, opts: CompileOptions): Promise<CompileResult> {
  const fe = runFrontend(entryPath, opts.npmStatic);
  let lowered: LowerResult;
  let entryText: string;
  let sourceTexts: Map<string, string>;
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): CompileResult => ({
      ok: false,
      diagnostics,
      sourceTexts: fe.sourceTexts(),
    });

    if (fe.preflight.length > 0) return fail(fe.preflight);

    try {
      lowered = fe.lower({
        dynamic: opts.dynamic ?? false,
        targetPlatform: buildTargetPlatform(),
      });
    } catch (e) {
      // The last-resort panic fence: an upstream tsgo panic that crossed a
      // checker call no statement/collection fence wrapped still becomes a
      // clean failed compile (anchored at the entry), never a crashed CLI.
      if (!isCheckerPanic(e)) throw e;
      return fail([
        checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 }),
      ]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);

    const validation = validateModule(lowered.module);
    if (validation.length > 0) {
      return fail(validation.map((v) => iceDiag(v.message, v.loc)));
    }
    entryText = fe.entryText();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  // Both backends hang off the same in-memory IrModule (never the JSON
  // dump); the LLVM backend's .ll takes the .c's seat on the exact clang
  // command line below — compileC accepts either. The default lane tries
  // LLVM first; a tier refusal retries ONLY the emit with the C backend
  // (the frontend ran once, the IR is backend-agnostic — nothing recompiles).
  let cPath = join(opts.outDir, `${stem}.c`);
  let backend: "c" | "llvm" = "c";
  let llvmRefusal: string | undefined;
  if (opts.backend !== "c") {
    try {
      const ll = emitLlvmModule(lowered.module!);
      cPath = join(opts.outDir, `${stem}.ll`);
      await writeFile(cPath, ll);
      backend = "llvm";
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      // Explicit backend "llvm" keeps the fail-loudly contract (the
      // debugging/CI pin): SC3001, never a silent lane change.
      if (opts.backend === "llvm") {
        return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
      }
      llvmRefusal = err.kind;
    }
  }
  if (backend === "c") {
    await writeFile(cPath, emitModule(lowered.module!, entryText));
  }
  // Kept-TU honesty: outDir persists across builds (the CLI's .scriptc/),
  // so a lane change would leave the PREVIOUS lane's TU beside the fresh
  // one — remove the loser so the surviving TU is always the one the
  // binary below was linked from.
  await rm(join(opts.outDir, `${stem}${backend === "llvm" ? ".c" : ".ll"}`), { force: true });

  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.ir.json`);
    await writeFile(irPath, serializeModule(lowered.module));
  }

  await mkdir(dirname(opts.outPath), { recursive: true });
  await compileC({
    cPath,
    outPath: opts.outPath,
    sanitize: opts.sanitize ?? false,
    dynamic: opts.dynamic ?? false,
    // The link switch for scr_regex.c + libregexp: detected on the IR, so
    // regex-free programs keep the historical (pinned) command line.
    regex: moduleUsesRegex(lowered.module),
    // The link switch for scr_fetch.c (the native bridge over scr_net +
    // scr_tls + scr_http's client parser + zlib — cc.ts implies those
    // units into the link): embedded npm code that references fetch gets
    // the bridge; everything else keeps its exact link line.
    fetch: moduleUsesFetch(lowered.module),
    // The island's node:http/https client bridge: embedded graphs that
    // import those builtins pull scr_net_island.c + the socket units.
    netIsland:
      moduleEmbedsBuiltin(lowered.module, "node:http") ||
      moduleEmbedsBuiltin(lowered.module, "node:https") ||
      moduleEmbedsBuiltin(lowered.module, "node:net") ||
      moduleEmbedsBuiltin(lowered.module, "node:tls"),
    // The link switch for scr_zlib.c + libz: zlib.* libCalls on the IR,
    // node:zlib in the embedded graph, or COMPRESSED embedded module text
    // (emit-island.ts stores big npm sources as raw DEFLATE; the emitted
    // main installs scr_zlib_inflate_exact on the same predicate).
    zlib: moduleUsesZlib(lowered.module) || moduleEmbedsCompressedNpm(lowered.module),
    // The link switch for scr_assert.c: assert.* libCalls on the IR (the
    // regex switch also pulls it — scr_regex.c calls the assert helpers).
    assert: moduleUsesAssert(lowered.module),
    // The link switch for scr_inspect.c: insp.* libCalls on the IR.
    inspect: moduleUsesInspect(lowered.module),
    // The link switch for scr_dyn_invoke.c: dynInvoke nodes or
    // dyn.defineProps libCalls on the IR.
    dynInvoke: moduleUsesDynInvoke(lowered.module),
    // The link switch for scr_dc.c: dc.* libCalls on the IR (the
    // diagnostics_channel registry and pub/sub).
    dc: moduleUsesDc(lowered.module),
    // The link switch for scr_async_dyn.c: the checked-dynamic async
    // surfaces (cc.ts also pulls it under the dynInvoke/dc gates).
    dynAsync: moduleUsesDynAsync(lowered.module),
    // The link switch for scr_events.c: process signal/exit listeners and
    // the stdin event surface on the IR.
    events: moduleUsesProcessEvents(lowered.module),
    // The link switch for scr_events_emitter.c: the node:events
    // EventEmitter surface on the IR (emitter.* libCalls or the
    // %EventEmitter class def).
    emitter: moduleUsesEmitter(lowered.module),
    // The link switch for scr_symbol.c: sym.* libCalls or a symbol-kind
    // type anywhere on the IR.
    symbol: moduleUsesSymbol(lowered.module),
    // The link switch for scr_url_params.c: sp.* libCalls, the
    // url.searchParams getter, or a searchParams-kind type on the IR.
    searchParams: moduleUsesSearchParams(lowered.module),
    // The link switch for scr_stream.c: the node:stream class surface on
    // the IR (stream libCalls or the %Readable-family class defs).
    stream: moduleUsesStream(lowered.module),
    // The link switch for scr_net.c: net.* (or http.* — http rides on
    // net) libCalls on the IR.
    net: moduleUsesNet(lowered.module),
    // The link switch for scr_http.c: http.* libCalls on the IR.
    http: moduleUsesHttpServer(lowered.module),
    http2: moduleUsesHttp2(lowered.module),
    // The link switch for scr_dgram.c: dgram.* or dns.* libCalls on the IR.
    dgram: moduleUsesDgram(lowered.module),
    // The link switch for scr_watch.c: fs.watch/watcher.* libCalls on the IR.
    watch: moduleUsesFsWatch(lowered.module),
    // The link switch for scr_test.c: test.* libCalls on the IR.
    nodeTest: moduleUsesNodeTest(lowered.module),
    // The link switch for scr_tls.c + the vendored mbedTLS archive:
    // tls.* or https.* libCalls on the IR.
    tls: moduleUsesTls(lowered.module),
  });
  return {
    ok: true,
    binaryPath: opts.outPath,
    cPath,
    backend,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(llvmRefusal !== undefined ? { llvmRefusal } : {}),
  };
}
