/* Diagnostic codes live in ONE registry. Message strings are never inlined
 * at rejection sites — every "not supported yet" the compiler can produce is
 * enumerable here, which is the seed of the future coverage report
 * ("N constructs prevented static compilation, grouped by code").
 *
 * Code bands:
 *   SC0xxx  preflight gates: TypeScript errors passed through (SC0001),
 *            project-config incompatibilities (SC0002), malformed imported
 *            JSON modules (SC0003), and upstream tsgo checker panics
 *            surfaced as source-anchored diagnostics (SC0004)
 *   SC1xxx  supported-TypeScript-not-yet: valid TS outside the current subset
 *   SC2xxx  scriptc type rules (types we cannot compile yet)
 *   SC3xxx  backend coverage: the program is compilable (the C backend
 *            builds it) but the selected alternate backend's tier does not
 *            include some IR construct yet (SC3001 — the LLVM backend's
 *            refusal, minted in index.ts from LlvmUnsupportedError)
 *   SC4xxx  library-mode/profile refusals (the library-emission mode): profile
 *            malformed (SC4001), export unresolved (SC4002), unmappable
 *            signature (SC4003), async/generator export (SC4004), the
 *            async_free graph requirement (SC4005), island/dynamic on the
 *            library path (SC4006), generic export signatures (SC4007),
 *            contract-sidecar projection (SC4009), multi-site type
 *            declarations feeding a tabled type (SC4010), conditional/
 *            mapped types producing a tabled type (SC4011), the
 *            inbound-bytes host-contract runtime trap (SC4012 — a
 *            structured trap-teaching code, not a refusal); SC4008
 *            reserved for ask-5 determinism denials
 *   SC9xxx  internal compiler errors (still source-anchored)
 */
import type { SrcLoc } from "../ir/nodes.js";

/* Internal prioritization buckets. NEVER rendered to users — user-facing
 * output says only what is and isn't supported (plus hints); scheduling is
 * maintainer business. Used to order blockers in the coverage report. */
export type Milestone = "M1" | "M2" | "M3" | "M4" | "M5" | "later";

export interface ScrDiagnostic {
  code: `SC${number}`;
  message: string;
  loc: SrcLoc;
  milestone?: Milestone;
  hint?: string;
}

interface UnsupportedEntry {
  feature: string;
  milestone: Milestone;
  hint?: string;
}

