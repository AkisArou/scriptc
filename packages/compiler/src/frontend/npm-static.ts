/* The --npm-static opt-in: compile a named npm package's shipped JS
 * STATICALLY, as ordinary program modules, instead of island-running it
 * under --dynamic.
 *
 * The doctrine (slice 2 of the npm story): a package that ships readable,
 * unminified JS alongside its .d.ts can compile through the same
 * JS/CommonJS frontend the program's own JS files use — inference (JSDoc
 * included) types the bodies, and every statement the lowering cannot
 * honor becomes the standard JS runtime fence (the trap throws AT the
 * statement if the program ever drives it — trust-but-verify, never
 * silent trust). The .d.ts is deliberately DROPPED from the opted-in
 * package's resolution: a declaration is a CLAIM about the body, and the
 * compiled artifact must be built from what the body provably is, not
 * from what the declaration says it should be. Program-side use sites
 * therefore typecheck against the INFERRED export surface; where the
 * package's own JSDoc (usually written against that same .d.ts) types a
 * boundary, the declared types flow in through inference and the runtime
 * fences guard the sites the checker could not prove.
 *
 * MECHANISM. Resolution is the single lever:
 *   - tsgo's server-side resolution reads package.json and probes sibling
 *     .d.ts files through the host's virtual-FS hooks, so an opted-in
 *     package's package.json is SHADOWED (its "types"/"typings" fields and
 *     every "types" condition inside "exports" removed), its shipped
 *     declaration files are HIDDEN (fileExists answers false), and its
 *     @types twin is hidden whole — the bundler resolution then lands on
 *     the shipped JS, which allowJs + maxNodeModuleJsDepth admit into the
 *     program as checkable source.
 *   - scriptc's own resolver (resolve.ts) mirrors the same answer: for an
 *     opted-in package the types pass is skipped, the "types" export
 *     condition is dropped, and the @types mangling never runs.
 * Both worlds agreeing, the package's entry (and its internal relative
 * graph) joins userFiles/moduleOrder exactly like program JS, and the
 * whole existing CJS/ESM module machinery — require discipline, the CJS
 * lexer link check, export-identity analysis, %init ordering — applies
 * unchanged.
 *
 * FAILURE MODE: all-or-nothing per package, island fallback. A preflight
 * diagnostic anchored in an opted-in package's files (an unsupported
 * require form, an unshimmed builtin, a resolution miss) marks the
 * package as an OFFENDER; the frontend rebuilds without it and the
 * import takes today's island path (--dynamic) or the requires-dynamic
 * diagnostic (static builds). The fallback is reported in the coverage
 * report, never as a build failure. Checker errors inside opted-in
 * package files do NOT fail preflight and do NOT trigger fallback: the
 * package's author checked it under a different tsconfig, the program's
 * author cannot fix it, and the JS design already says where inference
 * gaps land — the per-statement runtime fences.
 *
 * STATE. One compile at a time: the active set is module state, written
 * by loadProgram (empty when the flag is off) and read by resolve.ts,
 * program.ts, and the lowering. The CLI and the test harness both drive
 * whole compiles sequentially per process, and every loadProgram resets
 * the state, so a flagless compile after a flagged one sees a clean
 * slate. */

import { readFileSync } from "node:fs";
import { npmPackageNameOf, workspacePackageOfPath } from "./shared.js";

let activePackages: ReadonlySet<string> = new Set();

/** Offender records of the CURRENT load attempt: packages whose static
 * compilation the preflight had to refuse, with the first reason. The
 * frontend's fallback loop consumes these and rebuilds without them. */
const offenders = new Map<string, string>();

export function setNpmStaticPackages(packages: Iterable<string>): void {
  activePackages = new Set(packages);
  offenders.clear();
}

export function npmStaticActive(): boolean {
  return activePackages.size > 0;
}

export function npmStaticPackages(): ReadonlySet<string> {
  return activePackages;
}

export function isNpmStaticPackage(name: string | null): boolean {
  return name !== null && activePackages.has(name);
}

/** The opted-in package a path belongs to, or null. Attribution uses the
 * INNERMOST node_modules segment (a nested install is its own package). */
