/* The ask-2 contract sidecar emitter: projects the entry module's typed
 * contract into the profile-supplied schema (format 1) — a single JSON
 * document beside the archive carrying the version/identity spine, the
 * type table, the model/msg designations, helper signatures, shape flags,
 * channels, the ABI attestation, and the determinism attestations.
 *
 * The sidecar is the CONTRACT, not the program: no source spans, no
 * bodies, no IR, no environment or machine data, no absolute paths, no
 * timestamps. Emission is deterministic — top-level keys in the schema's
 * §1 order, every array order semantic (declaration order where the
 * schema says declaration, profile canonical order for abi.exports), so
 * re-running the identical invocation reproduces a byte-identical file.
 *
 * Declaration order is read from the SYNTAX TREE (frontend/lib-contract.ts)
 * — never from checker property enumeration, which hands back internal or
 * sorted order (the ratified record-field-order ruling: the IR's sorted
 * canonicalization is storage; AST order is the contract).
 *
 * Not-yet facts emit the schema's stated absent forms, never invented
 * values: `integer_slots` is `[]` with every numeric slot spelled `f64`
 * (the pre-ask-4 sequencing the schema names valid — the empty list is
 * itself an attestation), and `deterministic` is computed from the module
 * graph (ir/nodes.ts's conservative ambient-surface scan), never
 * defaulted. */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { libSidecarDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { ContractFacts, ContractField, ContractTypeDecl, ContractTypeShape } from "../frontend/lib-contract.js";
import type { SrcLoc } from "../ir/nodes.js";
import type { LibraryProfile, LibrarySidecarConfig } from "./profile.js";
import { BUILD_ID_SEED, hex16, lengthPrefixedStream, SOURCE_HASH_SEED, wyhash64 } from "./wyhash.js";

/** The sidecar schema's format this emitter writes. */
export const SIDECAR_FORMAT = 1;

/* ── the schema's closed vocabularies ──────────────────────────────────── */

export type TypeRef =
  | { kind: "bool" }
  | { kind: "f64" }
  | { kind: "i64" }
  | { kind: "bytes" }
  | { kind: "void" }
  | { kind: "optional"; inner: TypeRef }
  | { kind: "slice"; elem: TypeRef }
  | { kind: "node"; name: string }
  | { kind: "value"; name: string }
  | { kind: "enum"; name: string }
  | { kind: "union"; name: string };

export type PayloadDescriptor =
  | { kind: "void" }
  | { kind: "bytes" }
  | { kind: "number"; class: "f64" | "i64" }
  | { kind: "number_bytes"; number_field: string; number_class: "f64" | "i64"; bytes_field: string }
  | { kind: "record"; name: string }
  | { kind: "union"; name: string }
  | { kind: "enum"; name: string }
  | { kind: "scalar"; type: TypeRef };

export interface SidecarStruct {
  name: string;
  synthesized?: true;
  fields: { name: string; type: TypeRef }[];
}
export interface SidecarEnum {
  name: string;
  members: string[];
}
export interface SidecarUnion {
  name: string;
  arms: { name: string; payload: TypeRef }[];
}
export interface SidecarHelper {
  name: string;
  params: TypeRef[];
  returns: TypeRef;
  arena: boolean;
}

/** The whole document, property-ordered exactly as §1 lists the fields
 * (JSON.stringify preserves insertion order — the construction order IS
 * the serialization order). */
export interface SidecarDoc {
  format: number;
  wire_version: number;
  abi_version: number;
  compiler_version: string;
  entry: string;
  source_hash: string;
  build_id: string;
  types: { structs: SidecarStruct[]; enums: SidecarEnum[]; unions: SidecarUnion[] };
  model: string;
  model_helpers: SidecarHelper[];
  model_unbound: string[];
  msg: { name: string; arms: { name: string; payload: PayloadDescriptor }[]; unbound: string[] };
  init_returns_cmd: boolean;
  update_returns_cmd: boolean;
  has_subscriptions: boolean;
  channels: {
    command_msg: boolean;
    frame_msg: boolean;
    key_msg: boolean;
    pinch_msg: boolean;
    appearance_msg: string | null;
    chrome_msg: string | null;
    env_msgs: { env: string; msg: string }[];
  };
  abi: { prefix: string; exports: string[]; snapshot_format: number };
  integer_slots: { slot: string; class: "i64" }[];
  deterministic: boolean;
  async_free: boolean;
}

/* ── identity hashing (schema §2 + the "module-graph" source contract) ─── */

let releaseVersion: string | null = null;

/** The compiler's exact release identifier — the published package
 * version, read once from the compiler package's own package.json (this
 * module lives two levels below the package root in src/ and dist/
 * alike). build_id input 1 and the sidecar's `compiler_version`. */
export function compilerReleaseVersion(): string {
  if (releaseVersion === null) {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    releaseVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  }
  return releaseVersion;
}

/** One path under the sidecar's canonical rules: compilation-root-relative
 * POSIX, or `profile:`-namespaced when the file sits outside the root
 * (never absolute, no `.`/`..` segments). */
export function canonicalPath(rootDir: string, file: string): string {
  const rel = relative(rootDir, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `profile:${file.split(/[\\/]/).pop()!}`;
  }
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export interface CanonicalModule {
  /** Compilation-root-relative POSIX path (or `profile:`-namespaced when
   * outside the root), never absolute, no `.`/`..` segments. */
  canonical: string;
  bytes: Uint8Array;
}

/** Canonicalize + sort the module graph for hashing: root-relative POSIX
 * paths, ascending by plain bytewise comparison of the path strings. A
 * module outside the compilation root (the profile file's directory)
 * cannot spell a canonical relative path, so it rides the `profile:`
 * namespace under its basename — deterministic and absolute-path-free. */
export function canonicalModuleGraph(rootDir: string, sources: ReadonlyMap<string, string>): CanonicalModule[] {
  const enc = new TextEncoder();
  const entries: CanonicalModule[] = [];
  for (const [file, text] of sources) {
    entries.push({ canonical: canonicalPath(rootDir, file), bytes: enc.encode(text) });
  }
  entries.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.canonical, "utf8"), Buffer.from(b.canonical, "utf8"));
    return c !== 0 ? c : Buffer.compare(a.bytes, b.bytes);
  });
  return entries;
}