export const UNSUPPORTED: Record<string, UnsupportedEntry> = {
  SC1010: {
    feature: "package imports",
    milestone: "M4",
    hint:
      "relative imports (./file, ../dir/file), package.json-mediated project " +
      "imports (#alias via the imports field, self-name references via " +
      "exports), installed npm packages (their code runs under --dynamic), " +
      "and the built-in fs, fs/promises, path, os, url, crypto, zlib, " +
      "child_process, net, http, tls, https, http2, dgram, dns, util, " +
      "util/types, string_decoder, querystring, readline, events, stream, " +
      "stream/promises, buffer, assert, assert/strict, worker_threads, " +
      "cluster, tty, async_hooks, timers, timers/promises, " +
      "diagnostics_channel, perf_hooks, and node:test and node:module " +
      "modules (bare or node:-prefixed) are supported",
  },
  // SC1011 (exports) shipped via export modifiers — retired, do not reuse.
  // Default exports/imports SHIPPED (expression, function/class declaration
  // — named and anonymous — `export { x as default }`, default re-exports,
  // and the CJS default interop). SC1012's remaining uses are the residual
  // edges, each named at its site: default imports of builtin modules
  // without a default surface, default-exporting a MUTABLE binding (Node
  // snapshots; not modeled), named imports from JSON modules, and the
  // require()-of-JSON forms.
  SC1012: {
    feature: "default exports/imports",
    milestone: "later",
    hint: "use named exports: export function f() {} / import { f } from \"./m\"",
  },
  // Namespace imports of USER modules shipped (`import * as ns from
  // "./m"` and `export * as ns from "./m"`: ns.member resolves statically
  // to the exporter's own registrations). SC1013's remaining uses name
  // their edges: the ns OBJECT as a first-class value, namespace imports
  // of JSON/CommonJS modules, runtime import = require(...) forms, and
  // require() in an ES module.
  SC1013: { feature: "namespace imports (* as ns)", milestone: "later" },
  SC1014: {
    feature: "re-exports and export lists",
    milestone: "later",
    hint: "export declarations directly: export function f() {}",
  },
  SC1015: { feature: "dynamic import()", milestone: "M4" },
  SC1016: { feature: "circular imports", milestone: "later" },
  // Class DECLARATIONS shipped; SC1020's remaining use is class expressions.
  SC1020: { feature: "class expressions", milestone: "later" },
  // SC1021 (arrow functions/closures) and SC1022 (nested function
  // declarations) shipped — codes retired, do not reuse.
  // SC1023 (object literals) shipped as records — code retired, do not
  // reuse. (Spread, computed keys, getters/setters and `this` in
  // object-literal methods remain rejected via SC1090.)
  // SC1024 (arrays) shipped — code retired, do not reuse.
  // `var` declarations shipped (function-scope hoisting, redeclaration
  // merge, the shared-binding loop capture semantics). SC1030's remaining
  // uses are the var edges with no honest lowering — each names its shape
  // and remedy inline (a reference above the declaration whose early reads
  // would be an unrepresentable `undefined`; `var` loop bindings in
  // `for await`).
  SC1030: {
    feature: "var declarations",
    milestone: "later",
  },
  SC1031: { feature: "destructuring", milestone: "M2" },
  // SC1032 (multiple declarations in one statement) shipped — code retired,
  // do not reuse. (Multi-declaration for-loop initializers remain rejected
  // via SC1090.)
  // SC1033 (let without an initializer) shipped — code retired, do not
  // reuse.
  SC1040: {
    feature: "loose equality (== and !=)",
    milestone: "M4",
    hint: "use === / !== ('x == null' / 'x != null' — the null-or-undefined test — is supported; other loose comparisons need dynamic coercion semantics)",
  },
  // SC1041 (bitwise operators, ToInt32 semantics) shipped — code retired,
  // do not reuse.
  SC1042: {
    feature: "logical operators on mixed operand types",
    milestone: "later",
    hint: "give both operands the same type (number, string, or boolean)",
  },
  SC1043: { feature: "comparing non-number, non-string values", milestone: "M1" },
  SC1045: {
    feature: "increment/decrement in expression position",
    milestone: "later",
    hint: "use ++/-- as a standalone statement, or write x = x + 1",
  },
  SC1050: { feature: "labeled break/continue", milestone: "later" },
  // SC1051 (do-while loops) shipped — code retired, do not reuse.
  SC1052: { feature: "for-in loops", milestone: "M4" }, // for-of over arrays shipped in M1
  // SC1060 (switch statements) shipped — code retired, do not reuse.
  // SC1061 (exceptions: throw/try/catch/finally) shipped — code retired, do
  // not reuse. (Identifier catch bindings shipped too; what remains rejected
  // is destructuring patterns — SC1062 — un-narrowed binding uses —
  // SC1063 — and jumps crossing a finally — SC1090.)
  SC1062: {
    feature: "destructuring catch clause bindings",
    milestone: "later",
    hint: "bind an identifier (catch (e)) and narrow it — 'e instanceof Error' exposes .name/.message, typeof tests expose primitives",
  },
  SC1063: {
    feature: "this use of a catch binding",
    milestone: "later",
    hint: "a catch binding is typed by what was thrown — narrow before reading: 'if (e instanceof Error)' (then .name/.message), 'typeof e === \"string\"/\"number\"/\"boolean\"', or rethrow with 'throw e'; String(e) and `${e}` also compile ('Error: msg' for Error payloads — Node's String(), which has no stack), so 'e instanceof Error ? e.message : String(e)' works as-is",
  },
  SC1070: { feature: "async/await", milestone: "M3" },
  SC1071: { feature: "generators", milestone: "later" },
  // `this` in class methods (+ lexical capture by arrows) shipped; what
  // remains is `this` outside any method (top level, plain functions).
  SC1080: { feature: "'this' outside a class method", milestone: "later" },
  SC1090: { feature: "this syntax", milestone: "later" }, // generic fallback; message names the construct
  SC1100: {
    feature: "operations on 'unknown' values",
    milestone: "later",
    hint: "validate with 'as <type>' first — the cast checks the dynamic value at runtime and throws on mismatch",
  },
  SC1101: {
    feature: "converting typed values to 'unknown'",
    milestone: "later",
    hint: "numbers, strings, booleans, JSON-safe records/arrays/unions (a deep copy — the 'unknown' value never aliases the original), and functions over those (boxed, identity preserved) convert into 'unknown' slots; this value's type has no dynamic representation yet",
  },
  // Regex fences. SC1120 is the shared code for regex features outside the
  // supported slice (the rejection site names the construct); SC1121 is
  // the statefulness fence, with its own hint.
  SC1120: {
    feature: "this regex feature",
    milestone: "later",
    hint: "supported: literal regexes with the g/i/m/s/u/y flags — .test(), .source/.flags, and string replace/replaceAll/split with string replacement templates",
  },
  SC1121: {
    feature: "'.test()' on a regex with the 'g' or 'y' flag",
    milestone: "later",
    hint: "g/y regexes carry mutable lastIndex state between calls, which is not modeled; drop the flag for a plain match test, or use replace/replaceAll/split (their iteration is internal)",
  },
};

