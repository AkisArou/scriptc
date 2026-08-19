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
import {
  nativeIntegerInfo,
  nativeScalarWidensToNumber,
  provenNumberLiteral,
  STRING,
  typeEquals,
} from "../ir/nodes.js";

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

/**
 * The one thing an argument becomes on its way into a slot.
 *
 * The same shape as `NativeResultForm` and for the same reason: both backends
 * ran an eleven-case switch over the projection — in different orders, with
 * `number` and `boolean` swapped exactly as the result ladder had them — and
 * inside the numeric case both chose between the same six sub-cases in the
 * same sequence. Choosing is not emitting.
 *
 * An arm carries values rather than rendered text: a boolean arm carries the
 * two canonical representations and the scalar they inhabit, never a C literal
 * or an LLVM one, because how a value is spelled is the only part of this that
 * differs between the two.
 */
export type NativeArgumentForm =
  /** The compiler's own error slot: nothing in the program supplies it. */
  | { readonly kind: "errorSlot" }
  /** A source boolean selecting between the two declared representations. */
  | {
      readonly kind: "boolean";
      readonly argument: number;
      readonly scalar: IrNativeScalarType;
      readonly falseValue: string;
      readonly trueValue: string;
    }
  /** A double slot: the source value already IS the representation. */
  | { readonly kind: "numberIdentity"; readonly argument: number }
  /** A float slot, which rounds — the one crossing here that is not exact. */
  | { readonly kind: "numberToFloat"; readonly argument: number }
  /** The ECMAScript modulo conversion, which is total and cannot fail. */
  | {
      readonly kind: "numberWrapping";
      readonly argument: number;
      readonly scalar: IrNativeScalarType;
      readonly signed: boolean;
    }
  /** A literal the emitter re-proved in place: the constant IS the conversion,
   * so nothing is checked at runtime. */
  | {
      readonly kind: "numberProvenLiteral";
      readonly scalar: IrNativeScalarType;
      readonly value: string;
    }
  /** The number facts proved this whole and in range on every path here, so
   * the conversion is the cast alone. */
  | {
      readonly kind: "numberProvenCrossing";
      readonly argument: number;
      readonly scalar: IrNativeScalarType;
    }
  /** Neither proven: the checked helper, which throws catchably. */
  | {
      readonly kind: "numberChecked";
      readonly argument: number;
      readonly scalar: IrNativeScalarType;
    }
  /** A managed string borrowed as a NUL-terminated pointer. */
  | { readonly kind: "cString"; readonly argument: number }
  /** A nullable string argument whose value is statically the null arm. */
  | { readonly kind: "cStringNull" }
  /** A nullable string argument that is a union at runtime. */
  | {
      readonly kind: "cStringOrNull";
      readonly argument: number;
      readonly stringTag: number;
    }
  /** The two physical slots a span occupies, and the two a UTF-8 view does. */
  | {
      readonly kind: "utf8Data" | "utf8ByteLength" | "bytesData" | "bytesByteLength";
      readonly argument: number;
    }
  /** The trampoline this call registers. */
  | { readonly kind: "callbackFunction"; readonly argument: number }
  /** The REGISTERING binding's trampoline: the library matches a registration
   * on the pointer pair it was given, so a second one would identify nothing. */
  | {
      readonly kind: "callbackRelease";
      readonly registration: { readonly binding: string; readonly argument: number };
    }
  /** The closure slot, carrying a token when one was minted for it. */
  | { readonly kind: "callbackContext"; readonly argument: number }
  /** The callee takes the reference: the cell gives it up rather than holding
   * one nobody owns. */
  | {
      readonly kind: "handleSurrender";
      readonly argument: number;
      readonly typeId: string;
    }
  /** A nullable handle argument whose value is statically the null arm. */
  | { readonly kind: "handleNull" }
  /** A nullable handle argument that is a union at runtime. */
  | {
      readonly kind: "handleOrNull";
      readonly argument: number;
      readonly typeId: string;
      readonly handleTag: number;
    }
  /** A required handle, validated before the pointer crosses. */
  | {
      readonly kind: "handleRequire";
      readonly argument: number;
      readonly typeId: string;
    }
  /** An exact value that crosses as itself. */
  | { readonly kind: "direct"; readonly argument: number };