/** build_id (schema §2: compiler version, profile bytes, sorted module
 * graph — every input length-prefixed) and source_hash (the
 * "module-graph" contract: the sorted module graph alone, so the value is
 * stable across compiler releases). Both 16 lowercase hex digits. */
export function libraryIdentityHashes(
  compilerVersion: string,
  profileBytes: Uint8Array,
  modules: readonly CanonicalModule[],
): { buildId: string; sourceHash: string } {
  const enc = new TextEncoder();
  const graphChunks: Uint8Array[] = [];
  for (const m of modules) {
    graphChunks.push(enc.encode(m.canonical), m.bytes);
  }
  const buildChunks: Uint8Array[] = [enc.encode(compilerVersion), profileBytes, ...graphChunks];
  return {
    buildId: hex16(wyhash64(lengthPrefixedStream(buildChunks), BUILD_ID_SEED)),
    sourceHash: hex16(wyhash64(lengthPrefixedStream(graphChunks), SOURCE_HASH_SEED)),
  };
}

/** The profile's canonical `abi.exports` suffix order: the identity
 * getters first (abi_version, then build_id), the mode-provided entries
 * (sink registration, init, collect, reset — declared ones only), then
 * the export map in profile order. Suffix = symbol minus prefix. */
export function abiExportSuffixes(profile: LibraryProfile): string[] {
  const strip = (sym: string): string => sym.slice(profile.prefix.length);
  const out: string[] = [];
  if (profile.sidecar !== null) {
    out.push(strip(profile.sidecar.abiVersionSymbol), strip(profile.sidecar.buildIdSymbol));
  }
  out.push(strip(profile.sinkRegisterSymbol), strip(profile.initSymbol));
  if (profile.collectSymbol !== null) out.push(strip(profile.collectSymbol));
  if (profile.resultResetSymbol !== null) out.push(strip(profile.resultResetSymbol));
  for (const e of profile.exports) out.push(strip(e.symbol));
  return out;
}