/** The construct-fence codes MINTED BY FACTORY FUNCTIONS below (never keys
 * of UNSUPPORTED): the other half of the enumerable code registry, indexed
 * so the surface manifest (coverage/surface-manifest.ts) can catalog every
 * refusal code a program's constructs can meet. `status` says what the
 * refusal means for the construct: "dynamic-only" codes mark constructs
 * that RUN under --dynamic (the report's dynamic-capable family —
 * SC2010/SC2011/SC2012/SC2013); "unsupported" codes mark constructs with
 * no lowering on either tier. Process-level codes are deliberately absent:
 * preflight gates (SC0001–SC0004), comptime evaluation failures (SC1110),
 * the alternate-backend tier refusal (SC3001), and internal errors
 * (SC9001/SC9002) report problems or engine tiers, not language/stdlib
 * surface. */
export const FENCE_CODES: Record<string, { name: string; status: "unsupported" | "dynamic-only" }> = {
  // SC2001 is the residual type fence: the named type-shape families each
  // carry their own code (SC2005 generic signatures, SC2006 index
  // signatures, SC2007 overloads, SC2008 intersections, SC2009 component
  // fences; standard-library types with no lowering report SC2020). What
  // remains here is the remainder the name enumerates.
  SC2001: { name: "values of types outside the compilable set (bigint and symbol primitives, constructor objects, and library-derived or unresolved generic shapes)", status: "unsupported" },
  SC2002: { name: "record width subtyping (shapes must match exactly)", status: "unsupported" },
  SC2003: { name: "union-to-union conversions outside the re-tagging rule", status: "unsupported" },
  SC2004: { name: "uses of a binding whose declaration did not compile (cascade marker)", status: "unsupported" },
  SC2005: { name: "values whose type keeps a generic call signature (a compiled function is one concrete signature)", status: "unsupported" },
  SC2006: { name: "index-signature object types outside the supported shape", status: "unsupported" },
  SC2007: { name: "values of overloaded function type (a compiled function value is one signature)", status: "unsupported" },
  SC2008: { name: "intersection types with no resolved lowering", status: "unsupported" },
  SC2009: { name: "supported container and function shapes over a component type outside its slot", status: "unsupported" },
  SC2010: { name: "constructs that exist only in the embedded dynamic engine", status: "dynamic-only" },
  SC2011: { name: "'any'-typed values and the operations on them", status: "dynamic-only" },
  SC2012: { name: "standard-library surface that runs in the embedded dynamic engine", status: "dynamic-only" },
  SC2013: { name: "npm package imports and values (the package's implementation runs in the embedded engine)", status: "dynamic-only" },
  SC2020: { name: "standard-library or @types/node surface with no lowering", status: "unsupported" },
  SC2030: { name: "npm package code that cannot be embedded for the dynamic engine", status: "unsupported" },
};

export function unsupportedDiag(
  code: keyof typeof UNSUPPORTED & `SC${number}`,
  loc: SrcLoc,
  featureOverride?: string,
  hintOverride?: string,
): ScrDiagnostic {
  const entry = UNSUPPORTED[code]!;
  const feature = featureOverride ?? entry.feature;
  const diag: ScrDiagnostic = {
    code,
    message: `${feature} ${plural(feature) ? "are" : "is"} not supported yet`,
    loc,
    milestone: entry.milestone,
  };
  const hint = hintOverride ?? entry.hint;
  if (hint !== undefined) diag.hint = hint;
  return diag;
}

function plural(feature: string): boolean {
  const head = feature.split(" (")[0]!.trim();
  return /s$/.test(head) && !/(?:ness|this|ss)$/.test(head);
}

export function tscPassthroughDiag(message: string, loc: SrcLoc): ScrDiagnostic {
  return { code: "SC0001", message, loc };
}

/** The project's tsconfig disables strictNullChecks, which scriptc cannot
 * adopt: null and undefined are DISTINCT STATIC TYPES in the value model
 * (union arms with their own runtime representation) — with the knob off,
 * every type silently includes them and nothing about the model holds. The
 * config gate fails loudly instead of silently re-enabling the knob. */
/** True for the sync channel's surfaced Go panics: typescript-go wraps a
 * server-side panic into a thrown Error whose message starts "panic:" and
 * keeps the server intact (the prefetch fence's original finding). The
 * 2026-07-19 sweep's three upstream panics — the TupleType interface
 * conversion, the import.defer Debug failure, the 1e999 JSON marshal — all
 * arrive in this shape. */
export function isCheckerPanic(e: unknown): e is Error {
  return e instanceof Error && e.message.startsWith("panic:");
}

