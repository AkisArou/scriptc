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
  IrFfiCallbackParam,
  IrFfiCallbackParamClass,
  IrFfiContextParam,
  IrFfiReturnClass,
  IrFfiReleaseParam,
  IrFfiImport,
  IrFfiValueParamClass,
  IrNativeBinding,
  IrNativeCallbackArgumentType,
  IrNativeCallbackContract,
  IrNativeCallbackSignature,
  IrNativeCallbackSourceArgument,
  IrNativeRegistrationRef,
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

/** Payload classes a call-scoped callback can carry, which is now every class
 * the profile has: the value classes, a NUL-terminated string, and the two
 * spans. */
const DESUGARABLE_PAYLOADS = new Set([
  "f64", "bool", "u8", "u32", "i32", "cstring", "string", "bytes",
]);

/** Answer classes. A C string is a payload only: answering one would need the
 * ownership and allocator contract the profile deliberately omits. */
const DESUGARABLE_ANSWERS = new Set(["f64", "bool", "u8", "u32", "i32"]);

/** The physical slots, the source payloads, and the map between them for one
 * callback ABI. Built in one pass because they are not parallel: a span class
 * is one thing the handler receives and two things the library passes.
 *
 * Shared by a registration and by the release that names it back — the same
 * ABI described twice would be two chances to describe it differently, and
 * the pointer pair the library matches on is only meaningful for one. */
function callbackShape(
  params: readonly (IrFfiCallbackParamClass | IrFfiContextParam)[],
  returns: IrFfiReturnClass,
): {
  readonly signature: IrNativeCallbackSignature;
  readonly source: IrNativeCallbackArgumentType;
  readonly sourceArguments: readonly IrNativeCallbackSourceArgument[];
} {
  const parameters: IrNativeCallbackSignature["parameters"][number][] = [];
  const sourceParams: IrNativeCallbackArgumentType["params"][number][] = [];
  const sourceArguments: IrNativeCallbackSourceArgument[] = [];
  for (const slot of params) {
    if (isFfiContextParam(slot)) {
      parameters.push({ kind: "nativeContext", addressSpace: 0 });
      continue;
    }
    if (slot === "string" || slot === "bytes") {
      const data = parameters.length;
      parameters.push({ kind: "nativePointer", pointee: "u8", const: true, addressSpace: 0 });
      const length = parameters.length;
      parameters.push({ kind: "nativeScalar", scalar: "usize" });
      sourceArguments.push({ kind: "callback-parameter-span", data, length });
      sourceParams.push({ kind: slot === "bytes" ? "byteSpan" : "utf8Span" });
      continue;
    }
    const parameter = parameters.length;
    /* The library hands over a pointer it still owns, which is what `const`
     * records — the trampoline reads through it and never writes or frees.
     * A C string's element is `char`, spelled `i8` because the profile states
     * no signedness and nothing reads the tag for a payload pointer: both
     * backends emit `const char *` and let the platform mean what it means. */
    parameters.push(
      slot === "cstring"
        ? { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 }
        : scalarOf(slot as "f64" | "bool" | "u8" | "u32" | "i32"),
    );
    sourceArguments.push({ kind: "callback-parameter", parameter });
    /* Each payload reaches the handler as the ordinary JavaScript value its
     * class names: a boolean for `bool`, a string for `cstring`, a number for
     * the rest. */
    sourceParams.push(
      slot === "bool"
        ? { kind: "bool", falseValue: "0", trueValue: "1" }
        : slot === "cstring"
          ? { kind: "cstring" }
          : { kind: "f64" },
    );
  }
  return {
    signature: {
      parameters,
      result: returns === "void" ? { kind: "void" } : scalarOf(returns),
    },
    source: {
      kind: "func",
      params: sourceParams,
      ret: returns === "void"
        ? { kind: "void" }
        : returns === "bool"
          ? { kind: "bool", falseValue: "0", trueValue: "1" }
          /* The profile's integer answers wrap, exactly as its arguments do. */
          : { kind: "f64", conversion: returns === "f64" ? "checked" : "wrap" },
    },
    sourceArguments,
  };
}

/** One of a binding's callbacks, with its context slot, or null when the
 * descriptor needs vocabulary the native path does not have yet. */
