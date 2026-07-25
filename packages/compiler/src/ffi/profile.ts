/* Outbound native-FFI manifest. The manifest is configuration, never code:
 * it binds signature-only TypeScript declarations to C ABI symbols and
 * names the link inputs an executable build adds after its generated
 * translation unit.
 *
 * Format 1:
 * {
 *   "ffi_format": 1,
 *   "functions": [
 *     { "name": "nativeScale", "symbol": "native_scale",
 *       "params": ["f64"], "returns": "f64" }
 *   ],
 *   "libraries": ["native/libnative.a"],
 *   "system_libraries": ["m"]
 * }
 *
 * string and bytes parameters expand to the length-delimited C pair
 * `(const uint8_t *, size_t)`. Their storage is borrowed for the duration
 * of the call only. Return values deliberately stay scalar in format 1:
 * pointer ownership needs an allocator/free contract, not a guess. */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ffiProfileDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";

export const FFI_PARAM_CLASSES = [
  "f64",
  "bool",
  "u8",
  "u32",
  "i32",
  "string",
  "bytes",
] as const;

export const FFI_RETURN_CLASSES = ["f64", "bool", "u8", "u32", "i32", "void"] as const;

export type FfiParamClass = (typeof FFI_PARAM_CLASSES)[number];
export type FfiReturnClass = (typeof FFI_RETURN_CLASSES)[number];

export interface FfiFunction {
  /** The signature-only TypeScript function declaration's binding name. */
  name: string;
  /** The external C symbol linked into the executable. */
  symbol: string;
  params: FfiParamClass[];
  returns: FfiReturnClass;
}

export interface FfiProfile {
  ffiFormat: 1;
  functions: FfiFunction[];
  /** Absolute paths, resolved relative to the manifest. */
  libraries: string[];
  /** Driver-neutral names; the linker receives each as `-l<name>`. */
  systemLibraries: string[];
}

class FfiProfileError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

const C_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SYSTEM_LIBRARY = /^[A-Za-z0-9_+.-]+$/;

function rejectUnknownKeys(obj: object, path: string, known: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const field = path === "" ? key : `${path}.${key}`;
      throw new FfiProfileError(
        `unknown field '${field}' ` +
          "(root and function keys are strict so an ABI typo cannot be ignored)",
      );
    }
  }
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new FfiProfileError(`'${path}' must be a string`);
  }
  if (value === "") throw new FfiProfileError(`'${path}' must be non-empty`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FfiProfileError(`'${path}' must be an array`);
  return value.map((entry, i) => stringField(entry, `${path}[${i}]`));
}

/** Parse and strictly validate one outbound native-FFI manifest. */
export function loadFfiProfile(
  profilePath: string,
): { ok: true; profile: FfiProfile } | { ok: false; diagnostics: ScrDiagnostic[] } {
  const fail = (detail: string): { ok: false; diagnostics: ScrDiagnostic[] } => ({
    ok: false,
    diagnostics: [ffiProfileDiag(detail, profilePath)],
  });
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(profilePath);
  } catch (err) {
    return fail(`cannot read manifest: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return fail(`manifest is not valid JSON (${(err as Error).message})`);
  }
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new FfiProfileError("manifest must be a JSON object");
    }
    const root = raw as Record<string, unknown>;
    const format = root["ffi_format"];
    if (format !== 1) {
      throw new FfiProfileError(
        typeof format === "number"
          ? `unsupported ffi_format ${format} (this scriptc reads format 1)`
          : "'ffi_format' must be the number 1",
      );
    }
    rejectUnknownKeys(root, "", [
      "ffi_format",
      "functions",
      "libraries",
      "system_libraries",
    ]);

    const functionsRaw = root["functions"];
    if (!Array.isArray(functionsRaw)) {
      throw new FfiProfileError("'functions' must be an array");
    }
    const names = new Set<string>();
    const symbols = new Set<string>();
    const functions = functionsRaw.map((entry, i): FfiFunction => {
      const path = `functions[${i}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new FfiProfileError(`'${path}' must be an object`);
      }
      rejectUnknownKeys(entry, path, ["name", "symbol", "params", "returns"]);
      const row = entry as Record<string, unknown>;
      const name = stringField(row["name"], `${path}.name`);
      if (!TS_IDENT.test(name)) {
        throw new FfiProfileError(`'${path}.name' is not a plain TypeScript identifier: '${name}'`);
      }
      if (names.has(name)) {
        throw new FfiProfileError(`function binding '${name}' is declared twice`);
      }
      names.add(name);

      const symbol = stringField(row["symbol"], `${path}.symbol`);
      if (!C_IDENT.test(symbol)) {
        throw new FfiProfileError(`'${path}.symbol' is not a C identifier: '${symbol}'`);
      }
      if (symbols.has(symbol)) {
        throw new FfiProfileError(`native symbol '${symbol}' is declared twice`);
      }
      symbols.add(symbol);

      if (!Array.isArray(row["params"])) {
        throw new FfiProfileError(`'${path}.params' must be an array`);
      }
      const params = row["params"].map((value, j) => {
        if (
          typeof value !== "string" ||
          !(FFI_PARAM_CLASSES as readonly string[]).includes(value)
        ) {
          throw new FfiProfileError(
            `'${path}.params[${j}]' must be one of ${FFI_PARAM_CLASSES.join("/")}, got ${JSON.stringify(value)}`,
          );
        }
        return value as FfiParamClass;
      });
      const returns = stringField(row["returns"], `${path}.returns`);
      if (!(FFI_RETURN_CLASSES as readonly string[]).includes(returns)) {
        throw new FfiProfileError(
          `'${path}.returns' must be one of ${FFI_RETURN_CLASSES.join("/")}, got '${returns}'`,
        );
      }
      return { name, symbol, params, returns: returns as FfiReturnClass };
    });

    const libraries = stringArray(root["libraries"], "libraries").map((path) =>
      resolve(dirname(profilePath), path)
    );
    const systemLibraries = stringArray(
      root["system_libraries"],
      "system_libraries",
    );
    for (const [i, name] of systemLibraries.entries()) {
      if (!SYSTEM_LIBRARY.test(name) || name.startsWith("-")) {
        throw new FfiProfileError(
          `'system_libraries[${i}]' is not a library name: '${name}'`,
        );
      }
    }
    if (new Set(libraries).size !== libraries.length) {
      throw new FfiProfileError("'libraries' contains a duplicate path");
    }
    for (const [i, path] of libraries.entries()) {
      try {
        if (!statSync(path).isFile()) {
          throw new FfiProfileError(
            `'libraries[${i}]' does not name a file: '${path}'`,
          );
        }
      } catch (err) {
        if (err instanceof FfiProfileError) throw err;
        throw new FfiProfileError(
          `'libraries[${i}]' cannot be read at '${path}': ${(err as Error).message}`,
        );
      }
    }
    if (new Set(systemLibraries).size !== systemLibraries.length) {
      throw new FfiProfileError("'system_libraries' contains a duplicate name");
    }
    return {
      ok: true,
      profile: {
        ffiFormat: 1,
        functions,
        libraries,
        systemLibraries,
      },
    };
  } catch (err) {
    if (err instanceof FfiProfileError) return fail(err.detail);
    throw err;
  }
}