/** A Go panic inside the typescript-go checker reached through a query
 * about this source position. Upstream bugs from scriptc's point of view —
 * but scriptc still owes a source-anchored diagnostic, never a crashed
 * CLI. */
export function checkerPanicDiag(detail: string, loc: SrcLoc): ScrDiagnostic {
  // Go's encoding/json/v2 Hyrum-proofs its error strings: each process
  // coin-flips between "cannot" and "unable to" as the modal verb
  // (errorModalVerb over randomized map iteration), so the same panic
  // renders two ways across tsgo spawns. scriptc's output is deterministic;
  // pin one spelling before relaying.
  const stable = detail.replace(/\bunable to (marshal|unmarshal|handle)\b/g, "cannot $1");
  return {
    code: "SC0004",
    message: `the TypeScript checker crashed answering a query here (an upstream typescript-go bug): ${stable}`,
    loc,
  };
}

/** An imported .json module whose text strict JSON.parse rejects (a leading
 * `//` comment line — the importAttributes11 shape). tsgo tolerates it, so
 * the SC0001 passthrough never fires; Node itself refuses to import such a
 * module at runtime, and the honest answer is a source-anchored gate at the
 * import, never an uncaught parse throw. */
export function invalidJsonModuleDiag(fileName: string, detail: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC0003",
    message: `imported JSON module '${fileName}' is not valid JSON (${detail})`,
    loc,
  };
}

export function strictNullChecksFloorDiag(configFile: string): ScrDiagnostic {
  return {
    code: "SC0002",
    message:
      "this project's tsconfig disables strictNullChecks, which scriptc requires " +
      "(null and undefined are modeled as distinct static types; without the knob " +
      "every type silently includes them)",
    loc: { file: configFile, start: 0, end: 0 },
    hint: 'set "strictNullChecks": true (or "strict": true) in the project tsconfig',
  };
}

export function unsupportedTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  // `any` gets its own wording AND its own code: it is not an unsupported
  // value type but a construct with a DYNAMIC lowering — under --dynamic,
  // any-typed code runs in the embedded engine. This build didn't opt in,
  // so each site reports the choice: pay ~620KB, or stay static with
  // 'unknown' + a checked cast. The distinct code lets the coverage report
  // separate "runs with --dynamic" from "cannot compile". One voice with
  // SC2010/SC2012: same message shape, same cost figure, same
  // stay-static alternative shape.
  if (typeText === "any") {
    return {
      code: "SC2011",
      message: `values of type 'any' run in the embedded dynamic engine, which this build does not include`,
      loc,
      milestone: "M4",
      hint: "build with --dynamic to run 'any'-typed code in the embedded engine (adds ~620KB to the binary), or stay static with 'unknown' and a checked cast ('x as T')",
    };
  }
  // The RESIDUAL type fence: the named families (generic signatures —
  // SC2005, index signatures — SC2006, overloads — SC2007, intersections —
  // SC2008, component fences — SC2009, standard-library types — SC2020)
  // all speak before badType reaches for this, so what lands here is the
  // remainder the registry entry enumerates: bigint/symbol primitives,
  // constructor objects, and library-derived or unresolved generic shapes.
  return {
    code: "SC2001",
    message:
      `values of type '${typeText}' cannot be compiled yet ` +
      `(supported: number, string, boolean, arrays, Maps, Sets, RegExp, functions, classes, records, unions of those, and 'unknown')`,
    loc,
    milestone: "M2",
  };
}

/** A type with a DYNAMIC representation but no static one — `any[]`,
 * records/functions with `any`-typed members, or a shipped-.d.ts type whose
 * values are island handles. The caller PROVED the claim by re-running
 * mapType with `dynamic: true` before choosing this wording, so the message
 * is a measured fact, not a guess. SC2011 like the bare-`any` arm of
 * unsupportedTypeDiag (one dynamic-family code per story: this is the
 * "values of this TYPE run in the engine" story), and "runs in" voice like
 * SC2012 — the value exists under --dynamic; the build just didn't opt in. */
export function requiresDynamicTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2011",
    message: `values of type '${typeText}' have no static representation but run in the embedded dynamic engine, which this build does not include`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to run these values in the embedded engine (adds ~620KB to the binary), or restate the type inside the static surface (https://scriptc.dev/limitations describes the boundary)",
  };
}

/** A value whose type keeps a GENERIC call signature (`let g: <T>(x: T) =>
 * T`, a stored generic function, a call result the checker left
 * higher-order generic): every compiled function is one concrete
 * signature, so a slot that keeps type parameters has no instance to hold
 * — the generic-value monomorphization rule, named instead of the generic
 * supported-types recitation. */