export function npmStaticPackageOfPath(path: string): string | null {
  const pkg = npmPackageNameOf(path);
  return pkg !== null && activePackages.has(pkg) ? pkg : null;
}

/** Records why a package cannot compile statically this attempt (first
 * reason wins — one line per package in the coverage note). */
export function reportNpmStaticOffender(pkg: string, reason: string): void {
  if (activePackages.has(pkg) && !offenders.has(pkg)) offenders.set(pkg, reason);
}

export function npmStaticOffenders(): ReadonlyMap<string, string> {
  return offenders;
}

/** The DefinitelyTyped name mangling ("@scope/pkg" → "scope__pkg") — the
 * @types twin that must hide alongside the package's own declarations. */
function mangledTypesName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
}

/** node_modules path classification for the fs shadow: which opted-in
 * package (if any) the path is inside, and whether it is inside that
 * package's @types twin instead. A path with no node_modules segment can
 * still be an opted-in WORKSPACE package's real home (the symlinked
 * install's realpath — loadProgram registers those before the host is
 * created, so probes along the package's internal relative edges hide the
 * declaration twins too). */
function shadowTargetOf(path: string): { pkg: string; viaTypes: boolean } | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) {
    const ws = workspacePackageOfPath(norm);
    return ws !== null && activePackages.has(ws) ? { pkg: ws, viaTypes: false } : null;
  }
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  if (activePackages.has(dirName)) return { pkg: dirName, viaTypes: false };
  if (first === "@types") {
    const mangled = parts[1] ?? "";
    for (const pkg of activePackages) {
      if (mangledTypesName(pkg) === mangled) return { pkg, viaTypes: true };
    }
  }
  return null;
}

/** The opted-in package.json transform, applied identically in BOTH
 * resolution worlds (the tsgo host's fs shadow and resolve.ts):
 *   1. every types claim goes — the top-level "types"/"typings" fields
 *      and every "types"/"typings" condition key inside "exports"
 *      (recursively; condition objects nest) — so resolution lands on
 *      runtime JS;
 *   2. CJS-first: a condition object carrying BOTH "import" and "require"
 *      has its "import" value REWRITTEN to the "require" target. The
 *      import-side of a wrapper-style dual (commander's esm.mjs) is pure
 *      name plumbing over the CJS implementation — `export const {…} =
 *      cjsDefault`, a re-export shape with no static lowering — while the
 *      CJS side engages the compiler's richest machinery (the CJS lexer
 *      link check, export-identity analysis, require discipline).
 *      Behavior is identical for wrapper duals (both sides evaluate the
 *      same CJS module); genuinely dual-BEHAVIOR packages are outside the
 *      pilot's supported surface — the differential contract gates every
 *      opted-in package. Import-only (pure ESM) packages are untouched
 *      and compile as native ES modules. */
export function npmStaticTransformPkgJson(pkg: Record<string, unknown>): void {
  delete pkg["types"];
  delete pkg["typings"];
  const transform = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) transform(item);
      return;
    }
    const obj = v as Record<string, unknown>;
    delete obj["types"];
    delete obj["typings"];
    // 0. The "node" condition HOISTS: Node's runtime resolution matches it
    //    (yaml's `{ types, node: "./dist/index.js", default: "./browser/
    //    index.js" }` runs the node dist; the browser dist is a DIFFERENT
    //    artifact), while the bundler condition set both resolution worlds
    //    use ({types, import, default}) would fall through to "default".
    //    The node target splices in AT ITS KEY POSITION — a string emits
    //    under import+require (either matcher finds it there), an object's
    //    entries splice inline — earlier real keys keep winning, exactly
    //    Node's first-match-in-key-order rule.
    if (obj["node"] !== undefined) {
      const entries = Object.entries(obj);
      for (const k of Object.keys(obj)) delete obj[k];
      for (const [k, val] of entries) {
        if (k !== "node") {
          if (!(k in obj)) obj[k] = val;
          continue;
        }
        const inner: Record<string, unknown> =
          typeof val === "string"
            ? { import: val, require: val }
            : val !== null && typeof val === "object" && !Array.isArray(val)
              ? (val as Record<string, unknown>)
              : {};
        for (const [ik, iv] of Object.entries(inner)) {
          if (!(ik in obj)) obj[ik] = iv;
        }
      }
    }
    if (obj["import"] !== undefined && obj["require"] !== undefined) {
      obj["import"] = obj["require"];
    }
    for (const value of Object.values(obj)) transform(value);
  };
  if (pkg["exports"] !== undefined) transform(pkg["exports"]);
}