function desugarCallback(entry: IrFfiImport, callbackSlot: number): {
  readonly signature: IrNativeCallbackSignature;
  readonly contract: IrNativeCallbackContract;
  readonly source: IrNativeCallbackArgumentType;
  readonly callbackSlot: number;
  readonly contextSlot: number | null;
} | null {
  const param = entry.params[callbackSlot];
  if (param === undefined || !isFfiCallbackParam(param)) return null;
  const callback = param.callback;

  const payloads = callback.params.filter((slot) => !isFfiContextParam(slot));
  if (!payloads.every((cls) => DESUGARABLE_PAYLOADS.has(String(cls)))) return null;
  if (callback.returns !== "void" && !DESUGARABLE_ANSWERS.has(callback.returns)) return null;

  /* A callback with no userdata slot of its own takes no context argument
   * either: there is nothing for one to fill. Its closure is lent through the
   * adapter's thread-local instead, which is why the two counts have to agree
   * rather than each being checked on its own. */
  const takesContext = payloads.length !== callback.params.length;
  const contexts = entry.params.flatMap((candidate, index) =>
    isFfiContextParam(candidate) && candidate.context === callback.id ? [index] : [],
  );
  if (contexts.length !== (takesContext ? 1 : 0)) return null;

  const { signature, source, sourceArguments } =
    callbackShape(callback.params, callback.returns);
  /* A retained descriptor names no owner, because a C API that takes a
   * callback and hands back nothing has given the program nothing to hang the
   * registration on. It ends when a release names the same function value
   * back, or when the process does. */
  if (callback.lifetime === "retained" && callback.returns !== "void") return null;
  /* A foreign producer cannot deliver where it raises — reading a closure is
   * a script-thread operation — so the payload is copied there and the
   * invocation is queued for a later turn. */
  const contract: IrNativeCallbackContract = callback.lifetime === "retained"
    ? callback.invoke === "foreign"
      ? {
          owner: { kind: "process" },
          allowedInvocationExecutors: ["same-as-caller", "any-attached-thread"],
          synchronousReturn: false,
          sourceArguments,
        }
      : {
          owner: { kind: "process" },
          allowedInvocationExecutors: ["same-as-caller"],
          synchronousReturn: true,
          sourceArguments,
        }
    : {
        owner: { kind: "call" },
        allowedInvocationExecutors: ["same-as-caller"],
        synchronousReturn: true,
        sourceArguments,
      };
  return { signature, contract, source, callbackSlot, contextSlot: contexts[0] ?? null };
}

/**
 * The value-call subset: every parameter and the result cross as values,
 * strings and byte spans included. Returns null for anything carrying a
 * callback, context, or release entry — those keep the profile's own path
 * until the callback slices land, so this change can be verified against a
 * suite that still exercises both.
 */