export function genericSignatureTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2005",
    message: `values of type '${typeText}' cannot be compiled: the signature keeps its type parameters, and a compiled function is always one concrete signature (generic functions monomorphize per pinned signature — declarations, methods, and never-reassigned bindings holding a generic arrow/function expression, an alias of a registered generic function, or a function initializer under a generic-signature annotation)`,
    loc,
    milestone: "M2",
    hint: "annotate the destination with a concrete signature (e.g. '(x: number) => number'), instantiate explicitly ('f<number>'), or call the generic function directly",
  };
}

/** An index-signature object type that STILL does not map: STRING and
 * NUMBER index signatures compile (declared fields + an overflow map for
 * undeclared keys, number keys canonicalized to their JS string spelling),
 * so reaching this means a symbol-keyed signature, dual signatures with
 * UNEQUAL value types, a value type outside the supported set (functions,
 * Maps, promises, ...), or a declared `unknown` field under the signature.
 * The message points at the working alternatives. */
export function indexSignatureTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2006",
    message: `values of type '${typeText}' cannot be compiled: this index signature is outside the supported shape (string or number keys; values limited to numbers, strings, booleans, records, classes, arrays, unions, or 'unknown')`,
    loc,
    milestone: "M2",
    hint: "string- and number-keyed index signatures over the supported value types compile directly; richer value types want Map<string, V>, and symbol keys have no lowering",
  };
}

/** A value whose type declares TWO OR MORE call signatures (an overloaded
 * function type: `{ (x: "a"): string; (x: "b"): number }`, the on()-style
 * listener registries, overloaded stdlib functions stored as values): a
 * compiled function value is exactly one signature, so a multi-signature
 * slot has no instance to hold. CALLS of overloaded declarations resolve
 * per call site and compile — it is the VALUE position that fences. */
export function overloadedSignatureTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2007",
    message: `values of type '${typeText}' cannot be compiled: the type declares multiple call signatures (overloads), and a compiled function value is always one concrete signature`,
    loc,
    milestone: "M2",
    hint: "annotate the slot with the ONE signature the program actually calls (e.g. '(x: number) => string'), or wrap the overloaded function in a single-signature arrow",
  };
}

/** An intersection type that resolved to no lowering. The intersections
 * that DO compile never reach this: object-member intersections resolve
 * through the record path (`A & B` interns the combined shape),
 * function-with-properties hybrids map to `%call` records, and
 * mixin-instantiation intersections resolve by chain structure to their
 * pinned instantiation. What lands here is the remainder — an intersection
 * part outside those rules, or a mixin intersection no chain pins. */
export function intersectionTypeDiag(typeText: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2008",
    message: `values of type '${typeText}' cannot be compiled: this intersection resolves to no runtime shape`,
    loc,
    milestone: "M2",
    hint: "restate the intersection as a single interface or type literal with the combined members; mixin-produced intersections compile where the mixin chain pins one instantiation",
  };
}

/** A SUPPORTED shape over a component type outside its slot: the Map/Set
 * key-value domains, array and tuple elements, union arms, function
 * parameters/returns, and record members. The container is not the blocker
 * — `detail` (computed by describeComponentBlocker/
 * describeRecordMemberBlocker in frontend/types.ts, which mirror mapType's
 * own rules) names the component and the slot it cannot fill. */
export function componentTypeDiag(typeText: string, detail: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2009",
    message: `values of type '${typeText}' cannot be compiled: ${detail}`,
    loc,
    milestone: "M2",
    hint: "the outer shape is supported — the named component is the blocker; restate it inside the compilable set (number, string, boolean, arrays, Maps, Sets, RegExp, functions, classes, records, unions of those, and 'unknown')",
  };
}

/** A REACHED use of standard-library surface with no lowering — the scope
 * fence of the real-lib type world. The checker sees the full es2025
 * standard library, so `Symbol`, `new Date()`, `p.then(...)`, `Math.min`
 * with three arguments all TYPECHECK; each use site of surface (or a call
 * form of it) that nothing lowers reports here instead of the old minimal-
 * ambient "Cannot find name" — and never ICEs. `surface` names what was
 * used ('Symbol', 'Math.sumPrecise', 'new Date', 'string.normalize'). */
export function noLoweringDiag(
  surface: string,
  loc: SrcLoc,
  hint?: string,
  viaNodeTypes = false,
): ScrDiagnostic {
  // Same code, two provenances: with the project's @types/node adopted,
  // the checker also sees everything IT declares (Buffer, process.stdout,
  // fetch, the undici web globals, ...) — a reached use of node-typed
  // surface nothing lowers is the same fence, blamed at @types/node so the
  // report reads honestly ("typed by @types/node" — not "standard
  // library").
  return {
    code: "SC2020",
    message: viaNodeTypes
      ? `'${surface}' is typed by @types/node but has no scriptc lowering yet`
      : `'${surface}' is part of the standard library types but has no scriptc lowering yet`,
    loc,
    milestone: "later",
    hint:
      hint ??
      (viaNodeTypes
        ? "the type checker sees everything @types/node declares, but only the supported surface compiles (https://scriptc.dev/limitations)"
        : "the type checker sees the full standard library, but only the supported surface compiles (https://scriptc.dev/limitations)"),
  };
}

