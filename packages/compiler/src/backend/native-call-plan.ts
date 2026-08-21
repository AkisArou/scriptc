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
  IrNativeSpanElem,
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
  /** A C string copied into a managed `string`. `release` is what the pointer
   * needs afterwards, or null when it needs nothing — the same field a vector
   * result carries, because it is the same question. */
  | { readonly kind: "utf8CString"; readonly release: string | null }
  /** A NUL-terminated vector of C strings copied into a managed `string[]`.
   * `release` is what the vector needs afterwards, or null when it needs
   * nothing — one field, because whether the elements are the caller's too is
   * expressed by WHICH symbol frees the vector and not by this compiler. */
  | { readonly kind: "utf8CStringArray"; readonly release: string | null }
  /** A byte span the callee produced, copied into a managed `Uint8Array`.
   * The length arrives in the compiler's own slot, whose parameter index is
   * carried here so the projection can read it back. */
  | {
      readonly kind: "bytesResult";
      readonly elem: IrNativeSpanElem;
      readonly release: string | null;
      readonly lengthParameter: number;
    }
  /** UTF-8 text the callee produced, copied into a managed string.
   *
   * The byte-span result with a decode on the end, and the same length slot.
   * What it buys is the case a NUL-terminated string cannot express at all:
   * text containing U+0000. A terminator makes the first NUL the end of the
   * value, so a producer holding such a string can only refuse — which is
   * what the JVM boundary does today, by name, for a Java string that
   * contains one. */
  | {
      readonly kind: "utf8SpanResult";
      readonly release: string | null;
      readonly lengthParameter: number;
    }
  /** The same, where the callee may answer with NULL and absence is a value. */
  | {
      readonly kind: "utf8SpanResultOrNull";
      readonly release: string | null;
      readonly lengthParameter: number;
      readonly unionId: string;
      readonly stringTag: number;
      readonly nullTag: number;
    }
  /** The same, where the callee may answer with NULL and absence is a value. */
  | {
      readonly kind: "utf8CStringArrayOrNull";
      readonly release: string | null;
      readonly unionId: string;
      readonly arrayTag: number;
      readonly nullTag: number;
    }
  /** The same, where the callee may answer with NULL and absence is a value. */
  | {
      readonly kind: "utf8CStringOrNull";
      readonly release: string | null;
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
    const release = projection.release.kind === "symbol" ? projection.release.symbol : null;
    if (!projection.nullable) {
      if (sourceType.kind !== "string") fail("non-null C-string result is not a string");
      return { kind: "utf8CString", release };
    }
    if (sourceType.kind !== "union") fail("nullable C-string result is not a union");
    const unionId = (sourceType as { readonly unionId: string }).unionId;
    const arms = tables.unionsById.get(unionId)?.arms;
    const stringTag = armTag(arms, (arm) => typeEquals(arm, STRING));
    const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
    if (stringTag < 0 || nullTag < 0) {
      fail("nullable C-string result lacks string/null arms");
    }
    return { kind: "utf8CStringOrNull", release, unionId, stringTag, nullTag };
  }

  if (projection.kind === "bytes") {
    const release = projection.release.kind === "symbol" ? projection.release.symbol : null;
    if (!(sourceType.kind === "bytes" && sourceType.elem === projection.elem)) {
      fail("span result does not match the typed array its element names");
    }
    /* The one slot the compiler owns for this call besides the error slot.
     * Its index is what the projection reads back, so it is resolved here
     * rather than searched for at emission. */
    const lengthParameter = binding.parameters.findIndex(
      (parameter) => parameter.projection.kind === "bytesLengthOut",
    );
    if (lengthParameter < 0) fail("byte-span result without a length slot");
    return { kind: "bytesResult", elem: projection.elem, release, lengthParameter };
  }

  if (projection.kind === "utf8Span") {
    const release = projection.release.kind === "symbol" ? projection.release.symbol : null;
    /* The same slot the byte-span result reads, and for the same reason: a
     * length that arrives beside the pointer is the only way text containing
     * NUL can cross at all. */
    const lengthParameter = binding.parameters.findIndex(
      (parameter) => parameter.projection.kind === "bytesLengthOut",
    );
    if (lengthParameter < 0) fail("UTF-8 span result without a length slot");
    if (!projection.nullable) {
      if (!typeEquals(sourceType, STRING)) {
        fail("UTF-8 span result does not project as a string");
      }
      return { kind: "utf8SpanResult", release, lengthParameter };
    }
    if (sourceType.kind !== "union") fail("nullable UTF-8 span result is not a union");
    const unionId = (sourceType as { readonly unionId: string }).unionId;
    const arms = tables.unionsById.get(unionId)?.arms;
    const stringTag = armTag(arms, (arm) => typeEquals(arm, STRING));
    const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
    if (stringTag < 0 || nullTag < 0) {
      fail("nullable UTF-8 span result lacks string/null arms");
    }
    return {
      kind: "utf8SpanResultOrNull",
      release,
      lengthParameter,
      unionId,
      stringTag,
      nullTag,
    };
  }

  if (projection.kind === "utf8CStringArray") {
    /* A symbol rather than a binding, unlike a handle's destructor: the
     * vector is consumed inside this projection and never becomes a program
     * value, so there is nothing for a callable to take. */
    const release = projection.release.kind === "symbol" ? projection.release.symbol : null;
    if (!projection.nullable) {
      if (sourceType.kind !== "array" || sourceType.elem.kind !== "string") {
        fail("non-null C-string-array result is not a string array");
      }
      return { kind: "utf8CStringArray", release };
    }
    if (sourceType.kind !== "union") fail("nullable C-string-array result is not a union");
    const unionId = (sourceType as { readonly unionId: string }).unionId;
    const arms = tables.unionsById.get(unionId)?.arms;
    const arrayTag = armTag(
      arms,
      (arm) => arm.kind === "array" && arm.elem.kind === "string",
    );
    const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
    if (arrayTag < 0 || nullTag < 0) {
      fail("nullable C-string-array result lacks array/null arms");
    }
    return { kind: "utf8CStringArrayOrNull", release, unionId, arrayTag, nullTag };
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
  /** The compiler's own length slot for a returned byte span, for the same
   * reason and read the same way. */
  | { readonly kind: "bytesLengthSlot" }
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
  /** A managed string array borrowed as a NUL-terminated vector of them. The
   * only argument family that leaves something to clean up: the vector is
   * built before the call and released after it, whatever the call did. */
  | { readonly kind: "cStringArray"; readonly argument: number }
  /** A nullable vector argument whose value is statically the null arm. */
  | { readonly kind: "cStringArrayNull" }
  /** A nullable vector argument that is a union at runtime. */
  | {
      readonly kind: "cStringArrayOrNull";
      readonly argument: number;
      readonly arrayTag: number;
    }
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
      readonly kind: "utf8Data" | "utf8ByteLength" | "bytesData";
      readonly argument: number;
    }
  /** A span argument's length, and what it counts. */
  | {
      readonly kind: "bytesLength";
      readonly units: "elements" | "bytes";
      readonly elem: IrNativeSpanElem;
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
  /* The compiler's other own slot. Like the error slot it projects no
   * argument, so it is answered before anything reads one. */
  if (projection.kind === "bytesLengthOut") return { kind: "bytesLengthSlot" };
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
    case "utf8CStringArray": {
      const sourceType = binding.arguments[argument]?.type;
      if (sourceType?.kind !== "nullableStringArray") {
        return { kind: "cStringArray", argument };
      }
      /* Statically absent: the call site narrowed to null, so there is no
       * vector to build and NULL is the whole conversion. */
      if (valueType.kind === "nullT") return { kind: "cStringArrayNull" };
      if (valueType.kind === "union") {
        const arms = context.tables.unionsById.get(valueType.unionId)?.arms;
        const arrayTag = armTag(
          arms,
          (arm) => arm.kind === "array" && arm.elem.kind === "string",
        );
        const nullTag = armTag(arms, (arm) => arm.kind === "nullT");
        if (arrayTag < 0 || nullTag < 0) {
          fail("nullable C-string-array argument lacks array/null arms");
        }
        return { kind: "cStringArrayOrNull", argument, arrayTag };
      }
      /* Statically present: narrowed to the array arm, so it borrows like a
       * required vector. */
      if (!(valueType.kind === "array" && valueType.elem.kind === "string")) {
        fail(`nullable C-string-array argument has ${valueType.kind} type`);
      }
      return { kind: "cStringArray", argument };
    }
    case "bytesLength":
      /* The units and the element travel with the form, so neither backend
       * decides how many bytes an element is. */
      return {
        kind: "bytesLength",
        argument,
        units: projection.units,
        elem: valueType.kind === "bytes" ? valueType.elem : "u8",
      };
    case "utf8Data":
    case "utf8ByteLength":
    case "bytesData":
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

/**
 * The one shape a native call takes that is not a call at all.
 *
 * A binding a handle type names as its destructor is reached two ways: the
 * runtime calls it during teardown, holding the symbol as data, and a program
 * calls it directly as `dispose()`. The second is not an ordinary call — it
 * must run the cell's whole teardown, not just the symbol — so the emitters
 * branch to a disposal before building any arguments.
 *
 * Every other binding that merely CONSUMES an owned handle is an ordinary call
 * that happens to take one, and is emitted as one. Being a destructor is what
 * makes the difference, which is why `isDestructor` is the caller's answer:
 * only the module knows which types named which bindings.
 */
export function nativeCallDisposal(
  binding: IrNativeBinding,
  isDestructor: boolean,
): { readonly argument: number; readonly typeId: string } | null {
  if (!isDestructor) return null;
  const index = binding.parameters.findIndex(
    (parameter) => parameter.ownership.kind === "owned",
  );
  if (index < 0) return null;
  const parameter = binding.parameters[index]!;
  if (parameter.type.kind !== "nativeHandle" || parameter.projection.kind !== "argument") {
    throw new NativeCallPlanError(binding.id, "owned non-handle parameter");
  }
  return { argument: parameter.projection.argument, typeId: parameter.type.typeId };
}

/**
 * Whether a native call is a THROW CHECKPOINT: a point where an exception
 * raised on the far side of the boundary may already be pending when the call
 * returns, so the result must not be projected nor the arguments released
 * before that is checked.
 *
 * Any callback argument makes it one. Not because every native API invokes its
 * callback during the registering call — most retain it and call back later —
 * but because nothing in the contract says one cannot, and the two mistakes
 * are not symmetric. An unnecessary check costs a comparison. A missing one
 * projects a result and releases arguments with an exception already pending,
 * which is the failure the checkpoint exists to prevent.
 *
 * Owner SCOPE is deliberately not consulted, and this is the reason the
 * decision lives here at all. Scope answers when a registration ends, which is
 * a different question from whether this call can re-enter managed code.
 * Reading it narrowed the predicate in the LLVM backend and not the C one, so
 * for every binding carrying an owner-scoped retained callback — a signal
 * connected to a handle, the most ordinary shape there is — the two backends
 * disagreed about where the unwind belongs. Both spelled the predicate
 * themselves, three lines above a comment promising they shared it.
 */
export function nativeCallIsThrowCheckpoint(
  binding: IrNativeBinding,
  moduleHasRetainedRegistration: boolean,
): boolean {
  /* A retained profile callback defers its throw until a later native call
   * checks; that call is a checkpoint whichever path serves it. */
  return moduleHasRetainedRegistration ||
    binding.arguments.some((argument) => argument.type.kind === "func");
}

/**
 * How a projection that COPIES gets its managed value.
 *
 * The copy call differs per family and the differences are real: a byte span
 * needs its element kind and the compiler's length slot, UTF-8 text needs the
 * length in BYTES rather than elements, and the two C-string forms need
 * neither. Naming them as arms keeps that honest while letting everything
 * around the call be decided once.
 */
export type NativeResultAdopt =
  | {
      readonly kind: "bytes";
      readonly elem: IrNativeSpanElem;
      readonly lengthParameter: number;
    }
  | { readonly kind: "cstring" }
  | { readonly kind: "cstringVector" }
  | { readonly kind: "utf8Span"; readonly lengthParameter: number };

/**
 * The projections that copy foreign storage into managed storage, described
 * once rather than laddered twice.
 *
 * Eight of the result arms are this shape — four families, each with and
 * without an absence arm — and both backends wrote all eight out. The order
 * they share is the whole contract: COPY FIRST, THEN FREE, so nothing the
 * program keeps points into storage the release is about to reclaim. Getting
 * that backwards is a use-after-free that the C backend and the LLVM backend
 * would have to get wrong independently to be caught.
 *
 * What varies is smaller than the ladders suggested, and one of the variations
 * is easy to miss. `requireNonNull` says WHERE the contract's non-null
 * requirement is discharged, not merely whether there is one:
 *
 *   - `"raw"` checks the foreign pointer BEFORE the copy, because the copy
 *     would otherwise read a length slot that describes nothing.
 *   - `"managed"` checks the copied value AFTER the release, because the copy
 *     call answers null for a null input and the foreign pointer still has to
 *     be freed on the way out.
 *
 * A description that assumed one position would silently produce the other
 * family's semantics. That is the kind of difference a decision layer exists
 * to state rather than to leave in two ladders that happen to agree.
 */
export interface NativeResultCopy {
  readonly adopt: NativeResultAdopt;
  readonly requireNonNull: "raw" | "managed" | null;
  /** Whether the copy call must be skipped for a null pointer rather than
   * handed one. The C-string forms answer null for null; the UTF-8 decoder
   * would trap, and its projection is the one that admits absence. */
  readonly adoptSkipsNull: boolean;
  /** What the foreign pointer needs once the copy is made, or null when the
   * callee keeps the storage. Always guarded on non-null. */
  readonly release: string | null;
  /** The union arms when absence is a value, or null when it is not. */
  readonly absent: {
    readonly unionId: string;
    readonly presentTag: number;
    readonly nullTag: number;
  } | null;
}

/**
 * The result forms that copy, as a type.
 *
 * Naming the subset is what keeps the description from costing the
 * exhaustiveness this project relies on. A data-driven driver that asked
 * "is this a copy?" and got back a description-or-null would leave the
 * backend unable to narrow, and its residual guard — the line that makes a new
 * result arm a build failure — would stop compiling. Narrowing to this type at
 * the call site instead keeps both: a form the driver claims and does not
 * handle fails here, and a form nobody claims falls through to the guard.
 */
export type NativeResultCopyForm = Extract<
  NativeResultForm,
  {
    kind:
      | "bytesResult"
      | "utf8SpanResult"
      | "utf8SpanResultOrNull"
      | "utf8CString"
      | "utf8CStringOrNull"
      | "utf8CStringArray"
      | "utf8CStringArrayOrNull";
  }
>;

/** The copy description for a form already narrowed to the copying families. */
export function nativeResultCopy(form: NativeResultCopyForm): NativeResultCopy {
  switch (form.kind) {
    case "bytesResult":
      return {
        adopt: { kind: "bytes", elem: form.elem, lengthParameter: form.lengthParameter },
        /* Before the copy: the length slot describes this pointer, and reading
         * it for a null one describes nothing. */
        requireNonNull: "raw",
        adoptSkipsNull: false,
        release: form.release,
        absent: null,
      };
    case "utf8SpanResult":
      return {
        adopt: { kind: "utf8Span", lengthParameter: form.lengthParameter },
        requireNonNull: "raw",
        adoptSkipsNull: true,
        release: form.release,
        absent: null,
      };
    case "utf8SpanResultOrNull":
      return {
        adopt: { kind: "utf8Span", lengthParameter: form.lengthParameter },
        requireNonNull: null,
        adoptSkipsNull: true,
        release: form.release,
        absent: { unionId: form.unionId, presentTag: form.stringTag, nullTag: form.nullTag },
      };
    case "utf8CString":
      return {
        adopt: { kind: "cstring" },
        /* After the copy and the release: the copy answers null for null, and
         * the foreign pointer still has to be freed before the throw. */
        requireNonNull: "managed",
        adoptSkipsNull: false,
        release: form.release,
        absent: null,
      };
    case "utf8CStringOrNull":
      return {
        adopt: { kind: "cstring" },
        requireNonNull: null,
        adoptSkipsNull: false,
        release: form.release,
        absent: { unionId: form.unionId, presentTag: form.stringTag, nullTag: form.nullTag },
      };
    case "utf8CStringArray":
      return {
        adopt: { kind: "cstringVector" },
        requireNonNull: "managed",
        adoptSkipsNull: false,
        release: form.release,
        absent: null,
      };
    case "utf8CStringArrayOrNull":
      return {
        adopt: { kind: "cstringVector" },
        requireNonNull: null,
        adoptSkipsNull: false,
        release: form.release,
        absent: { unionId: form.unionId, presentTag: form.arrayTag, nullTag: form.nullTag },
      };
    default: {
      /* Exhaustive over the narrowed union, so widening
       * `NativeResultCopyForm` without describing the new family stops this
       * file compiling rather than silently answering for it. */
      const unhandled: never = form;
      throw new NativeCallPlanError(
        (unhandled as { kind: string }).kind,
        "result projection claimed as a copy but not described",
      );
    }
  }
}

/** The result forms that produce an owned native handle. */
export type NativeResultHandleForm = Extract<
  NativeResultForm,
  { kind: "handle" | "handleOrNull" }
>;

/**
 * How an owned handle result reaches a managed cell.
 *
 * Both backends walked this tree by hand, and the two arms differ in a way
 * neither said out loud. `handle` PREPARES THE CELL BEFORE THE CALL, because a
 * registration owner and any retained callback tokens have to be attached to
 * it while the callee still might fire a callback; `handleOrNull` prepares
 * lazily, after, because it has nothing to attach. That ordering is load
 * bearing and invisible in either ladder.
 *
 * `interns` is faithful to each arm rather than unified, and the difference is
 * recorded rather than decided here: the nullable arm asks the identity map
 * unconditionally while the non-nullable arm asks only for pointer identity.
 * The runtime makes the extra ask harmless — `scr_native_handle_interned`
 * answers NULL immediately for a type that does not intern — so this is a
 * call that cannot matter rather than a defect, and collapsing it would change
 * emitted output for no behavioural gain.
 */
export interface NativeResultHandle {
  readonly definition: IrNativeHandleDef;
  readonly destructor: string;
  /** Whether a live cell for the same pointer IS the answer, making the
   * reference the callee handed over surplus. */
  readonly interns: boolean;
  /** Present when the cell is prepared before the call, naming the argument
   * that owns the registration, if any. */
  readonly prepareBeforeCall: { readonly ownerArgument: number | null } | null;
  /** What a NULL pointer means here. `value` is the union's null arm, `throw`
   * is the declared failure, `trap` is a contract nobody can honour — a
   * non-failing call that produced nothing — and `unchecked` is a type that
   * neither interns nor declares null as failure, where no test is emitted. */
  readonly onNull: "value" | "throw" | "trap" | "unchecked";
  readonly absent: {
    readonly unionId: string;
    readonly presentTag: number;
    readonly nullTag: number;
  } | null;
}

/** The handle description for a form already narrowed to the handle arms. */
export function nativeResultHandle(
  form: NativeResultHandleForm,
  failsOnNullResult: boolean,
  registrationOwner: number | null,
): NativeResultHandle {
  if (form.kind === "handleOrNull") {
    return {
      definition: form.definition,
      destructor: form.destructor,
      interns: true,
      prepareBeforeCall: null,
      onNull: "value",
      absent: { unionId: form.unionId, presentTag: form.handleTag, nullTag: form.nullTag },
    };
  }
  const interns = form.definition.identity === "pointer";
  return {
    definition: form.definition,
    destructor: form.destructor,
    interns,
    prepareBeforeCall: { ownerArgument: registrationOwner },
    /* A type that neither interns nor declares null as failure emits no test
     * at all: there is no cell to abandon and no contract to report. */
    onNull: failsOnNullResult ? "throw" : interns ? "trap" : "unchecked",
    absent: null,
  };
}

/** The argument forms that BORROW managed storage for the extent of one call. */
export type NativeArgumentBorrowForm = Extract<
  NativeArgumentForm,
  {
    kind:
      | "cString"
      | "cStringNull"
      | "cStringOrNull"
      | "cStringArray"
      | "cStringArrayNull"
      | "cStringArrayOrNull";
  }
>;

/**
 * A managed value lent to the callee for the extent of one call.
 *
 * Six argument arms are two families crossed with three nullabilities, and
 * both backends wrote all six. The three nullabilities are one question with
 * three answers rather than three shapes: absent by construction is the null
 * pointer and emits nothing, absent at runtime reads the union's arm, and
 * present reads the value. Naming it that way is what lets a third borrowed
 * family arrive as a row rather than as six more arms.
 *
 * `releasedAfterCall` is the only place the two families genuinely part. A
 * borrowed C string points into storage the managed string already owns, so
 * there is nothing to give back. A borrowed vector is BUILT for the call —
 * the pointers are new even though the strings are not — so it has to be
 * released afterwards, and on the throwing path too, which is why the borrow
 * is recorded rather than released inline.
 */
/**
 * Where an argument projection reads its managed value.
 *
 * The three nullabilities every value family crosses, said once. Absent by
 * CONSTRUCTION is `null` here — the projection emits the null pointer and
 * reads nothing. Absent at RUNTIME sets `unionTag`, because the value is a
 * union and only that arm carries something to read. Present leaves the tag
 * null, because the value already is what the slot wants.
 *
 * Two families cross it today, borrowed storage and native handles, and they
 * spelled the same three cases independently. A third crosses it as a row.
 */
export interface NativeArgumentSource {
  readonly argument: number;
  readonly unionTag: number | null;
}

export interface NativeArgumentBorrow {
  readonly of: "cstring" | "cstringVector";
  readonly source: NativeArgumentSource | null;
  readonly releasedAfterCall: boolean;
}

/** The borrow description for a form already narrowed to the borrowing arms. */
export function nativeArgumentBorrow(
  form: NativeArgumentBorrowForm,
): NativeArgumentBorrow {
  switch (form.kind) {
    case "cStringNull":
      return { of: "cstring", source: null, releasedAfterCall: false };
    case "cStringOrNull":
      return {
        of: "cstring",
        source: { argument: form.argument, unionTag: form.stringTag },
        releasedAfterCall: false,
      };
    case "cString":
      return {
        of: "cstring",
        source: { argument: form.argument, unionTag: null },
        releasedAfterCall: false,
      };
    case "cStringArrayNull":
      return { of: "cstringVector", source: null, releasedAfterCall: false };
    case "cStringArrayOrNull":
      return {
        of: "cstringVector",
        source: { argument: form.argument, unionTag: form.arrayTag },
        releasedAfterCall: true,
      };
    case "cStringArray":
      return {
        of: "cstringVector",
        source: { argument: form.argument, unionTag: null },
        releasedAfterCall: true,
      };
    default: {
      const unhandled: never = form;
      throw new NativeCallPlanError(
        (unhandled as { kind: string }).kind,
        "argument projection claimed as a borrow but not described",
      );
    }
  }
}

/** The argument forms that pass a native handle to the callee. */
export type NativeArgumentHandleForm = Extract<
  NativeArgumentForm,
  { kind: "handleNull" | "handleOrNull" | "handleRequire" | "handleSurrender" }
>;

/**
 * A native handle handed to the callee.
 *
 * The same three nullabilities the borrowed families cross, plus the one axis
 * that is this family's own: whether the callee TAKES the reference. It does
 * not, ordinarily — the cell keeps its reference and validates that the handle
 * is live. Where the contract says the callee takes it, the cell gives it up
 * instead, which is everything an explicit disposal does except freeing the
 * object, and makes a later use of that handle a use-after-dispose for exactly
 * the reason it is after `dispose()`.
 *
 * Surrender has no nullable arm, and that is the contract rather than an
 * omission: a call that may be handed nothing cannot also be the call that
 * takes ownership of it.
 */
export interface NativeArgumentHandle {
  /** Null exactly when the argument is statically absent: there is no handle,
   * so there is no type, and an empty string would be a placeholder standing
   * where a fact should be. */
  readonly typeId: string | null;
  readonly source: NativeArgumentSource | null;
  readonly surrenders: boolean;
}

/** The handle description for a form already narrowed to the handle arms. */
export function nativeArgumentHandle(
  form: NativeArgumentHandleForm,
): NativeArgumentHandle {
  switch (form.kind) {
    case "handleNull":
      return { typeId: null, source: null, surrenders: false };
    case "handleOrNull":
      return {
        typeId: form.typeId,
        source: { argument: form.argument, unionTag: form.handleTag },
        surrenders: false,
      };
    case "handleRequire":
      return {
        typeId: form.typeId,
        source: { argument: form.argument, unionTag: null },
        surrenders: false,
      };
    case "handleSurrender":
      return {
        typeId: form.typeId,
        source: { argument: form.argument, unionTag: null },
        surrenders: true,
      };
    default: {
      const unhandled: never = form;
      throw new NativeCallPlanError(
        (unhandled as { kind: string }).kind,
        "argument projection claimed as a handle but not described",
      );
    }
  }
}
