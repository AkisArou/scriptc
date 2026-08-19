/* Boundary legalization: what a foreign call becomes, decided once.
 *
 * Both backends lower a `nativeCall`, and until this module they decided the
 * same things twice on the way. `native-callbacks.ts` already shares the
 * callback decisions — which payload, which trampoline, what happens around
 * the call. This shares the rest, and the two files together are what the
 * legalizer [the foreign boundary](../../../../docs/foreign-boundary.md)
 * describes grows out of.
 *
 * The measurement that motivated it: inside ONE `nativeCall` lowering, the C
 * emitter raises 24 `emitter bug` contract checks and the LLVM emitter 28, and
 * about twenty-two are the same check. Three had already drifted in wording —
 * "error channel without an error OBJECT" against "…without an error HANDLE",
 * "SENTINEL failure over non-integer result" against "ERRNO over…" — so a
 * reader grepping for one finds one backend. The seven-arm result ladder also
 * ran in different orders on the two sides, which is harmless while the arms
 * are mutually exclusive and is exactly the drift that shape invites.
 *
 * The rule this module follows, and the reason it can exist at all: RESOLVING
 * and VALIDATING a contract is not emission. Which union arm carries the
 * handle, which symbol releases it, whether the declared boolean values fit
 * their storage — all of that is a question about the IR, with one answer,
 * that neither backend should be asking on its own.
 */
import type {
  IrModule,
  IrNativeBinding,
  IrNativeHandleDef,
  IrNativeScalarType,
  IrType,
  IrUnionDef,
} from "../ir/nodes.js";
import { nativeScalarWidensToNumber, STRING, typeEquals } from "../ir/nodes.js";

/** What the emitters need to look up while resolving a contract. Passed in
 * rather than imported so this module stays independent of how either backend
 * stores its tables. */
export interface NativeCallTables {
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
  readonly nativeTypesById: ReadonlyMap<string, NonNullable<IrModule["nativeTypes"]>[number]>;
  readonly nativeById: ReadonlyMap<string, IrNativeBinding>;
}

/**
 * The one thing a call's result becomes, resolved and checked.
 *
 * Every arm carries what an emitter needs and nothing it would have to look up
 * again: a handle arm names its definition and the destructor SYMBOL rather
 * than the destructor's binding id, and a union arm names the runtime tags
 * rather than the union. An emitter that receives one of these has no question
 * left to ask about the contract, only about its own instruction set.
 */
export type NativeResultForm =
  /** No value, and nothing to project. */
  | { readonly kind: "void" }
  /** The result IS the error object; nothing reaches the program. */
  | {
      readonly kind: "errorChannel";
      readonly message: string;
      readonly release: string;
    }
  /** A borrowed C string copied into a managed `string`. */
  | { readonly kind: "utf8CString" }
  /** The same, where the callee may answer with NULL and absence is a value. */
  | {
      readonly kind: "utf8CStringOrNull";
      readonly unionId: string;
      readonly stringTag: number;
      readonly nullTag: number;
    }
  /** C's own truth test over an integer slot: nonzero is true, nothing fails. */
  | { readonly kind: "booleanNonZero"; readonly scalar: IrNativeScalarType }
  /** Exactly the two declared representations; anything else throws. */
  | {
      readonly kind: "booleanExact";
      readonly scalar: IrNativeScalarType;
      readonly falseValue: string;
      readonly trueValue: string;
    }
  /** Widening that cannot fail, because every value of the slot is a double. */
  | { readonly kind: "numberWidened"; readonly scalar: IrNativeScalarType }
  /** Widening that can, because the slot has values no double denotes. */
  | { readonly kind: "numberChecked"; readonly scalar: IrNativeScalarType }
  /** An owned handle the callee may report as absent. */
  | {
      readonly kind: "handleOrNull";
      readonly unionId: string;
      readonly definition: IrNativeHandleDef;
      readonly destructor: string;
      readonly handleTag: number;
      readonly nullTag: number;
    }
  /** An owned handle the callee always produces. */
  | {
      readonly kind: "handle";
      readonly definition: IrNativeHandleDef;
      readonly destructor: string;
    }
  /** An exact scalar or aggregate that crosses as itself. */
  | { readonly kind: "direct" };

/** A contract that cannot be lowered is a validator failure that reached
 * emission, so it is a bug in this compiler rather than in the program. One
 * exception type keeps the wording in one place, which is what the drift this
 * module deletes came from. */
export class NativeCallPlanError extends Error {
  constructor(bindingId: string, detail: string) {
    super(`emitter bug: ${detail} in ${bindingId}`);
    this.name = "NativeCallPlanError";
  }
}

function armTag(
  arms: readonly IrType[] | undefined,
  matches: (arm: IrType) => boolean,
): number {
  return arms?.findIndex(matches) ?? -1;
}

/**
 * Resolve what this call's result becomes.
 *
 * `sourceType` is the type the call site expects — the frontend already agreed
 * it with the projection, and the checks here are what catch a validator that
 * let them disagree.
 */