/* ── classification of the entry's declared types ──────────────────────── */

type Classified =
  | { c: "struct"; storage: "node" | "value"; fields: ContractField[]; decl: ContractTypeDecl; index: number }
  | { c: "enum"; members: string[]; decl: ContractTypeDecl; index: number }
  | { c: "tagged"; arms: { name: string; fields: ContractField[]; loc: SrcLoc }[]; decl: ContractTypeDecl; index: number }
  | { c: "unsupported"; why: string; decl: ContractTypeDecl; index: number };

function classify(decl: ContractTypeDecl, index: number): Classified {
  const s = decl.shape;
  if (s.k === "unsupported") return { c: "unsupported", why: s.text, decl, index };
  if (s.k === "object") {
    return { c: "struct", storage: decl.form === "interface" ? "node" : "value", fields: s.fields, decl, index };
  }
  if (decl.form === "alias" && s.k === "stringLit") return { c: "enum", members: [s.text], decl, index };
  if (decl.form === "alias" && s.k === "union") {
    if (s.parts.every((p) => p.k === "stringLit")) {
      return { c: "enum", members: s.parts.map((p) => (p as { text: string }).text), decl, index };
    }
    const arms: { name: string; fields: ContractField[]; loc: SrcLoc }[] = [];
    for (const p of s.parts) {
      if (p.k !== "object") {
        return { c: "unsupported", why: "a union mixing non-object constituents (a tagged union's arms are object literals with a string-literal 'kind')", decl, index };
      }
      const kindField = p.fields.find((f) => f.name === "kind");
      if (kindField === undefined || kindField.shape.k !== "stringLit" || kindField.optional) {
        return { c: "unsupported", why: "a union constituent without a non-optional string-literal 'kind' discriminant", decl, index };
      }
      arms.push({ name: kindField.shape.text, fields: p.fields.filter((f) => f.name !== "kind"), loc: kindField.loc });
    }
    return { c: "tagged", arms, decl, index };
  }
  return { c: "unsupported", why: `a shape outside the sidecar's vocabulary (${s.k})`, decl, index };
}

/* ── the projector ─────────────────────────────────────────────────────── */

interface TableEntry {
  entry: SidecarStruct | SidecarEnum | SidecarUnion;
  kind: "struct" | "enum" | "union";
  anchor: number;
  sub: number;
}

class SidecarError extends Error {
  constructor(
    readonly detail: string,
    readonly loc: SrcLoc,
  ) {
    super(detail);
  }
}

class Projector {
  private readonly byName = new Map<string, Classified>();
  private readonly table = new Map<string, TableEntry>();
  private readonly inProgress = new Set<string>();
  private synthCounter = 0;

  constructor(
    readonly facts: ContractFacts,
    readonly config: LibrarySidecarConfig,
    readonly entryLoc: SrcLoc,
  ) {
    facts.types.forEach((decl, index) => {
      if (this.byName.has(decl.name)) {
        throw new SidecarError(`the entry module declares '${decl.name}' twice — the type table has one namespace`, decl.loc);
      }
      this.byName.set(decl.name, classify(decl, index));
    });
  }

  lookup(name: string, loc: SrcLoc): Exclude<Classified, { c: "unsupported" }> {
    const c = this.byName.get(name);
    if (c === undefined) {
      throw new SidecarError(`'${name}' is not an exported type declaration of the entry module`, loc);
    }
    if (c.c === "unsupported") {
      throw new SidecarError(`'${name}' cannot join the type table: it is ${c.why}`, c.decl.loc);
    }
    return c;
  }

