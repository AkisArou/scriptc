/* Core-mode profile: the published configuration file an embedder ships to
 * name its ABI (symbol prefix, entry module, export map with per-param/
 * return marshalling classes, and the mode-provided symbol names). The
 * profile is configuration, not code — scriptc knows nothing about any
 * particular embedder; a second embedder writes its own profile against the
 * same mode. Every validation failure is SC4001 with the offending JSON
 * path named (the design's "profile malformed" family: parse errors,
 * meaning-changing unknown fields, prefix violations, duplicate symbols,
 * bad C identifiers).
 *
 * Ratified shape (core-mode-design.md §5.1 + the ABI ratification session):
 *   {
 *     "profile_format": 1,
 *     "name": "<embedder identity string>",
 *     "entry": "src/core.ts",                  // ONE module, profile-relative
 *     "emission": "llvm" | "c",                // pins the emission; no fallback
 *     "abi": {
 *       "prefix": "<prefix>_",
 *       "init_symbol": "<prefix>_init",
 *       "sink_register_symbol": "<prefix>_set_panic_sink",
 *       "collect_symbol": "<prefix>_collect" | null,   // session ruling 2
 *       "result_reset_symbol": "<prefix>_reset" | null // §4.3 two postures
 *     },
 *     "exports": [ { "export": "update", "symbol": "<prefix>_update",
 *                    "params": ["f64", "string"], "returns": "bytes" } ],
 *     "determinism": { ... }                   // ask-5 surface, reserved;
 *                                              // only `teachings` is read
 *                                              // today (the SC4004/SC4005
 *                                              // teaching rider)
 *   }
 *
 * Marshalling classes (design §4.2 + session ruling 3): f64, bool, string,
 * bytes for params and returns; u8/u32/i32 are PARAM-ONLY plumbing classes
 * in v1 (outbound integer returns wait for ask-4's prove-or-refuse
 * machinery); void is return-only. Unknown top-level fields are ignored
 * (reserved surface: determinism, identity/version echo); unknown fields
 * INSIDE `abi` and export entries are refused — a typo there silently
 * changes meaning. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { coreProfileDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";

/** Marshalling classes legal in PARAMETER position (v1). */
export const CORE_PARAM_CLASSES = ["f64", "bool", "string", "bytes", "u8", "u32", "i32"] as const;
/** Marshalling classes legal in RETURN position (v1): the value classes
 * plus void; the integer plumbing classes are param-only until ask 4. */
export const CORE_RETURN_CLASSES = ["f64", "bool", "string", "bytes", "void"] as const;

export type CoreParamClass = (typeof CORE_PARAM_CLASSES)[number];
export type CoreReturnClass = (typeof CORE_RETURN_CLASSES)[number];

export interface CoreExportEntry {
  /** The entry module's export name. */
  export: string;
  /** The external C symbol the wrapper is emitted under. */
  symbol: string;
  params: CoreParamClass[];
  returns: CoreReturnClass;
}

export interface CoreProfile {
  profileFormat: 1;
  name: string;
  /** Resolved absolute path of the ONE entry module. */
  entry: string;
  /** The pinned emission — no fallback concept exists on the core path. */
  emission: "llvm" | "c";
  prefix: string;
  initSymbol: string;
  sinkRegisterSymbol: string;
  /** Session ruling 2's mode-provided collect entry (delegates to the
   * runtime cycle collector; snapshot-invariant, arena-resetting). Null =
   * the profile declares none. */
  collectSymbol: string | null;
  /** §4.3: declared → results accumulate until the host calls it; null →
   * every entry prologue resets the result arena. */
  resultResetSymbol: string | null;
  exports: CoreExportEntry[];
  /** Profile-supplied teaching text appended to refusals (the ratified
   * SC4004/SC4005 rider): keyed by diagnostic code ("SC4005"), with
   * "async" accepted as the shared key for both async-surface codes. */
  teachings: Readonly<Record<string, string>>;
}