export function desugarFfiValueBinding(
  entry: IrFfiImport,
  resolveRegistration: (key: string) => IrNativeRegistrationRef | null = () => null,
): IrNativeBinding | null {
  /* A release names a registration made elsewhere. It is describable only if
   * that registration is on this path too — a ledger half here and half in
   * the profile would pin in one and look in the other. */
  const releases = new Map<number, IrNativeRegistrationRef>();
  for (const [index, param] of entry.params.entries()) {
    if (!isFfiReleaseParam(param)) continue;
    const reference = resolveRegistration(param.callback.release);
    if (reference === null) return null;
    releases.set(index, reference);
  }
  /* A binding may carry more than one callback — two comparators, a pair of
   * hooks — and each is an independent registration with its own signature,
   * context slot, and trampoline. They are desugared one at a time and any
   * failure sinks the whole binding, because a descriptor half on the native
   * path is not a thing that can be emitted. */
  const callbacks: NonNullable<ReturnType<typeof desugarCallback>>[] = [];
  for (const [index, param] of entry.params.entries()) {
    if (!isFfiCallbackParam(param)) continue;
    const desugared = desugarCallback(entry, index);
    if (desugared === null) return null;
    callbacks.push(desugared);
  }
  const callbackBySlot = new Map(callbacks.map((one) => [one.callbackSlot, one]));
  const contextBySlot = new Map(
    callbacks.flatMap((one) => one.contextSlot === null ? [] : [[one.contextSlot, one]]),
  );
  /* A release passes the same context the registration did, which is the
   * function value itself, so its context slot belongs to the release
   * parameter beside it rather than to a callback of ours. */
  const releaseContextBySlot = new Map<number, number>();
  for (const [index, param] of entry.params.entries()) {
    if (!isFfiContextParam(param)) continue;
    const owner = [...releases.keys()].find((slot) =>
      (entry.params[slot] as IrFfiReleaseParam).callback.release === param.context
    );
    if (owner !== undefined) releaseContextBySlot.set(index, owner);
  }
  /* A context with no callback of ours to belong to is not ours to serve. */
  if (
    entry.params.filter(isFfiContextParam).length !==
      contextBySlot.size + releaseContextBySlot.size
  ) return null;
  const classes = entry.params as IrFfiValueParamClass[];

  const args: IrNativeBinding["arguments"] = [];
  const parameters: IrNativeBinding["parameters"] = [];
  /* A span's length is a `size_t`, which the scalar table already names at
   * the target's pointer width. */
  const usize: IrNativeScalarType = { kind: "nativeScalar", scalar: "usize" };

  /* TypeScript argument positions skip what the compiler supplies: the
   * function value is one argument, the context is none at all. */
  const argumentOf = (slot: number): number =>
    entry.params.slice(0, slot).filter((candidate) => !isFfiContextParam(candidate)).length;
  classes.forEach((cls, index) => {
    const releaseContextOwner = releaseContextBySlot.get(index);
    if (releaseContextOwner !== undefined) {
      parameters.push({
        name: `a${index}`,
        type: { kind: "nativeContext", addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: { kind: "callbackContext", argument: argumentOf(releaseContextOwner) },
      });
      return;
    }
    const releasedRegistration = releases.get(index);
    if (releasedRegistration !== undefined) {
      const released = entry.params[index] as IrFfiReleaseParam;
      /* The value is the registration's own function type — that is what
       * makes it findable — but it carries no contract: the contract was
       * stated where the registration was made. */
      const shape = callbackShape(released.callback.params, released.callback.returns);
      args.push({
        name: `a${index}`,
        type: shape.source,
      });
      parameters.push({
        name: `a${index}`,
        type: { kind: "nativeCallback", signature: shape.signature },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: {
          kind: "callbackRelease",
          argument: argumentOf(index),
          registration: releasedRegistration,
        },
      });
      return;
    }
    const contextOwner = contextBySlot.get(index);
    if (contextOwner !== undefined) {
      parameters.push({
        name: `a${index}`,
        type: { kind: "nativeContext", addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: {
          kind: "callbackContext",
          argument: argumentOf(contextOwner.callbackSlot),
        },
      });
      return;
    }
    const callback = callbackBySlot.get(index);
    if (callback !== undefined) {
      args.push({
        name: `a${index}`,
        type: callback.source,
        callback: callback.contract,
      });
      parameters.push({
        name: `a${index}`,
        type: { kind: "nativeCallback", signature: callback.signature },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: {
          kind: "callbackFunction",
          argument: argumentOf(callback.callbackSlot),
        },
      });
      return;
    }
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
    entry: { symbol: entry.symbol },
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

/**
 * Every profile entry this path can serve, desugared as a set rather than one
 * at a time.
 *
 * A registration and the releases that name it are one unit: the ledger a
 * registration pins into is the one a release looks in, and there is exactly
 * one of those per adapter. If either half stayed on the profile's path the
 * two halves would be pinning and searching different tables, so an entry is
 * kept only when everything it is joined to is kept — which is a fixpoint,
 * because dropping a registration drops its releases, and dropping a release
 * drops the registration it named along with THAT registration's other
 * releases.
 */
export function desugarFfiBindings(
  entries: readonly IrFfiImport[],
): Map<string, IrNativeBinding> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  /* `<binding>:<callback-id>`, the profile's own spelling. A binding name may
   * contain a colon and a callback id may not, so the last one splits it. */
  const resolve = (key: string): IrNativeRegistrationRef | null => {
    const split = key.lastIndexOf(":");
    const registering = byName.get(key.slice(0, split));
    const id = key.slice(split + 1);
    if (registering === undefined) return null;
    const slot = registering.params.findIndex(
      (param) => isFfiCallbackParam(param) && param.callback.id === id,
    );
    if (slot < 0) return null;
    return {
      binding: ffiBindingId(registering.name),
      argument: registering.params
        .slice(0, slot)
        .filter((param) => !isFfiContextParam(param)).length,
    };
  };
  const desugared = new Map<string, IrNativeBinding>();
  /* Which entries each entry is joined to, in both directions. */
  const joined = new Map<string, Set<string>>();
  const join = (left: string, right: string): void => {
    for (const [a, b] of [[left, right], [right, left]] as const) {
      const set = joined.get(a) ?? new Set<string>();
      set.add(b);
      joined.set(a, set);
    }
  };
  for (const entry of entries) {
    const binding = desugarFfiValueBinding(entry, resolve);
    if (binding === null) continue;
    desugared.set(entry.name, binding);
    for (const param of entry.params) {
      if (!isFfiReleaseParam(param)) continue;
      const key = param.callback.release;
      join(entry.name, key.slice(0, key.lastIndexOf(":")));
    }
  }
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const name of [...desugared.keys()]) {
      for (const partner of joined.get(name) ?? []) {
        if (desugared.has(partner)) continue;
        desugared.delete(name);
        dropped = true;
        break;
      }
    }
  }
  return desugared;
}