/** Records are monomorphic structs, so a value's shape must match the
 * expected shape EXACTLY — TypeScript's structural width subtyping
 * (`{a: 1, b: 2}` where `{a: number}` is expected) would need a runtime
 * shape coercion that doesn't exist yet. */
export function recordShapeMismatchDiag(
  expectedText: string,
  actualText: string,
  loc: SrcLoc,
): ScrDiagnostic {
  return {
    code: "SC2002",
    message:
      `record shapes must match exactly: expected '${expectedText}', got '${actualText}' ` +
      `(structural width subtyping needs a shape coercion that is not supported yet)`,
    loc,
    milestone: "later",
    hint: "build a new literal with exactly the expected fields instead of passing a wider value",
  };
}

/** Union values carry a runtime tag assigned per-union: a value of one
 * union type flowing into a DIFFERENT union's slot re-tags at runtime when
 * every source arm has a home in the destination (`A | B` into `A | B | C`
 * — see unionRetagHelper). What this rejects is the remainder: a source arm
 * with no identical destination arm, where the value could not be
 * represented in the target union at all. */
export function unionMismatchDiag(
  expectedText: string,
  actualText: string,
  loc: SrcLoc,
): ScrDiagnostic {
  return {
    code: "SC2003",
    message:
      `union types must match exactly: expected '${expectedText}', got '${actualText}' ` +
      `(a union re-tags into another union only when every arm of the source has an identical arm in the destination, or is a record/array that width-coerces into exactly one destination arm)`,
    loc,
    milestone: "later",
    hint: "narrow the value to a SINGLE arm first (a discriminant check, or '!== undefined'/'!== null' for unit arms); a plain arm value widens into any union that contains it, and a whole union widens into any union whose arms include the source's",
  };
}

/** A use of a binding whose DECLARATION did not compile: the declaration
 * site already carries the real diagnostic (a fenced type, a blocked
 * signature, an unsupported binding form), and every later reference falls
 * through the resolution steps because no local/global/function was ever
 * registered under the symbol. This cascade marker names the binding and
 * points back at the root cause instead of misreporting the reference as
 * an unsupported construct of its own. */
export function blockedBindingUseDiag(name: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2004",
    message: `uses of '${name}' inherit the blocker on its declaration`,
    loc,
    milestone: "later",
    hint: `the declaration of '${name}' did not compile — fix the diagnostic reported there and these sites clear with it`,
  };
}

/** An OPERATION on an `any`-typed value with no static lowering, in a
 * static build. The honest static subset of `any` compiles (bindings ride
 * the checked-dynamic DOM — declarations, assignments, reads, equality,
 * typeof, truthiness, templates, calls through boxed functions), but the
 * operations that need JS's full coercion/mutation semantics (operators,
 * expando writes, computed member names, iteration) execute only in the
 * engine. Same code as the `any` type fence (SC2011) so the coverage
 * report and the two-tier retry treat both as one dynamic-capable family:
 * the island lifts exactly these sites. */
export function anyOpRequiresDynamicDiag(feature: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2011",
    message: `${feature} on 'any'-typed values runs in the embedded dynamic engine, which this build does not include`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to run 'any'-typed code in the embedded engine (adds ~620KB to the binary), or stay static with 'unknown' and a checked cast ('x as T')",
  };
}

/** A construct that needs the embedded dynamic-island engine was used in a
 * static build. Static is the default and never silently embeds the engine
 * (~620KB); the fix is spelled out in the hint, not applied implicitly.
 * "Requires" (vs SC2011/SC2012's "runs in"): the construct is engine-only
 * — it has no static form to stay with, so the hint offers no alternative. */
export function requiresDynamicDiag(feature: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2010",
    message: `${feature} requires the embedded dynamic engine, which this build does not include`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to embed the engine (adds ~620KB to the binary); static builds never include it",
  };
}

/** An ambient API with an island-backed lowering (Math.*, number/string
 * methods beyond the static set, parseFloat, ...) was used in a static
 * build. Same contract as SC2010, its own code so the coverage report can
 * name the construct: the call RUNS under --dynamic (the engine executes
 * it with JS-exact semantics); without the flag each use site reports the
 * choice instead of ICEing or failing at link time. */
export function requiresDynamicApiDiag(feature: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2012",
    message: `${feature} runs in the embedded dynamic engine, which this build does not include`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to run this call in the embedded engine (adds ~620KB to the binary); static builds never include it",
  };
}