  /** Project a syntactic field to a TypeRef, tabling every named type it
   * references. `container`/`member` seed synthesized names. */
  fieldRef(field: ContractField, container: string): TypeRef {
    const inner = this.shapeRef(field.shape, container, field.name, field.loc);
    if (field.optional) {
      if (inner.kind === "optional") return inner;
      return { kind: "optional", inner };
    }
    return inner;
  }

  shapeRef(shape: ContractTypeShape, container: string, member: string, loc: SrcLoc): TypeRef {
    switch (shape.k) {
      case "bool":
        return { kind: "bool" };
      case "number":
        // Every numeric slot spells f64 until ask-4 integer inference
        // lands (the schema's stated pre-inference sequencing).
        return { kind: "f64" };
      case "text":
      case "bytes":
        return { kind: "bytes" };
      case "array":
        return { kind: "slice", elem: this.shapeRef(shape.elem, container, member, loc) };
      case "union": {
        const present = shape.parts.filter((p) => p.k !== "absent");
        const absents = shape.parts.length - present.length;
        if (absents > 0 && present.length === 1) {
          const inner = this.shapeRef(present[0]!, container, member, loc);
          return inner.kind === "optional" ? inner : { kind: "optional", inner };
        }
        throw new SidecarError(
          `'${container}.${member}' is an inline union — declare it as a named kind-tagged union (or a string-literal-union enum) and reference it by name`,
          loc,
        );
      }
      case "ref": {
        const c = this.lookup(shape.name, loc);
        if (c.c === "struct") {
          this.tableNamed(shape.name, loc);
          return { kind: c.storage, name: shape.name };
        }
        if (c.c === "enum") {
          this.tableNamed(shape.name, loc);
          return { kind: "enum", name: shape.name };
        }
        if (shape.name === this.config.msg) {
          throw new SidecarError(
            `'${container}.${member}' references the designated msg union '${shape.name}' — the msg union is the dispatch surface, not a table type`,
            loc,
          );
        }
        this.tableNamed(shape.name, loc);
        return { kind: "union", name: shape.name };
      }
      case "object":
        return { kind: "value", name: this.tableSynthesized(container, member, shape.fields, loc) };
      case "stringLit":
        throw new SidecarError(
          `'${container}.${member}' is a bare string-literal type — declare a named string-literal union and reference it as an enum`,
          loc,
        );
      case "void":
        throw new SidecarError(`'${container}.${member}' is void — void exists only as a bare union arm's payload`, loc);
      case "absent":
        throw new SidecarError(`'${container}.${member}' is null/undefined alone — pair it with a value type for an optional slot`, loc);
      case "tuple":
        throw new SidecarError(`'${container}.${member}' is a tuple — the sidecar vocabulary has slices and named records, not positional tuples`, loc);
      case "unsupported":
        throw new SidecarError(`'${container}.${member}' has no sidecar projection: ${shape.text}`, loc);
    }
  }