const C_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class ProfileError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function req<T>(v: unknown, path: string, kind: "string" | "number" | "boolean"): T {
  if (typeof v !== kind) {
    throw new ProfileError(`'${path}' must be a ${kind}${v === undefined ? " (missing)" : ""}`);
  }
  return v as T;
}

function symbolField(v: unknown, path: string, prefix: string, nullable: boolean): string | null {
  if (nullable && (v === null || v === undefined)) return null;
  const s = req<string>(v, path, "string");
  if (!C_IDENT.test(s)) throw new ProfileError(`'${path}' is not a valid C identifier: '${s}'`);
  if (!s.startsWith(prefix)) {
    throw new ProfileError(`'${path}' must start with the profile prefix '${prefix}': '${s}'`);
  }
  return s;
}

function rejectUnknownKeys(obj: object, path: string, known: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      throw new ProfileError(`unknown field '${path}.${k}' (a typo here would change the ABI; remove it)`);
    }
  }
}

/** Parse + validate a profile file. Returns the profile or the SC4001
 * diagnostics (one per problem found before parsing had to stop). */
export function loadCoreProfile(
  profilePath: string,
): { ok: true; profile: CoreProfile } | { ok: false; diagnostics: ScrDiagnostic[] } {
  const fail = (detail: string): { ok: false; diagnostics: ScrDiagnostic[] } => ({
    ok: false,
    diagnostics: [coreProfileDiag(detail, profilePath)],
  });
  let text: string;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch (e) {
    return fail(`cannot read profile: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`profile is not valid JSON (${(e as Error).message})`);
  }
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ProfileError("profile must be a JSON object");
    }
    const p = raw as Record<string, unknown>;
    const format = req<number>(p["profile_format"], "profile_format", "number");
    if (format !== 1) throw new ProfileError(`unsupported profile_format ${format} (this scriptc reads format 1)`);
    const name = req<string>(p["name"], "name", "string");
    if (name === "") throw new ProfileError("'name' must be a non-empty identity string");
    const entryRel = req<string>(p["entry"], "entry", "string");
    if (entryRel === "") throw new ProfileError("'entry' must name the profile's one entry module");
    const emission = req<string>(p["emission"], "emission", "string");
    if (emission !== "llvm" && emission !== "c") {
      throw new ProfileError(`'emission' must be "llvm" or "c", got '${emission}'`);
    }
    const abi = p["abi"];
    if (abi === null || typeof abi !== "object" || Array.isArray(abi)) {
      throw new ProfileError("'abi' must be an object");
    }
    rejectUnknownKeys(abi, "abi", ["prefix", "init_symbol", "sink_register_symbol", "collect_symbol", "result_reset_symbol"]);
    const a = abi as Record<string, unknown>;
    const prefix = req<string>(a["prefix"], "abi.prefix", "string");
    if (!C_IDENT.test(prefix)) {
      throw new ProfileError(`'abi.prefix' is not a valid C identifier fragment: '${prefix}'`);
    }
    const initSymbol = symbolField(a["init_symbol"], "abi.init_symbol", prefix, false)!;
    const sinkRegisterSymbol = symbolField(a["sink_register_symbol"], "abi.sink_register_symbol", prefix, false)!;
    const collectSymbol = symbolField(a["collect_symbol"], "abi.collect_symbol", prefix, true);
    const resultResetSymbol = symbolField(a["result_reset_symbol"], "abi.result_reset_symbol", prefix, true);

    const exportsRaw = p["exports"];
    if (!Array.isArray(exportsRaw)) throw new ProfileError("'exports' must be an array");
    const entries: CoreExportEntry[] = [];
    exportsRaw.forEach((e, i) => {
      const path = `exports[${i}]`;
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        throw new ProfileError(`'${path}' must be an object`);
      }
      rejectUnknownKeys(e, path, ["export", "symbol", "params", "returns"]);
      const ee = e as Record<string, unknown>;
      const exportName = req<string>(ee["export"], `${path}.export`, "string");
      if (exportName === "") throw new ProfileError(`'${path}.export' must be a non-empty export name`);
      const symbol = symbolField(ee["symbol"], `${path}.symbol`, prefix, false)!;
      const paramsRaw = ee["params"];
      if (!Array.isArray(paramsRaw)) throw new ProfileError(`'${path}.params' must be an array`);
      const params = paramsRaw.map((c, j) => {
        if (typeof c !== "string" || !(CORE_PARAM_CLASSES as readonly string[]).includes(c)) {
          throw new ProfileError(
            `'${path}.params[${j}]' must be one of ${CORE_PARAM_CLASSES.join("/")}, got ${JSON.stringify(c)}`,
          );
        }
        return c as CoreParamClass;
      });
      const returns = req<string>(ee["returns"], `${path}.returns`, "string");
      if (!(CORE_RETURN_CLASSES as readonly string[]).includes(returns)) {
        const detail =
          returns === "u8" || returns === "u32" || returns === "i32"
            ? `'${path}.returns': integer classes are parameter-only in v1 — outbound integer returns wait for the prove-or-refuse machinery (ask 4); return f64 and convert on the host side`
            : `'${path}.returns' must be one of ${CORE_RETURN_CLASSES.join("/")}, got '${returns}'`;
        throw new ProfileError(detail);
      }
      entries.push({ export: exportName, symbol, params, returns: returns as CoreReturnClass });
    });

    // Pairwise-distinct symbols across the whole declared set (exports +
    // the mode-provided entries).
    const all = new Map<string, string>();
    const claim = (sym: string | null, path: string): void => {
      if (sym === null) return;
      const prev = all.get(sym);
      if (prev !== undefined) {
        throw new ProfileError(`symbol '${sym}' is declared twice (${prev} and ${path}); symbols must be pairwise distinct`);
      }
      all.set(sym, path);
    };
    claim(initSymbol, "abi.init_symbol");
    claim(sinkRegisterSymbol, "abi.sink_register_symbol");
    claim(collectSymbol, "abi.collect_symbol");
    claim(resultResetSymbol, "abi.result_reset_symbol");
    entries.forEach((e, i) => claim(e.symbol, `exports[${i}].symbol`));
    const exportNames = new Set<string>();
    entries.forEach((e, i) => {
      if (exportNames.has(e.export)) {
        throw new ProfileError(`export '${e.export}' is mapped twice (exports[${i}])`);
      }
      exportNames.add(e.export);
    });

    // Ask-5 surface: only the teachings rider is read today; everything
    // else under `determinism` is reserved and ignored.
    const teachings: Record<string, string> = {};
    const det = p["determinism"];
    if (det !== undefined && det !== null && typeof det === "object" && !Array.isArray(det)) {
      const t = (det as Record<string, unknown>)["teachings"];
      if (t !== undefined && t !== null && typeof t === "object" && !Array.isArray(t)) {
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof v === "string") teachings[k] = v;
        }
      }
    }

    const entry = isAbsolute(entryRel) ? entryRel : resolve(dirname(profilePath), entryRel);
    return {
      ok: true,
      profile: {
        profileFormat: 1,
        name,
        entry,
        emission,
        prefix,
        initSymbol,
        sinkRegisterSymbol,
        collectSymbol,
        resultResetSymbol,
        exports: entries,
        teachings,
      },
    };
  } catch (e) {
    if (e instanceof ProfileError) return fail(e.detail);
    throw e;
  }
}

/** The profile's teaching text for one refusal code (the ratified rider:
 * SC4004/SC4005 carry profile-supplied guidance naming the embedder's
 * sanctioned alternative). Falls back to the shared "async" key. */
export function profileTeaching(profile: CoreProfile, code: string): string | undefined {
  return profile.teachings[code] ?? (code === "SC4004" || code === "SC4005" ? profile.teachings["async"] : undefined);
}