/** An npm package import in a static build. The package's shipped JS has
 * exactly one execution home — the embedded engine — so the import itself
 * "requires" (SC2010's voice); its own code so the coverage report can
 * attribute sites per package. */
export function requiresDynamicImportDiag(pkg: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2013",
    message: `importing '${pkg}' requires the embedded dynamic engine, which this build does not include — the package's implementation runs there`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to run npm package code in the embedded engine (adds ~620KB to the binary); static builds never include it",
  };
}

/** A USE SITE of a value whose type the package's .d.ts declares, in a
 * static build. Message names ONLY the package (never the type) so the
 * coverage report groups all of a package's sites into one line. */
export function requiresDynamicPackageDiag(pkg: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2013",
    message: `values from the '${pkg}' package run in the embedded dynamic engine, which this build does not include`,
    loc,
    milestone: "M4",
    hint: "build with --dynamic to run npm package code in the embedded engine (adds ~620KB to the binary); static builds never include it",
  };
}

/** Building the embedded npm runtime graph failed — the package's entry
 * or one of its internal modules can't resolve, or it needs a Node builtin
 * the island doesn't shim. Named per problem, at the import site. */
export function npmEmbedFailedDiag(detail: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC2030",
    message: `cannot embed npm package code: ${detail}`,
    loc,
    milestone: "later",
    hint: "the package's runtime JS is embedded at build time and executed in the island; packages that reach outside the shimmed builtins (events, path, fs, os, process, util, buffer, stream, crypto, zlib, url, assert, and the rest of `scriptc coverage`'s shimmed table — http/https clients and net/tls load too; http2 and worker_threads are the notable absences) do not run yet",
  };
}

/** comptime went wrong at evaluation time. The callback runs in an isolated
 * `node:vm` context inside the compiler's own Node process and its RESULT is
 * baked into the binary as a literal — everything that can fail at that
 * stage lands here with a specific detail: the callback threw, evaluation
 * exceeded the compile-time budget, or the returned value cannot be written
 * as a literal of the expected type (NaN/Infinity, undefined/null/functions,
 * shape mismatches — the detail names the offending path, dynCheck-style). */
export function comptimeFailedDiag(detail: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC1110",
    message: `comptime evaluation failed: ${detail}`,
    loc,
  };
}

/* ── SC4xxx: library-mode/profile refusals ─────────────────────────────────
 * The library-emission mode's own code block (design §5.4 + the ratified
 * SC4xxx range): neither preflight nor type rules nor backend coverage —
 * each refusal names the profile entry involved and the fix, and SC4004/
 * SC4005 additionally carry the profile's own teaching text when the
 * profile supplies one (the ratification session's rider). */

/** SC4001 — the profile file itself is malformed: parse errors, unknown
 * fields at meaning-changing positions, prefix violations, duplicate
 * symbols, bad C identifiers. Anchored at the profile file. */
export function libProfileDiag(detail: string, profilePath: string): ScrDiagnostic {
  return {
    code: "SC4001",
    message: `library profile invalid: ${detail}`,
    loc: { file: profilePath, start: 0, end: 0 },
  };
}

/** SC4002 — an export-map entry names something the entry module does not
 * export as a function value. */
export function libExportUnresolvedDiag(exportName: string, detail: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC4002",
    message: `library export '${exportName}' cannot be resolved: ${detail}`,
    loc,
    hint:
      "the export map may only name function declarations exported by the profile's ONE entry module; " +
      "a program with exports scattered across files writes a one-line facade module that re-exports them " +
      "and points the profile's entry at the facade",
  };
}

/** SC4003 — a mapped export's parameter or return is outside the v1
 * marshalling classes, or does not fit the class the profile declared. */
export function libUnmappableSignatureDiag(
  exportName: string,
  position: string,
  detail: string,
  loc: SrcLoc,
): ScrDiagnostic {
  return {
    code: "SC4003",
    message: `library export '${exportName}': ${position} ${detail}`,
    loc,
    hint:
      "v1 marshalling classes: f64/u8/u32/i32 (TS number), bool, string, bytes (Uint8Array/Buffer), and a void return; " +
      "records and unions slot in when the contract-sidecar conversation (asks 2/3) lands — deferral, not permanent unsupport",
  };
}

/** SC4004 — a mapped export is async or a generator: a synchronous ABI
 * entry cannot be either. Carries the profile's teaching when supplied. */
export function libAsyncExportDiag(
  exportName: string,
  kind: "async" | "generator",
  loc: SrcLoc,
  teaching?: string,
): ScrDiagnostic {
  return {
    code: "SC4004",
    message: `library export '${exportName}' is ${kind === "async" ? "an async function" : "a generator"} — a profile entry is a synchronous ABI symbol`,
    loc,
    hint:
      "expose a synchronous facade function and map that instead" +
      (teaching !== undefined ? ` — ${teaching}` : ""),
  };
}