/* Both emitters end their switch by assigning the form to this, so an arm
 * added above and forgotten in one backend stops that backend compiling. It is
 * `never` rather than a listed remainder because an argument switch handles
 * every arm — unlike the result ladder, which legitimately falls through to a
 * direct crossing. */
export type NativeArgumentFormExhausted = never;

/** What resolving an argument needs to know beyond the binding itself. */
export interface NativeArgumentContext {
  /** The runtime type of each emitted argument value, by argument index. */
  readonly argumentType: (argument: number) => IrType;
  /** The source expression behind each argument, for the proven-literal case. */
  readonly sourceLiteral: (argument: number) => number | undefined;
  /** Argument positions the number facts proved whole and in range. */
  readonly provenCrossings: ReadonlySet<number> | undefined;
  readonly pointerBits: 32 | 64 | undefined;
  readonly tables: NativeCallTables;
}

export function nativeArgumentForm(
  binding: IrNativeBinding,
  parameterIndex: number,
  context: NativeArgumentContext,
): NativeArgumentForm {
  const fail = (detail: string): never => {
    throw new NativeCallPlanError(binding.id, detail);
  };
  const parameter = binding.parameters[parameterIndex] ??
    fail(`missing parameter ${parameterIndex}`);
  const projection = parameter.projection;
  if (projection.kind === "errorOut") return { kind: "errorSlot" };
  if (projection.kind === "callbackRelease") {
    return { kind: "callbackRelease", registration: projection.registration };
  }
  const argument = projection.argument;
  const valueType = context.argumentType(argument);

  switch (projection.kind) {
    case "boolean": {
      if (parameter.type.kind !== "nativeScalar" || valueType.kind !== "bool") {
        fail("invalid boolean parameter projection");
      }
      return {
        kind: "boolean",
        argument,
        scalar: parameter.type as IrNativeScalarType,
        falseValue: projection.falseValue,
        trueValue: projection.trueValue,
      };
    }
    case "number": {
      if (parameter.type.kind !== "nativeScalar" || valueType.kind !== "f64") {
        fail("invalid number parameter projection");
      }
      const scalar = parameter.type as IrNativeScalarType;
      if (scalar.scalar === "f64") return { kind: "numberIdentity", argument };
      if (scalar.scalar === "f32") return { kind: "numberToFloat", argument };
      if (projection.conversion === "wrap") {
        const info = nativeIntegerInfo(scalar.scalar, context.pointerBits);
        if (info === null) fail(`wrapping conversion over ${scalar.scalar}`);
        return {
          kind: "numberWrapping",
          argument,
          scalar,
          signed: (info as { readonly signed: boolean }).signed,
        };
      }
      const literal = context.sourceLiteral(argument);
      const proven = literal === undefined
        ? null
        : provenNumberLiteral(literal, scalar.scalar, context.pointerBits);
      if (proven !== null) return { kind: "numberProvenLiteral", scalar, value: proven };
      return context.provenCrossings?.has(parameterIndex) === true
        ? { kind: "numberProvenCrossing", argument, scalar }
        : { kind: "numberChecked", argument, scalar };
    }
    case "utf8CString": {
      const sourceType = binding.arguments[argument]?.type;
      if (sourceType?.kind !== "nullableString") return { kind: "cString", argument };
      if (valueType.kind === "nullT") return { kind: "cStringNull" };
      if (valueType.kind === "union") {
        const arms = context.tables.unionsById.get(valueType.unionId)?.arms;
        const stringTag = armTag(arms, (arm) => arm.kind === "string");
        const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
        if (stringTag < 0 || nullTag < 0) {
          fail("nullable C-string argument lacks string/null arms");
        }
        return { kind: "cStringOrNull", argument, stringTag };
      }
      if (valueType.kind !== "string") {
        fail(`nullable C-string argument has ${valueType.kind} type`);
      }
      return { kind: "cString", argument };
    }
    case "utf8Data":
    case "utf8ByteLength":
    case "bytesData":
    case "bytesByteLength":
      return { kind: projection.kind, argument };
    case "callbackFunction":
    case "callbackContext":
      return { kind: projection.kind, argument };
    case "argument": {
      if (parameter.type.kind !== "nativeHandle") return { kind: "direct", argument };
      const typeId = parameter.type.typeId;
      /* Ownership first, and it cannot collide with the nullable case below:
       * the validator requires an owned parameter's source argument to be a
       * REQUIRED handle, since a null arm would leave nothing to hand over.
       * The two backends happened to test these in opposite orders, which was
       * equivalent only because of that rule and said so nowhere. */
      if (parameter.ownership.kind === "owned") {
        return { kind: "handleSurrender", argument, typeId };
      }
      if (binding.arguments[argument]?.type.kind === "nullableNativeHandle") {
        if (valueType.kind === "nullT") return { kind: "handleNull" };
        if (valueType.kind === "union") {
          const arms = context.tables.unionsById.get(valueType.unionId)?.arms;
          const handleTag = armTag(arms, (arm) => arm.kind === "nativeHandle");
          if (handleTag < 0) fail("nullable handle argument lacks a handle arm");
          return { kind: "handleOrNull", argument, typeId, handleTag };
        }
      }
      return { kind: "handleRequire", argument, typeId };
    }
  }
}