  /** Ensure a declared type's table entry exists (recursively projecting
   * what it references). Cycles refuse: recursive contract types cannot
   * encode (schema rule V5). */
  tableNamed(name: string, loc: SrcLoc): void {
    if (this.table.has(name)) return;
    if (name === this.config.msg) {
      throw new SidecarError(`the designated msg union '${name}' cannot join the type table`, loc);
    }
    if (this.inProgress.has(name)) {
      throw new SidecarError(`the contract type graph is cyclic through '${name}' — recursive contract types cannot encode`, loc);
    }
    const c = this.lookup(name, loc);
    this.inProgress.add(name);
    try {
      if (c.c === "enum") {
        const seen = new Set<string>();
        for (const m of c.members) {
          if (seen.has(m)) throw new SidecarError(`enum '${name}' repeats member '${m}'`, c.decl.loc);
          seen.add(m);
        }
        this.table.set(name, { kind: "enum", entry: { name, members: c.members }, anchor: c.index, sub: -1 });
        return;
      }
      if (c.c === "struct") {
        const entry: SidecarStruct = { name, fields: [] };
        // Insert before projecting fields? No: cycle detection rides
        // inProgress; the entry lands complete.
        const seen = new Set<string>();
        for (const f of c.fields) {
          if (seen.has(f.name)) throw new SidecarError(`record '${name}' repeats field '${f.name}'`, f.loc);
          seen.add(f.name);
          entry.fields.push({ name: f.name, type: this.fieldRef(f, name) });
        }
        this.table.set(name, { kind: "struct", entry, anchor: c.index, sub: -1 });
        return;
      }
      // A named tagged union (never the msg union — fenced above).
      const entry: SidecarUnion = { name, arms: [] };
      const seen = new Set<string>();
      for (const arm of c.arms) {
        if (seen.has(arm.name)) throw new SidecarError(`union '${name}' repeats arm '${arm.name}'`, arm.loc);
        seen.add(arm.name);
        entry.arms.push({ name: arm.name, payload: this.armPayloadRef(name, arm) });
      }
      this.table.set(name, { kind: "union", entry, anchor: c.index, sub: -1 });
    } finally {
      this.inProgress.delete(name);
    }
  }

  /** A named union arm's payload TypeRef: void for bare arms, the single
   * payload field's type, or a synthesized by-value record for
   * multi-field inline payloads. */
  armPayloadRef(unionName: string, arm: { name: string; fields: ContractField[]; loc: SrcLoc }): TypeRef {
    if (arm.fields.length === 0) return { kind: "void" };
    if (arm.fields.length === 1) return this.fieldRef(arm.fields[0]!, unionName);
    return { kind: "value", name: this.tableSynthesized(unionName, arm.name, arm.fields, arm.loc) };
  }

  /** Table an anonymous inline record under the schema's synthesized-name
   * contract: `<Container>_<member>`, deterministic and stable across
   * identical re-compiles, unique in the one namespace. */
  tableSynthesized(container: string, member: string, fields: ContractField[], loc: SrcLoc): string {
    const name = `${container}_${member}`;
    const existing = this.table.get(name);
    if (existing !== undefined) return name; // the same inline decl, revisited
    if (this.byName.has(name)) {
      throw new SidecarError(
        `the inline record at '${container}.${member}' needs the synthesized name '${name}', which a declared type already uses — rename one`,
        loc,
      );
    }
    const entry: SidecarStruct = { name, synthesized: true, fields: [] };
    const anchor = this.byName.get(container)?.index ?? this.facts.types.length;
    const sub = this.synthCounter++;
    this.table.set(name, { kind: "struct", entry, anchor, sub });
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) throw new SidecarError(`the inline record at '${container}.${member}' repeats field '${f.name}'`, f.loc);
      seen.add(f.name);
      entry.fields.push({ name: f.name, type: this.fieldRef(f, name) });
    }
    return name;
  }

  /** A msg arm's payload descriptor (§5's five families). */
  msgDescriptor(msgName: string, arm: { name: string; fields: ContractField[]; loc: SrcLoc }): PayloadDescriptor {
    const fields = arm.fields;
    if (fields.length === 0) return { kind: "void" };
    if (fields.length === 2) {
      const [first, second] = [fields[0]!, fields[1]!];
      // Family 4 covers exactly the number-first two-field record; a
      // bytes-first spelling takes the record family instead
      // (declaration order is semantic everywhere — the clarified rule).
      if (
        !first.optional &&
        !second.optional &&
        first.shape.k === "number" &&
        (second.shape.k === "text" || second.shape.k === "bytes")
      ) {
        return { kind: "number_bytes", number_field: first.name, number_class: "f64", bytes_field: second.name };
      }
    }
    if (fields.length === 1 && !fields[0]!.optional) {
      const ref = this.fieldRef(fields[0]!, msgName);
      switch (ref.kind) {
        case "bytes":
          return { kind: "bytes" };
        case "f64":
        case "i64":
          return { kind: "number", class: ref.kind };
        case "node":
        case "value":
          return { kind: "record", name: ref.name };
        case "union":
          return { kind: "union", name: ref.name };
        case "enum":
          return { kind: "enum", name: ref.name };
        case "void":
          return { kind: "void" };
        default:
          return { kind: "scalar", type: ref };
      }
    }
    // Everything else — bytes-first pairs, three-plus fields, optional
    // payload fields — tables a synthesized record (family 5).
    return { kind: "record", name: this.tableSynthesized(msgName, arm.name, fields, arm.loc) };
  }

  /** The finished type table, each array in declaration order (synthesized
   * entries anchor at their containing declaration). */
  finishedTable(): { structs: SidecarStruct[]; enums: SidecarEnum[]; unions: SidecarUnion[] } {
    const ordered = [...this.table.values()].sort((a, b) => a.anchor - b.anchor || a.sub - b.sub);
    return {
      structs: ordered.filter((e) => e.kind === "struct").map((e) => e.entry as SidecarStruct),
      enums: ordered.filter((e) => e.kind === "enum").map((e) => e.entry as SidecarEnum),
      unions: ordered.filter((e) => e.kind === "union").map((e) => e.entry as SidecarUnion),
    };
  }
}