/** npmStaticTransformPkgJson over a package.json TEXT (the fs shadow's
 * form). Malformed documents pass through untouched — resolution reports
 * them exactly as it always did. */
export function npmStaticTransformPkgJsonText(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return text;
  npmStaticTransformPkgJson(doc as Record<string, unknown>);
  return JSON.stringify(doc);
}

/** True for declaration-file names (the claims the opted-in resolution
 * must not see). */
function isDeclarationFileName(path: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(path) || path.endsWith(".d.json.ts");
}

export interface NpmStaticFsShadow {
  /** Shadowed CONTENT for a real path (the types-stripped package.json),
   * or undefined (no shadow — fall through). */
  readFile: (path: string) => string | undefined;
  /** True when the path must not exist for the type-checker's resolution
   * (an opted-in package's shipped .d.ts, or its @types twin whole). */
  hideFile: (path: string) => boolean;
}

/** The virtual-FS shadow loadProgram hands the tsgo host — null when the
 * flag is off, so flagless compiles keep the exact host behavior. */
export function npmStaticFsShadow(): NpmStaticFsShadow | null {
  if (!npmStaticActive()) return null;
  return {
    readFile: (path) => {
      const target = shadowTargetOf(path);
      if (!target || target.viaTypes) return undefined;
      if (!path.endsWith("/package.json") && !path.endsWith("\\package.json")) return undefined;
      try {
        return npmStaticTransformPkgJsonText(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
    },
    hideFile: (path) => {
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path);
    },
  };
}

/* ── auto-detection (--npm-static=auto) ─────────────────────────────────
 * The criteria the design doc names: the package ships its OWN .d.ts (a
 * declaration surface its author maintains against the JS — @types twins
 * are third-party claims and do not qualify), the runtime JS is readable
 * (unminified: real lines, ordinary line lengths), and the source shows
 * no build-transform markers (a bundled/transpiled dist is not the code
 * the author checked). Best-effort: a package that slips through and
 * fails preflight falls back to the island like any offender. */

const TRANSFORM_MARKERS = [
  "__webpack_require__",
  '"__esModule"', // tsc/babel CJS transform stamp
  "'__esModule'",
  "var __require", // esbuild's external-require helper
  "function __require",
];

/** Unminified-JS heuristic over an entry source: at least two lines and
 * an average line length under 200 characters (minified dists are one
 * enormous line; readable code averages well under 100). */
export function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2) return false;
  return source.length / lines.length <= 200;
}

export function hasTransformMarkers(source: string): boolean {
  return TRANSFORM_MARKERS.some((m) => source.includes(m));
}

/** Auto-mode eligibility for one candidate package: `typesFile` is what
 * the ordinary (types-first) resolution answered for the import,
 * `jsEntry` what the js-only resolution answers. Returns null when
 * eligible, else the human-readable reason it is not. */
export function npmStaticIneligibleReason(
  pkgName: string,
  typesFile: string,
  jsEntry: string | null,
): string | null {
  if (npmPackageNameOf(typesFile) !== pkgName) {
    return "its declared types come from a third-party @types package, not the package itself";
  }
  if (!/\.d\.(ts|mts|cts)$/.test(typesFile)) {
    return "it ships no own .d.ts declaration surface";
  }
  if (jsEntry === null) return "no runtime JS entry resolves";
  let source: string;
  try {
    source = readFileSync(jsEntry, "utf8");
  } catch {
    return `its runtime entry ${jsEntry} cannot be read`;
  }
  if (!looksUnminified(source)) return "its shipped JS looks minified";
  if (hasTransformMarkers(source)) {
    return "its shipped JS carries build-transform markers (bundled/transpiled dist)";
  }
  return null;
}