/**
 * How this call reports failure at the point the check has to happen, resolved
 * and checked.
 *
 * The result forms above cover the two detections that ARE the result — an
 * error object returned, a NULL that means failure — because for those the
 * check and the projection are one act. What is left is the two that happen
 * beside the result: a slot the compiler owns, read after the call, and a
 * sentinel value compared against the result once it is bound.
 *
 * Splitting it this way is not a taxonomy: it follows where the emitters have
 * to put the code. A slot is read before the result is projected, because a
 * failed call has no result to project; a sentinel is compared after, because
 * the value being compared IS the result.
 */
export type NativeFailureForm =
  /** Nothing to check here — either the call cannot fail, or its failure is
   * the result itself and the result form carries it. */
  | { readonly kind: "none" }
  /** A compiler-owned slot, non-null after the call. Read before the result is
   * projected, so every projection may assume it looks at a success. */
  | {
      readonly kind: "errorSlot";
      readonly message: string;
      readonly release: string;
    }
  /** A sentinel result with the failure detail in `errno`. */
  | {
      readonly kind: "sentinel";
      readonly scalar: IrNativeScalarType;
      readonly value: string;
    };

export function nativeFailureForm(binding: IrNativeBinding): NativeFailureForm {
  const fail = (detail: string): never => {
    throw new NativeCallPlanError(binding.id, detail);
  };
  const detect = binding.error.detect;

  if (detect.kind === "outParameterIsNotNull") {
    if (binding.error.message.kind !== "symbol" || binding.error.release.kind !== "symbol") {
      fail("error slot without an error object");
    }
    const message = binding.error.message as { readonly symbol: string };
    const release = binding.error.release as { readonly symbol: string };
    return { kind: "errorSlot", message: message.symbol, release: release.symbol };
  }

  if (detect.kind === "resultEquals") {
    if (binding.result.type.kind !== "nativeScalar" || binding.result.type.scalar === "f64") {
      fail("sentinel failure over a non-integer result");
    }
    /* The only lowered message for a sentinel result is errno. A bare
     * sentinel — failure with nothing to say — is admissible in the shape and
     * has no emission yet; the validator refuses it, so reaching here means
     * the two disagree. */
    if (binding.error.message.kind !== "errno") fail("unlowered sentinel message");
    return {
      kind: "sentinel",
      scalar: binding.result.type as IrNativeScalarType,
      value: detect.value,
    };
  }

  return { kind: "none" };
}