export function nativeResultForm(
  binding: IrNativeBinding,
  sourceType: IrType,
  tables: NativeCallTables,
): NativeResultForm {
  const fail = (detail: string): never => {
    throw new NativeCallPlanError(binding.id, detail);
  };
  const projection = binding.result.projection;

  /* Void first, and on the TYPE rather than the projection, because a void
   * result has no projection to speak of. */
  if (binding.result.type.kind === "void") return { kind: "void" };

  if (projection.kind === "errorChannel") {
    if (
      binding.error.detect.kind !== "resultIsNotNull" ||
      binding.error.message.kind !== "symbol" ||
      binding.error.release.kind !== "symbol"
    ) {
      fail("error channel without an error object");
    }
    /* Narrowed by the check above; TypeScript cannot see through `fail`. */
    const message = binding.error.message as { readonly symbol: string };
    const release = binding.error.release as { readonly symbol: string };
    return { kind: "errorChannel", message: message.symbol, release: release.symbol };
  }

  if (projection.kind === "utf8CString") {
    if (!projection.nullable) {
      if (sourceType.kind !== "string") fail("non-null C-string result is not a string");
      return { kind: "utf8CString" };
    }
    if (sourceType.kind !== "union") fail("nullable C-string result is not a union");
    const unionId = (sourceType as { readonly unionId: string }).unionId;
    const arms = tables.unionsById.get(unionId)?.arms;
    const stringTag = armTag(arms, (arm) => typeEquals(arm, STRING));
    const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
    if (stringTag < 0 || nullTag < 0) {
      fail("nullable C-string result lacks string/null arms");
    }
    return { kind: "utf8CStringOrNull", unionId, stringTag, nullTag };
  }

  if (projection.kind === "boolean") {
    if (binding.result.type.kind !== "nativeScalar" || sourceType.kind !== "bool") {
      fail("invalid boolean result projection");
    }
    const scalar = binding.result.type as IrNativeScalarType;
    return projection.conversion === "nonZero"
      ? { kind: "booleanNonZero", scalar }
      : {
          kind: "booleanExact",
          scalar,
          falseValue: projection.falseValue,
          trueValue: projection.trueValue,
        };
  }

  if (projection.kind === "number") {
    if (binding.result.type.kind !== "nativeScalar" || sourceType.kind !== "f64") {
      fail("invalid number result projection");
    }
    const scalar = binding.result.type as IrNativeScalarType;
    /* Which of the two it is is a fact about the WIDTH: every value of an
     * at-most-32-bit slot is a double and the cast is the whole conversion,
     * while wider slots have values no double denotes and go through the
     * checked helper, which can throw where the round trip does not hold. */
    return nativeScalarWidensToNumber(scalar.scalar)
      ? { kind: "numberWidened", scalar }
      : { kind: "numberChecked", scalar };
  }

  if (projection.kind === "nullableHandle") {
    if (binding.result.type.kind !== "nativeHandle" || sourceType.kind !== "union") {
      fail("nullable handle result is not a union");
    }
    const handle = resolveHandle(binding, tables, fail);
    const unionId = (sourceType as { readonly unionId: string }).unionId;
    const arms = tables.unionsById.get(unionId)?.arms;
    const handleTag = armTag(
      arms,
      (arm) => arm.kind === "nativeHandle" && arm.typeId === handle.definition.id,
    );
    const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
    if (handleTag < 0 || nullTag < 0) {
      fail("nullable handle result lacks handle/null arms");
    }
    return { kind: "handleOrNull", unionId, ...handle, handleTag, nullTag };
  }

  if (binding.result.type.kind === "nativeHandle") {
    if (binding.result.ownership.kind !== "owned") {
      fail("native handle result without ownership");
    }
    return { kind: "handle", ...resolveHandle(binding, tables, fail) };
  }

  return { kind: "direct" };
}

/** The handle definition and the symbol that releases one. Shared by the two
 * handle arms because "which object, and what ends this program's claim on it"
 * is one question however the absence case is spelled. */
function resolveHandle(
  binding: IrNativeBinding,
  tables: NativeCallTables,
  fail: (detail: string) => never,
): { readonly definition: IrNativeHandleDef; readonly destructor: string } {
  const typeId = binding.result.type.kind === "nativeHandle"
    ? binding.result.type.typeId
    : fail("native handle result without a handle type");
  const definition = tables.nativeTypesById.get(typeId);
  const destructor = binding.result.ownership.kind === "owned" &&
      binding.result.ownership.transfer === "to-runtime"
    ? tables.nativeById.get(binding.result.ownership.destructor)
    : undefined;
  if (definition?.kind !== "handle" || destructor === undefined) {
    fail("incomplete native handle metadata");
  }
  return {
    definition: definition as IrNativeHandleDef,
    destructor: (destructor as IrNativeBinding).entry.symbol,
  };
}
