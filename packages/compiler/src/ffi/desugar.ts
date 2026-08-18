/* One outbound native-call machinery, two input dialects.
 *
 * An FFI profile and an embedder's Native IR describe the same thing — a
 * TypeScript declaration bound to a C symbol with an exact ABI — in two
 * vocabularies. This module translates the first into the second so the
 * compiler carries one lowering, one trampoline family, and one arm per
 * backend instead of two of each.
 *
 * The direction is deliberate. Native IR is the wider vocabulary: it already
 * spells exact widths, aggregates, handles, and failure contracts that the
 * profile's classes cannot. Desugaring into it loses nothing, while the
 * reverse would lose almost everything.
 *
 * Formats 1 through 5 keep their exact meaning, which is the whole
 * correctness argument: upstream's suite is the oracle, and it must pass
 * unchanged. Where the two vocabularies disagreed about a default — the
 * profile's integer ingress wraps where Native IR checked — the conversion
 * became a named projection rather than one side's habit winning.
 */
import type {
  IrFfiImport,
  IrFfiValueParamClass,
  IrNativeBinding,
  IrNativeScalarType,
} from "../ir/nodes.js";
import { isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam } from "../ir/nodes.js";

/** The exact scalar a profile class occupies. The profile names a C type by
 * class rather than by width, so these are fixed rather than probed. */
function scalarOf(cls: "f64" | "bool" | "u8" | "u32" | "i32"): IrNativeScalarType {
  switch (cls) {
    case "f64":
      return { kind: "nativeScalar", scalar: "f64" };
    // A C `bool` parameter is documented as 0 or 1 and a return as any
    // nonzero; both occupy one byte.
    case "bool":
    case "u8":
      return { kind: "nativeScalar", scalar: "u8" };
    case "u32":
      return { kind: "nativeScalar", scalar: "u32" };
    case "i32":
      return { kind: "nativeScalar", scalar: "i32" };
  }
}

/** Binding ids are opaque and must not collide with an embedder's. A profile
 * binds one TypeScript name to one symbol, so the name is already unique
 * within the profile; the prefix keeps the two namespaces apart. */
export function ffiBindingId(name: string): string {
  return `ffi:${name}`;
}

/** A module identity no embedder can supply: an FFI profile names a
 * declaration in the program's own source, which has no package. */
const FFI_DECLARATION_MODULE = "\u0000ffi";

/**
 * The value-call subset: every parameter and the result cross as values,
 * strings and byte spans included. Returns null for anything carrying a
 * callback, context, or release entry — those keep the profile's own path
 * until the callback slices land, so this change can be verified against a
 * suite that still exercises both.
 */
export function desugarFfiValueBinding(entry: IrFfiImport): IrNativeBinding | null {
  if (
    entry.params.some(
      (param) =>
        isFfiCallbackParam(param) || isFfiContextParam(param) || isFfiReleaseParam(param),
    )
  ) {
    return null;
  }
  const classes = entry.params as IrFfiValueParamClass[];

  const args: IrNativeBinding["arguments"] = [];
  const parameters: IrNativeBinding["parameters"] = [];
  /* A span's length is a `size_t`, which the scalar table already names at
   * the target's pointer width. */
  const usize: IrNativeScalarType = { kind: "nativeScalar", scalar: "usize" };

  classes.forEach((cls, index) => {
    const name = `a${index}`;
    switch (cls) {
      case "string":
      case "bytes": {
        /* A span crosses as two slots the source never sees separately: the
         * data pointer and its length. Borrowed for the call — native code
         * may read it and must not retain it. */
        args.push({
          name,
          type: cls === "string" ? { kind: "string" } : { kind: "bytes", elem: "u8" },
        });
        parameters.push({
          name: `${name}_data`,
          type: { kind: "nativePointer", pointee: "u8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: cls === "string"
            ? { kind: "utf8Data", argument: index }
            : { kind: "bytesData", argument: index },
        });
        parameters.push({
          name: `${name}_len`,
          type: usize,
          passMode: "value",
          ownership: { kind: "value" },
          projection: cls === "string"
            ? { kind: "utf8ByteLength", argument: index }
            : { kind: "bytesByteLength", argument: index },
        });
        return;
      }
      case "bool": {
        args.push({ name, type: { kind: "bool" } });
        parameters.push({
          name,
          type: scalarOf("bool"),
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "boolean", argument: index, falseValue: "0", trueValue: "1" },
        });
        return;
      }
      default: {
        /* Every numeric class crosses as an ordinary number. `f64` converts
         * nothing; the integer classes wrap, which is what the profile has
         * always done and now says. */
        args.push({ name, type: { kind: "f64" } });
        parameters.push({
          name,
          type: scalarOf(cls),
          passMode: "value",
          ownership: { kind: "value" },
          projection: {
            kind: "number",
            argument: index,
            conversion: cls === "f64" ? "checked" : "wrap",
          },
        });
      }
    }
  });

  const result: IrNativeBinding["result"] = entry.returns === "void"
    ? {
        type: { kind: "void" },
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "direct" },
      }
    : entry.returns === "bool"
      ? {
          type: scalarOf("bool"),
          passMode: "value",
          ownership: { kind: "value" },
          // Any nonzero return is true, which is C's own truth test and what
          // the profile documents.
          projection: { kind: "boolean", conversion: "nonZero" },
        }
      : {
          type: scalarOf(entry.returns),
          passMode: "value",
          ownership: { kind: "value" },
          /* The source sees an ordinary number, so the result carries the
           * number projection rather than the direct one — `direct` would
           * hand back the branded exact scalar a profile never declares.
           * Every class here is a double or an integer of at most 32 bits,
           * so the widening is exact and cannot fail. */
          projection: { kind: "number" },
        };

  return {
    id: ffiBindingId(entry.name),
    /* The frontend has already proved this call reaches the profile's
     * ambient declaration, so the identity here only has to be stable and
     * unable to collide with an embedder's module. */
    declaration: { module: FFI_DECLARATION_MODULE, name: entry.name },
    sourceAccess: "call",
    entry: { kind: "c-symbol", symbol: entry.symbol },
    // A profile states no failure convention: native code returns normally.
    error: {
      detect: { kind: "never" },
      message: { kind: "none" },
      release: { kind: "none" },
    },
    arguments: args,
    parameters,
    result,
  };
}