/* ── the document builder ──────────────────────────────────────────────── */

export interface SidecarBuildInput {
  profile: LibraryProfile;
  facts: ContractFacts;
  compilerVersion: string;
  /** Entry module path, compilation-root-relative, POSIX separators. */
  entry: string;
  buildId: string;
  sourceHash: string;
  deterministic: boolean;
}

export type SidecarBuildResult =
  | { ok: true; doc: SidecarDoc; json: string }
  | { ok: false; diagnostics: ScrDiagnostic[] };

/** Whether a helper's result rides the transient result arena (anything
 * materialized: buffers, slices, records, optionals) rather than a plain
 * scalar return. */
function helperArena(returns: TypeRef): boolean {
  return returns.kind !== "bool" && returns.kind !== "f64" && returns.kind !== "i64" && returns.kind !== "enum";
}

export function buildSidecar(input: SidecarBuildInput): SidecarBuildResult {
  const { profile, facts } = input;
  const config = profile.sidecar!;
  const entryLoc: SrcLoc = { file: profile.entry, start: 0, end: 0 };
  const diagnostics: ScrDiagnostic[] = [];

  for (const m of facts.malformedConsts) {
    diagnostics.push(libSidecarDiag(`exported const '${m.name}' ${m.detail}`, m.loc));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  try {
    const projector = new Projector(facts, config, entryLoc);

    // The model: the designated root state type, a record in the table.
    const modelClass = projector.lookup(config.model, entryLoc);
    if (modelClass.c !== "struct") {
      throw new SidecarError(`the profile designates model '${config.model}', which is not a record type`, modelClass.decl.loc);
    }
    projector.tableNamed(config.model, entryLoc);
    const modelFieldNames = new Set(modelClass.fields.map((f) => f.name));

    // The msg union: declaration-order arms, positional wire tags, at
    // most 256 arms (tags ride a u8).
    const msgClass = projector.lookup(config.msg, entryLoc);
    if (msgClass.c !== "tagged") {
      throw new SidecarError(`the profile designates msg '${config.msg}', which is not a kind-tagged union of object literals`, msgClass.decl.loc);
    }
    if (msgClass.arms.length > 256) {
      throw new SidecarError(
        `msg union '${config.msg}' declares ${msgClass.arms.length} arms — wire tags ride a u8, so at most 256 are permitted`,
        msgClass.decl.loc,
      );
    }
    const seenArms = new Set<string>();
    const msgArms: { name: string; payload: PayloadDescriptor }[] = [];
    for (const arm of msgClass.arms) {
      if (seenArms.has(arm.name)) throw new SidecarError(`msg union '${config.msg}' repeats arm '${arm.name}'`, arm.loc);
      seenArms.add(arm.name);
      msgArms.push({ name: arm.name, payload: projector.msgDescriptor(config.msg, arm) });
    }
    const armByName = new Map(msgArms.map((a) => [a.name, a.payload]));

    // Helpers: exported functions taking the model first, in declaration
    // order (the array index is the ABI call index), minus the designated
    // init/update/subscriptions entries.
    const designated = new Set([config.initExport, config.updateExport, config.subscriptionsExport]);
    const helpers: SidecarHelper[] = [];
    for (const fn of facts.functions) {
      if (designated.has(fn.name)) continue;
      const first = fn.params[0];
      if (first === undefined || first.shape === null || first.shape.k !== "ref" || first.shape.name !== config.model) continue;
      if (fn.generic) {
        throw new SidecarError(`helper '${fn.name}' is generic — a contract helper needs one concrete signature`, fn.loc);
      }
      const params: TypeRef[] = [];
      fn.params.slice(1).forEach((p, i) => {
        if (p.shape === null) {
          throw new SidecarError(`helper '${fn.name}' parameter ${i + 2} ('${p.name}') has no type annotation`, fn.loc);
        }
        params.push(projector.shapeRef(p.shape, `helpers_${fn.name}`, p.name, fn.loc));
      });
      if (fn.returns === null) {
        throw new SidecarError(`helper '${fn.name}' has no return type annotation`, fn.loc);
      }
      if (fn.returns.k === "void") {
        throw new SidecarError(`helper '${fn.name}' returns void — a contract helper returns a value the host can read`, fn.loc);
      }
      // Helper-return synthesized names are two-part like everything else:
      // container 'helpers', member the helper's name — `helpers_<name>`,
      // never a '_return' suffix (the ratified spelling).
      const returns = projector.shapeRef(fn.returns, "helpers", fn.name, fn.loc);
      if (helpers.some((h) => h.name === fn.name)) {
        throw new SidecarError(`helper '${fn.name}' is declared twice`, fn.loc);
      }
      helpers.push({ name: fn.name, params, returns, arena: helperArena(returns) });
    }
    const helperNames = new Set(helpers.map((h) => h.name));

    // Shape flags from the designated entries' declared signatures.
    const returnsCmd = (which: "init" | "update", exportName: string): boolean => {
      const fn = facts.functions.find((f) => f.name === exportName);
      if (fn === undefined) {
        throw new SidecarError(`the profile designates ${which} export '${exportName}', but the entry module exports no function by that name`, entryLoc);
      }
      const r = fn.returns;
      if (r !== null && r.k === "ref" && r.name === config.model) return false;
      if (r !== null && r.k === "tuple" && r.elems.length === 2 && r.elems[0]!.k === "ref" && (r.elems[0] as { name: string }).name === config.model) {
        return true;
      }
      throw new SidecarError(
        `${which} export '${exportName}' must declare its return as '${config.model}' (bare state) or a two-element tuple '[${config.model}, ...]' (state plus an effect value)`,
        fn.loc,
      );
    };
    const initReturnsCmd = returnsCmd("init", config.initExport);
    const updateReturnsCmd = returnsCmd("update", config.updateExport);
    const hasSubscriptions = facts.functions.some((f) => f.name === config.subscriptionsExport);

    // Unbound lists: model fields or helper entries (helpers are bindable
    // surface — the clarified rule) on the model side, arm names on the
    // msg side. Absent consts mean "the program declares none".
    const modelUnbound = facts.modelUnbound?.value ?? [];
    for (const name of modelUnbound) {
      if (!modelFieldNames.has(name) && !helperNames.has(name)) {
        throw new SidecarError(
          `modelUnbound names '${name}', which is neither a field of '${config.model}' nor a helper entry`,
          facts.modelUnbound!.loc,
        );
      }
    }
    const msgUnbound = facts.msgUnbound?.value ?? [];
    for (const name of msgUnbound) {
      if (!armByName.has(name)) {
        throw new SidecarError(`msgUnbound names '${name}', which is not an arm of '${config.msg}'`, facts.msgUnbound!.loc);
      }
    }

    // Channels: the four function channels answer export presence by
    // suffix; the two host-constructed channels and the env map ride the
    // exported-const conventions and must target conforming arms.
    const exports = abiExportSuffixes(profile);
    const exportSet = new Set(exports);
    const namedChannel = (constName: "appearanceMsg" | "chromeMsg"): string | null => {
      const c = facts[constName];
      if (c === null) return null;
      const payload = armByName.get(c.value);
      if (payload === undefined) {
        throw new SidecarError(`${constName} names '${c.value}', which is not an arm of '${config.msg}'`, c.loc);
      }
      if (payload.kind !== "record" && payload.kind !== "union" && payload.kind !== "enum" && payload.kind !== "scalar") {
        throw new SidecarError(
          `${constName} names arm '${c.value}', whose payload descriptor is '${payload.kind}' — a host-constructed channel arm needs a named-type-family payload`,
          c.loc,
        );
      }
      return c.value;
    };
    const envMsgs = facts.envMsgs?.value ?? [];
    const seenEnv = new Set<string>();
    for (const e of envMsgs) {
      if (seenEnv.has(e.env)) {
        throw new SidecarError(`envMsgs repeats environment variable '${e.env}'`, facts.envMsgs!.loc);
      }
      seenEnv.add(e.env);
      const payload = armByName.get(e.msg);
      if (payload === undefined) {
        throw new SidecarError(`envMsgs targets '${e.msg}', which is not an arm of '${config.msg}'`, facts.envMsgs!.loc);
      }
      if (payload.kind !== "bytes") {
        throw new SidecarError(
          `envMsgs targets arm '${e.msg}', whose payload descriptor is '${payload.kind}' — the host delivers an environment value as bytes`,
          facts.envMsgs!.loc,
        );
      }
    }

    const doc: SidecarDoc = {
      format: SIDECAR_FORMAT,
      wire_version: config.wireVersion,
      abi_version: config.abiVersion,
      compiler_version: input.compilerVersion,
      entry: input.entry,
      source_hash: input.sourceHash,
      build_id: input.buildId,
      types: projector.finishedTable(),
      model: config.model,
      model_helpers: helpers,
      model_unbound: modelUnbound,
      msg: { name: config.msg, arms: msgArms, unbound: msgUnbound },
      init_returns_cmd: initReturnsCmd,
      update_returns_cmd: updateReturnsCmd,
      has_subscriptions: hasSubscriptions,
      channels: {
        command_msg: exportSet.has("command_msg"),
        frame_msg: exportSet.has("frame_msg"),
        key_msg: exportSet.has("key_msg"),
        pinch_msg: exportSet.has("pinch_msg"),
        appearance_msg: namedChannel("appearanceMsg"),
        chrome_msg: namedChannel("chromeMsg"),
        env_msgs: envMsgs,
      },
      abi: { prefix: profile.prefix, exports, snapshot_format: config.snapshotFormat },
      // The pre-ask-4 absent form the schema names valid: every numeric
      // slot above spelled f64, and the empty list is itself the
      // attestation that no slot was integer-classed.
      integer_slots: [],
      deterministic: input.deterministic,
      // Structural in library mode: the SC4005 gate refused any graph
      // reaching async/timer/event-loop surface before emission, so a
      // sidecar exists only for async_free graphs.
      async_free: true,
    };
    return { ok: true, doc, json: JSON.stringify(doc, null, 2) + "\n" };
  } catch (e) {
    if (e instanceof SidecarError) {
      return { ok: false, diagnostics: [libSidecarDiag(e.detail, e.loc)] };
    }
    throw e;
  }
}