/** SC4005 — the library module graph reaches event-loop or ambient-process
 * surface (async functions, generators, timers, sockets, signals, child
 * processes, ...): async_free is a v1 REQUIREMENT, derived from the module
 * graph, never observed at runtime. Carries the profile's teaching. */
export function libAsyncSurfaceDiag(surface: string, loc: SrcLoc, teaching?: string): ScrDiagnostic {
  return {
    code: "SC4005",
    message: `library mode requires an async_free module graph, and this graph reaches ${surface}`,
    loc,
    hint:
      "v1 library artifacts link no event loop, install no signal handlers, and create no threads — remove the surface from " +
      "everything the entry module reaches" +
      (teaching !== undefined ? ` — ${teaching}` : ""),
  };
}

/** SC4006 — island/dynamic machinery on the library path: --dynamic,
 * --npm-static, npm imports, `any`-typed island surface. */
export function libDynamicDiag(what: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC4006",
    message: `${what} is not available in library mode — the island engine and embedded npm graphs are executable-lane machinery`,
    loc,
    hint: "library artifacts are provable only for the static tier: no engine, no hidden init, no threads",
  };
}

/** SC4007 — a mapped export whose signature keeps type parameters: every
 * compiled function is one concrete signature (the SC2005 monomorphization
 * rule, re-anchored at the profile entry). */
export function libGenericExportDiag(exportName: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC4007",
    message: `library export '${exportName}' is generic — a profile entry needs one concrete compiled signature`,
    loc,
    hint:
      "pin a concrete instantiation in the entry (or facade) module and map that: " +
      "export const update_f64 = update<number>",
  };
}

/** SC4009 — the contract sidecar cannot be projected: a profile
 * designation names nothing the entry declares, a designated type falls
 * outside the schema's closed vocabulary, or a contract convention const
 * is malformed. The sidecar records verdicts, never guesses — anything
 * unprojectable refuses with the offending declaration named. */
export function libSidecarDiag(detail: string, loc: SrcLoc, hint?: string): ScrDiagnostic {
  return {
    code: "SC4009",
    message: `contract sidecar: ${detail}`,
    loc,
    hint:
      hint ??
      "the sidecar's type table speaks a closed vocabulary (bool, number, string/Uint8Array, optional, arrays, " +
      "named records, string-literal-union enums, and kind-tagged unions of object literals) read from the entry " +
      "module's exported declarations in source order",
  };
}

/** SC4010 — a tabled or designated type's members gather from MORE THAN
 * ONE declaration site (interface merging, module augmentation, a
 * same-name exported declaration in another module): the merged member
 * order is a checker implementation detail no sidecar consumer can
 * reproduce from source, and declaration order IS the wire contract. The
 * teaching names every contributing site. */
export function libSidecarMergedDiag(name: string, sites: readonly string[], loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC4010",
    message: `contract sidecar: '${name}' gathers members from ${sites.length} declaration sites (${sites.join(", ")}) — a tabled type's order must derive from ONE declaration site`,
    loc,
    hint:
      `merged declaration order is a checker implementation detail that no sidecar consumer can reproduce from source — ` +
      `collapse '${name}' into a single declaration and delete or rename the other site(s): ${sites.join(", ")}`,
  };
}

/** SC4011 — a conditional or mapped type produces a tabled or designated
 * type: type-level computation has no author-visible declaration order,
 * so its member order cannot be the wire contract. */
export function libSidecarComputedDiag(name: string, which: "conditional" | "mapped", loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC4011",
    message: `contract sidecar: '${name}' is produced by a ${which} type — a tabled or designated type needs literal, declaration-ordered members`,
    loc,
    hint:
      "table and arm order is wire contract read from the declaration site, and a computed type's member order is " +
      "checker evaluation, not source — spell the union's arms (or the record's fields) literally in one declaration",
  };
}
/** SC4012 — the library-mode host-contract violation trap a generated
 * entry wrapper raises when an inbound bytes buffer's declared length falls
 * outside the marshalling class's range (past 2^53−1 — no real buffer, so
 * the host and the library disagree about the call contract). A RUNTIME
 * code, never a compile-time refusal: it rides the structured trap-teaching
 * message (library/trap-teaching.ts) the wrapper delivers through the panic
 * sink, alongside the trapping export's C symbol and the profile's teaching
 * and remediation text for this code when the profile supplies them. */
export const LIB_INBOUND_BYTES_TRAP_CODE = "SC4012";

export function iceDiag(message: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC9001",
    message: `internal compiler error: ${message} — please report this`,
    loc,
  };
}
