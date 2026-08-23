import { resolve } from "node:path";
import { nativeBindingDiag, nativeConversionDiag, nativeSignatureDiag } from "../../diagnostics/diagnostic.js";
import type {
  IrExpr,
  IrNativeBinding,
  IrNativeArgumentType,
  IrNativeCallbackContract,
  IrNativeHandleDef,
  IrNativeHandleType,
  IrNativeIntegerBinOp,
  IrNativeScalarType,
  IrNativeStructDef,
  IrNativeStructType,
  IrNativeTypeDef,
  IrNativeValueType,
  IrType,
  NullableHandleUnionId,
  SrcLoc,
} from "../../ir/nodes.js";
import { F64, nativeArgumentScriptType, nativeCallbackIsOwnerScoped, nativeIntegerInfo, nativeScalarWidensToNumber, provenNumberLiteral, typeEquals, typeKey } from "../../ir/nodes.js";
import type { NativeFrontendInput } from "../native.js";
import { locOf } from "../program.js";
import { tsgoPath } from "../shared.js";
import * as ts from "../ts7/adapter.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

export type NativeInputBinding = NativeFrontendInput["bindings"][number];
export type NativeInputConstant = NativeFrontendInput["constants"][number];
export type NativeInputOperation = NativeFrontendInput["operations"][number];

export interface ResolvedNativeFrontend {
  readonly typesBySymbol: ReadonlyMap<ts.Symbol, IrNativeValueType>;
  readonly typeDefsById: ReadonlyMap<string, NativeFrontendInput["types"][number]>;
  readonly bindingsBySymbol: ReadonlyMap<ts.Symbol, readonly NativeInputBinding[]>;
  readonly bindingsByDeclaration: ReadonlyMap<ts.Node, readonly NativeInputBinding[]>;
  readonly constantsBySymbol: ReadonlyMap<ts.Symbol, NativeInputConstant>;
  readonly operationsBySymbol: ReadonlyMap<ts.Symbol, NativeInputOperation>;
}

function declarationSymbol(
  L: Lowerer,
  declaration: { readonly module: string; readonly name: string },
  memberSpace: "instance" | "value" = "instance",
): ts.Symbol | null {
  const declarationPath = L.externalTypes.get(declaration.module);
  if (declarationPath === undefined) return null;
  const source = L.program.getSourceFile(tsgoPath(resolve(declarationPath)));
  if (source === undefined) return null;
  const moduleSymbol = L.checker.getSymbolAtLocation(source);
  const [root, ...members] = declaration.name.split(".");
  if (root === undefined || root.length === 0 || members.some((member) => member.length === 0)) {
    return null;
  }
  let symbol = moduleSymbol?.getExports().get(root as ts.__String);
  if (symbol === undefined) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
  for (const [index, member] of members.entries()) {
    const ownerType: ts.Type = index === 0 && memberSpace === "value"
      ? L.checker.getTypeOfSymbol(symbol)
      : L.checker.getDeclaredTypeOfSymbol(symbol);
    symbol = L.checker
      .getPropertiesOfType(ownerType)
      .find((property) => String(property.name) === member);
    if (symbol === undefined) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** Resolve embedder declaration identities once per lowering pass. Exact
 * checker symbol identity is the only recognition key used later. Missing
 * entries remain inert until source reaches a value that requires them. */
export function resolveNativeFrontend(
  L: Lowerer,
  input: NativeFrontendInput | undefined,
): ResolvedNativeFrontend {
  const typesBySymbol = new Map<ts.Symbol, IrNativeValueType>();
  const typeDefsById = new Map((input?.types ?? []).map((type) => [type.id, type]));
  const mutableBindingsBySymbol = new Map<ts.Symbol, NativeInputBinding[]>();
  const constantsBySymbol = new Map<ts.Symbol, NativeInputConstant>();
  const operationsBySymbol = new Map<ts.Symbol, NativeInputOperation>();
  for (const sourceType of input?.sourceTypes ?? []) {
    /* "value", like the constant and operation paths below, because a DOTTED
     * type name names something nested — and a nested class lives on the value
     * side of its owner's merged symbol, not on the instance type. Reading the
     * instance type finds no `View.OnClickListener` and the failure surfaces
     * far away, as a parameter mapping to 'unknown' at the binding that takes
     * one.
     *
     * Inert for an undotted name: the member loop never runs, so no existing
     * source type changes meaning. */
    const symbol = declarationSymbol(L, sourceType.declaration, "value");
    if (symbol !== null) {
      const type = { ...sourceType.type };
      typesBySymbol.set(symbol, type);
    }
  }
  for (const binding of input?.bindings ?? []) {
    const symbol = declarationSymbol(
      L,
      binding.declaration,
      binding.sourceCall.kind === "method" ||
          binding.sourceCall.kind === "getter" ||
          binding.sourceCall.kind === "setter"
        ? "instance"
        : "value",
    );
    if (symbol !== null) {
      const bindings = mutableBindingsBySymbol.get(symbol) ?? [];
      bindings.push(binding);
      mutableBindingsBySymbol.set(symbol, bindings);
    }
  }
  for (const constant of input?.constants ?? []) {
    const symbol = declarationSymbol(L, constant.declaration, "value");
    if (symbol !== null) constantsBySymbol.set(symbol, constant);
  }
  for (const operation of input?.operations ?? []) {
    const symbol = declarationSymbol(L, operation.declaration, "value");
    if (symbol !== null) operationsBySymbol.set(symbol, operation);
  }
  const bindingsBySymbol = new Map(
    [...mutableBindingsBySymbol].map(([symbol, bindings]) => [
      symbol,
      Object.freeze([...bindings]),
    ] as const),
  );
  const bindingsByDeclaration = new Map<ts.Node, readonly NativeInputBinding[]>();
  for (const [symbol, bindings] of bindingsBySymbol) {
    for (const declaration of L.checker.declarationsOf(symbol)) {
      bindingsByDeclaration.set(declaration, bindings);
    }
  }
  return {
    typesBySymbol,
    typeDefsById,
    bindingsBySymbol,
    bindingsByDeclaration,
    constantsBySymbol,
    operationsBySymbol,
  };
}

function nativeBindingByKind(
  L: Lowerer,
  symbol: ts.Symbol,
  kinds: readonly NativeInputBinding["sourceCall"]["kind"][],
): NativeInputBinding | undefined {
  let bindings = L.nativeBindingsBySymbol.get(symbol);
  if (bindings === undefined) {
    for (const declaration of L.checker.declarationsOf(symbol)) {
      bindings = L.nativeBindingsByDeclaration.get(declaration);
      if (bindings !== undefined) break;
    }
  }
  return bindings?.find((binding) =>
    kinds.includes(binding.sourceCall.kind)
  );
}

export function nativeTypeOf(
  L: Lowerer,
  type: ts.Type,
): IrNativeValueType | null {
  for (const symbol of [type.getAliasSymbol(), type.getSymbol()]) {
    if (symbol === undefined) continue;
    const resolved = symbol.flags & ts.SymbolFlags.Alias
      ? L.checker.getAliasedSymbol(symbol)
      : symbol;
    const mapped = L.nativeTypesBySymbol.get(resolved);
    if (mapped !== undefined) return mapped;
  }
  return null;
}

function failBinding(
  L: Lowerer,
  binding: NativeInputBinding,
  detail: string,
  loc: SrcLoc,
): never {
  L.pushDiag(nativeBindingDiag(binding.id, detail, loc));
  throw new PoisonError();
}

function failSignature(
  L: Lowerer,
  binding: NativeInputBinding,
  detail: string,
  loc: SrcLoc,
): never {
  L.pushDiag(nativeSignatureDiag(binding.id, detail, loc));
  throw new PoisonError();
}

function matchesNativeResultSource(
  L: Lowerer,
  binding: NativeInputBinding,
  mapped: IrType,
): boolean {
  if (binding.result.projection.kind === "direct") {
    return binding.result.type.kind !== "nativePointer" &&
      typeEquals(mapped, binding.result.type);
  }
  if (binding.result.projection.kind === "boolean") return mapped.kind === "bool";
  /* A widened result reads as an ordinary number. */
  if (binding.result.projection.kind === "number") return mapped.kind === "f64";
  // An error channel yields no source value, so the declaration must be void.
  if (binding.result.projection.kind === "errorChannel") {
    return mapped.kind === "void";
  }
  /* An absent handle is a value, so the declaration is a union of the handle
   * and null — the same shape a nullable string result takes. */
  if (binding.result.projection.kind === "nullableHandle") {
    const handle = binding.result.type;
    if (handle.kind !== "nativeHandle" || mapped.kind !== "union") return false;
    const handleArms = L.unions.get(mapped.unionId)?.arms;
    return handleArms?.length === 2 &&
      handleArms.some((arm) =>
        arm.kind === "nativeHandle" && arm.typeId === handle.typeId
      ) &&
      handleArms.some((arm) => arm.kind === "nullT");
  }
  /* A copied vector reads as a plain `string[]`, and a nullable one as the
   * union with null — the same two shapes a copied string takes, because the
   * projection differs in what it copies and not in what the program sees. */
  if (binding.result.projection.kind === "utf8CStringArray") {
    const isStringArray = (type: IrType): boolean =>
      type.kind === "array" && type.elem.kind === "string";
    if (!binding.result.projection.nullable) return isStringArray(mapped);
    if (mapped.kind !== "union") return false;
    const vectorArms = L.unions.get(mapped.unionId)?.arms;
    return vectorArms?.length === 2 &&
      vectorArms.some(isStringArray) &&
      vectorArms.some((arm) => arm.kind === "nullT");
  }
  /* A copied byte span reads as a plain `Uint8Array`. There is no nullable
   * arm: the span is built from the pointer and the length the call produced,
   * and a program that needs absence needs a nullable-bytes contract with its
   * own motivating program. */
  if (binding.result.projection.kind === "bytes") {
    return mapped.kind === "bytes" && mapped.elem === binding.result.projection.elem;
  }
  /* Text carried as a pointer and a length reads as a plain string, or as a
   * string-or-null union where the producer admits absence. Both facts are
   * needed at once by a boundary whose metadata separates neither — a Java
   * String result is routinely null AND may contain U+0000. */
  if (binding.result.projection.kind === "utf8Span") {
    if (!binding.result.projection.nullable) return mapped.kind === "string";
    if (mapped.kind !== "union") return false;
    const spanArms = L.unions.get(mapped.unionId)?.arms;
    return spanArms?.length === 2 &&
      spanArms.some((arm) => arm.kind === "string") &&
      spanArms.some((arm) => arm.kind === "nullT");
  }
  if (binding.result.projection.kind === "peerSlotValue") return false;
  if (!binding.result.projection.nullable) return mapped.kind === "string";
  if (mapped.kind !== "union") return false;
  const arms = L.unions.get(mapped.unionId)?.arms;
  return arms?.length === 2 &&
    arms.some((arm) => arm.kind === "string") &&
    arms.some((arm) => arm.kind === "nullT");
}

/**
 * Why a native call's result did not match its declaration.
 *
 * Control-flow narrowing is the common cause and the least obvious one. A
 * native getter returns whatever its declaration allows on every call — the
 * setter may normalise the value, and a nullable getter may still return null
 * — so a narrowed read would put a value the callee can produce into a slot
 * that cannot hold it.
 *
 * Two different things narrow a property read, and they need different fixes,
 * so the message names both. A guard narrows the reads after it, and the fix
 * is to read once into a local and test that. An assignment narrows every
 * later read to what was assigned, and no local helps because the read itself
 * is already narrowed — the value being assigned has to be widened instead.
 */
function nativeResultMismatchReason(
  L: Lowerer,
  binding: NativeInputBinding,
  mapped: IrType | null,
): string {
  if (mapped === null) return "the validated declaration lost its source result type";
  if (
    binding.result.projection.kind === "utf8CString" &&
    binding.result.projection.nullable &&
    (mapped.kind === "string" || mapped.kind === "nullT")
  ) {
    return (
      "its result is declared 'string | null' but reads as " +
      `'${mapped.kind === "string" ? "string" : "null"}' here. A native call ` +
      "cannot rely on control-flow narrowing: the callee returns what its " +
      "declaration allows on every call. If a check narrowed it, read it once " +
      "into a local and test that instead. If assigning to the same property " +
      "narrowed it, widen the assigned value — no local helps there, because " +
      "the read is already narrowed"
    );
  }
  void L;
  return "the validated declaration lost its source result type";
}

/* The union a nullable payload's handler receives, interned rather than looked
 * up. The program's own `T | null` annotation interns the same arms in the
 * same order, so this either finds that union or creates the one the program
 * would have created — and a handler that never writes the type still leaves
 * the module carrying it.
 *
 * Order is not incidental: a union's identity is its ORDERED arms, so arms
 * sorted differently would intern a SECOND union with the same members and
 * different tags. The sort here is the type mapper's, for that reason. */
function nullableUnionIdOf(L: Lowerer): NullableHandleUnionId {
  return (typeId) => {
    const arms: IrType[] = [
      { kind: "nativeHandle", typeId },
      { kind: "nullT" },
    ];
    arms.sort((left, right) => (typeKey(left) < typeKey(right) ? -1 : 1));
    return L.unions.intern(arms);
  };
}

function matchesNativeArgumentSource(
  L: Lowerer,
  expected: NativeInputBinding["arguments"][number]["type"],
  mapped: IrType,
): boolean {
  if (expected.kind === "nullableNativeHandle") {
    const handle = { kind: "nativeHandle", typeId: expected.typeId } as const;
    if (mapped.kind === "nullT" || typeEquals(mapped, handle)) return true;
    if (mapped.kind !== "union") return false;
    const handleArms = L.unions.get(mapped.unionId)?.arms;
    return handleArms?.length === 2 &&
      handleArms.some((arm) => typeEquals(arm, handle)) &&
      handleArms.some((arm) => arm.kind === "nullT");
  }
  if (expected.kind === "nullableStringArray") {
    const isStringArray = (type: IrType): boolean =>
      type.kind === "array" && type.elem.kind === "string";
    if (isStringArray(mapped) || mapped.kind === "nullT") return true;
    if (mapped.kind !== "union") return false;
    const vectorArms = L.unions.get(mapped.unionId)?.arms;
    return vectorArms?.length === 2 &&
      vectorArms.some(isStringArray) &&
      vectorArms.some((arm) => arm.kind === "nullT");
  }
  if (expected.kind !== "nullableString") {
    return typeEquals(mapped, nativeArgumentScriptType(expected, nullableUnionIdOf(L)));
  }
  if (mapped.kind === "string" || mapped.kind === "nullT") return true;
  if (mapped.kind !== "union") return false;
  const arms = L.unions.get(mapped.unionId)?.arms;
  return arms?.length === 2 &&
    arms.some((arm) => arm.kind === "string") &&
    arms.some((arm) => arm.kind === "nullT");
}

function formatNativeArgumentType(
  L: Lowerer,
  type: NativeInputBinding["arguments"][number]["type"],
): string {
  if (type.kind === "nullableString") return "string | null";
  if (type.kind === "nullableStringArray") return "string[] | null";
  if (type.kind === "nullableNativeHandle") {
    return `${L.fmt({ kind: "nativeHandle", typeId: type.typeId })} | null`;
  }
  return L.fmt(nativeArgumentScriptType(type, nullableUnionIdOf(L)));
}

function validateDeclaration(
  L: Lowerer,
  binding: NativeInputBinding,
  symbol: ts.Symbol,
  loc: SrcLoc,
): void {
  const declarations = L.checker.declarationsOf(symbol);
  const hasStaticModifier = (declaration: ts.Node): boolean =>
    ts.getModifiers(declaration)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) === true;
  const declarationGuard = (declaration: ts.Node): boolean => {
    if (binding.sourceCall.kind === "constructor") {
      return ts.isClassDeclaration(declaration) && declaration.getSourceFile().isDeclarationFile;
    }
    if (binding.sourceCall.kind === "function") {
      return ts.isFunctionDeclaration(declaration) ||
        (ts.isMethodDeclaration(declaration) && hasStaticModifier(declaration));
    }
    if (binding.sourceCall.kind === "getter" || binding.sourceCall.kind === "setter") {
      return declaration.kind === ts.SyntaxKind.PropertySignature ||
        ((ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration)) &&
          !hasStaticModifier(declaration));
    }
    return declaration.kind === ts.SyntaxKind.MethodSignature ||
      (ts.isMethodDeclaration(declaration) && !hasStaticModifier(declaration));
  };
  /* A declaration may be MERGED with ambient declarations — how a .d.ts says a
   * class also has another type's members (`export interface Box extends
   * Orientable {}`, the shape a class implementing an interface projects as)
   * or its own compile-time constants (`export declare namespace Widget { const
   * MAX_DEPTH: jint; }`, the shape a class with static finals projects as).
   *
   * Both contribute members whose own bindings resolve on their own, add no
   * construction and no body, so neither supplies a call declaration nor
   * disqualifies the ones that do. The namespace was missing for as long as
   * only constant-ONLY classes projected one, so a class with BOTH a
   * constructor and constants was the first program to put the two in the same
   * declaration list — and its constructor stopped resolving. */
  const mergedTypeDeclaration = (declaration: ts.Node): boolean =>
    (ts.isInterfaceDeclaration(declaration) ||
      ts.isModuleDeclaration(declaration)) &&
    declaration.getSourceFile().isDeclarationFile;
  const callDeclarations = declarations.filter(declarationGuard);
  if (
    callDeclarations.length === 0 ||
    declarations.some((declaration) =>
      !declarationGuard(declaration) && !mergedTypeDeclaration(declaration)
    ) ||
    callDeclarations.some((declaration) => "body" in declaration && declaration.body !== undefined)
  ) {
    failBinding(
      L,
      binding,
      `the configured declaration does not resolve exclusively to signature-only ${binding.sourceCall.kind} declarations`,
      loc,
    );
  }
  if (binding.sourceCall.kind === "getter") {
    if (
      binding.arguments.length !== 1 ||
      binding.sourceCall.receiverArgument !== 0
    ) {
      failSignature(L, binding, "a native getter requires exactly one receiver argument", loc);
    }
    const sourceResult = L.checker.getTypeOfSymbol(symbol);
    const mappedResult = L.mapTypeOf(sourceResult);
    if (mappedResult === null || !matchesNativeResultSource(L, binding, mappedResult)) {
      failSignature(
        L,
        binding,
        `the getter maps to '${mappedResult === null ? L.checker.typeToString(sourceResult) : L.fmt(mappedResult)}', ` +
          `not the '${binding.result.projection.kind}' native result projection`,
        loc,
      );
    }
    return;
  }
  if (binding.sourceCall.kind === "setter") {
    if (
      binding.arguments.length !== 2 ||
      binding.sourceCall.receiverArgument !== 0 ||
      binding.sourceCall.valueArgument !== 1 ||
      binding.result.type.kind !== "void" ||
      binding.result.projection.kind !== "direct"
    ) {
      failSignature(
        L,
        binding,
        "a native setter requires receiver argument 0, value argument 1, and a direct void result",
        loc,
      );
    }
    const setters = callDeclarations.filter(ts.isSetAccessorDeclaration);
    if (setters.length !== 1 || setters[0]!.parameters.length !== 1) {
      failSignature(L, binding, "a native setter requires exactly one setter declaration with one value parameter", loc);
    }
    const sourceType = L.checker.getTypeAtLocation(setters[0]!.parameters[0]!);
    const mapped = L.mapTypeOf(sourceType);
    const expected = binding.arguments[binding.sourceCall.valueArgument]!.type;
    if (mapped === null || !matchesNativeArgumentSource(L, expected, mapped)) {
      failSignature(
        L,
        binding,
        `the setter value maps to '${mapped === null ? L.checker.typeToString(sourceType) : L.fmt(mapped)}', not '${formatNativeArgumentType(L, expected)}'`,
        loc,
      );
    }
    return;
  }
  if (callDeclarations.some((declaration) => {
    const callable = declaration as
      | ts.ClassDeclaration
      | ts.FunctionDeclaration
      | ts.MethodDeclaration
      | ts.MethodSignature;
    return (callable.typeParameters?.length ?? 0) > 0;
  })) {
    failSignature(L, binding, "generic declarations cannot describe one fixed native ABI", loc);
  }
  const declarationType = L.checker.getTypeOfSymbol(symbol);
  const signatures = binding.sourceCall.kind === "constructor"
    ? L.checker.getConstructSignatures(declarationType)
    : L.checker.getCallSignatures(declarationType);
  if (signatures.length !== 1) {
    failSignature(
      L,
      binding,
      `the declaration has ${signatures.length} call signatures; exactly one is required`,
      loc,
    );
  }
  const signature = signatures[0]!;
  const parameters = signature.getParameters();
  const sourceParameters = binding.arguments.filter(
    (_argument, index) =>
      (binding.sourceCall.kind !== "method" &&
        binding.sourceCall.kind !== "getter" &&
        binding.sourceCall.kind !== "setter") ||
        index !== binding.sourceCall.receiverArgument,
  );
  if (parameters.length !== sourceParameters.length) {
    failSignature(
      L,
      binding,
      `the declaration has ${parameters.length} explicit parameter(s), but Native IR requires ${sourceParameters.length}`,
      loc,
    );
  }
  for (let index = 0; index < parameters.length; index++) {
    const sourceType = L.checker.getTypeOfSymbol(parameters[index]!);
    if (sourceType.flags & ts.TypeFlags.Never) {
      failSignature(L, binding, `parameter ${index + 1} is 'never'`, loc);
    }
    const mapped = L.mapTypeOf(sourceType);
    const expected = sourceParameters[index]!.type;
    if (mapped === null || !matchesNativeArgumentSource(L, expected, mapped)) {
      failSignature(
        L,
        binding,
        `parameter ${index + 1} maps to '${mapped === null ? L.checker.typeToString(sourceType) : L.fmt(mapped)}', ` +
          `not '${formatNativeArgumentType(L, expected)}'`,
        loc,
      );
    }
  }
  const sourceResult = L.checker.getReturnTypeOfSignature(signature);
  if (sourceResult.flags & ts.TypeFlags.Never) {
    if (binding.error.detect.kind === "never") {
      failSignature(L, binding, "the return type is 'never', but the native call cannot fail", loc);
    }
    return;
  }
  const mappedResult = L.mapTypeOf(sourceResult);
  if (mappedResult === null || !matchesNativeResultSource(L, binding, mappedResult)) {
    failSignature(
      L,
      binding,
      `the return maps to '${mappedResult === null ? L.checker.typeToString(sourceResult) : L.fmt(mappedResult)}', ` +
        `not the '${binding.result.projection.kind}' native result projection`,
      loc,
    );
  }
}

function nativeExpressionSymbol(L: Lowerer, expression: ts.Expression): ts.Symbol | null {
  const symbol = ts.isIdentifier(expression)
    ? L.resolveValueSymbol(expression)
    : ts.isPropertyAccessExpression(expression)
      ? L.checker.getPropertyOfType(
          L.typeOf(expression.expression),
          expression.name.text,
        ) ?? L.checker.getSymbolAtLocation(expression.name) ?? null
      : null;
  if (symbol === null || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return L.checker.getAliasedSymbol(symbol);
}

/**
 * Whether an expression has a native lowering configured for it.
 *
 * Asked by the external-host fence, which exists to stop a value rooted in a
 * `--external-types` declaration from lowering as something it is not. A
 * native call is the case where the premise fails: the declaration DOES have
 * a runtime implementation, supplied by the frontend input, so fencing it
 * would refuse a call the compiler knows how to make.
 *
 * It answers for the callee alone. Whether the call is well-formed is
 * `lowerNativeCall`'s business and is diagnosed there, precisely; this only
 * decides whether the fence is the right refusal.
 */
export function hasNativeLowering(L: Lowerer, expression: ts.Expression): boolean {
  const callee = ts.isCallExpression(expression) || ts.isNewExpression(expression)
    ? expression.expression
    : expression;
  const symbol = nativeExpressionSymbol(L, callee);
  if (symbol === null) return false;
  return L.nativeOperationsBySymbol.has(symbol) ||
    L.nativeBindingsBySymbol.has(symbol) ||
    L.nativeConstantsBySymbol.has(symbol);
}

export function lowerNativeConstant(
  L: Lowerer,
  expression: ts.Identifier | ts.PropertyAccessExpression,
): IrExpr | null {
  const symbol = nativeExpressionSymbol(L, expression);
  if (symbol === null) return null;
  const constant = L.nativeConstantsBySymbol.get(symbol);
  if (constant === undefined) return null;
  const loc = locOf(expression);
  const declarations = L.checker.declarationsOf(symbol);
  const validDeclaration = (declaration: ts.Node): boolean =>
    (ts.isVariableDeclaration(declaration) && declaration.initializer === undefined) ||
    declaration.kind === ts.SyntaxKind.PropertySignature;
  if (declarations.length === 0 || declarations.some((declaration) => !validDeclaration(declaration))) {
    L.pushDiag(nativeBindingDiag(
      constant.id,
      "the configured constant does not resolve exclusively to ambient value declarations",
      loc,
    ));
    throw new PoisonError();
  }
  const mapped = L.mapTypeOf(L.typeOf(expression));
  /* A constant whose manifest type is an exact integer may be declared
   * `number`, and this is the only way it CAN be declared.
   *
   * Mapping runs from the underlying primitive — `number` to f64, `bigint` to
   * i64 — and a brand does not change it, so a platform's `jint` is `number`
   * however it is spelled. Requiring the mapped type to equal the manifest's
   * therefore admits f64 constants and refuses every integer one, which is not
   * a rule anybody chose: the manifest is right that the class file says int,
   * and TypeScript has no spelling that maps to i32.
   *
   * The admission is exact representability, asked through the same predicate
   * the widening rules ask, so a constant and a payload cannot disagree about
   * which integers a double carries. i64 and u64 fall out of it for the reason
   * they fall out everywhere else, and need no case here.
   *
   * f32 is excluded despite widening: its values are a subset of f64's, but
   * ScriptC has no f32 VALUE for the literal to be, so admitting one here
   * would produce a literal that a later rule refuses — a late diagnostic
   * about a decision made in this line. */
  const declaredAsNumber = mapped !== null && typeEquals(mapped, F64) &&
    constant.type.scalar !== "f32" &&
    nativeScalarWidensToNumber(constant.type.scalar);
  if (mapped === null || !(typeEquals(mapped, constant.type) || declaredAsNumber)) {
    L.pushDiag(nativeSignatureDiag(
      constant.id,
      `the constant maps to '${mapped === null ? L.checker.typeToString(L.typeOf(expression)) : L.fmt(mapped)}', not '${L.fmt(constant.type)}'`,
      loc,
    ));
    throw new PoisonError();
  }
  if (constant.type.scalar === "isize" || constant.type.scalar === "usize") {
    L.usesNativeTarget = true;
  }
  /* Declared `number`, so it IS one. The manifest's integer type is what
   * proved the value survives a double rather than what the expression
   * becomes: lowering it as an exact scalar would put an i32 everywhere the
   * program's own declaration promised a number, and every use would then be
   * ill-typed at a site that did nothing wrong. A program wanting the exact
   * type declares the exact type and takes the branch above. */
  if (declaredAsNumber && !typeEquals(mapped, constant.type)) {
    return { kind: "numLit", value: Number(constant.value), type: F64, loc };
  }
  return {
    kind: "nativeScalarLit",
    value: constant.value,
    type: { ...constant.type },
    loc,
  };
}

function lowerNativeInvocation(
  L: Lowerer,
  binding: NativeInputBinding,
  symbol: ts.Symbol,
  explicitArguments: readonly ts.Expression[],
  receiver: ts.Expression | null,
  sourceResult: ts.Type | null,
  loc: SrcLoc,
): IrExpr {
  if (!L.validatedNativeBindingIds.has(binding.id)) {
    validateDeclaration(L, binding, symbol, loc);
    L.validatedNativeBindingIds.add(binding.id);
  }
  const sourceParameterCount = binding.arguments.length - (receiver === null ? 0 : 1);
  if (explicitArguments.length !== sourceParameterCount) {
    failSignature(
      L,
      binding,
      `this call passes ${explicitArguments.length} explicit argument(s), but Native IR requires exactly ${sourceParameterCount}`,
      loc,
    );
  }
  const argumentNodes = [...explicitArguments];
  if (receiver !== null) {
    if (
      (binding.sourceCall.kind !== "method" &&
        binding.sourceCall.kind !== "getter" &&
        binding.sourceCall.kind !== "setter") ||
      binding.sourceCall.receiverArgument < 0 ||
      binding.sourceCall.receiverArgument >= binding.arguments.length
    ) {
      failBinding(L, binding, "the method receiver argument index is outside the logical argument list", loc);
    }
    argumentNodes.splice(binding.sourceCall.receiverArgument, 0, receiver);
  }
  const reinterpreted = refuseUnprovableNumberLiterals(L, binding, argumentNodes);
  const args = argumentNodes.map((argument, index) => {
    /* A bit pattern admitted above crosses as the value those bits name in
     * this slot. Rewriting it HERE rather than at the boundary keeps the
     * decision where the width is known: the emitters then prove the literal
     * like any other and drop the conversion entirely, which is the same
     * treatment `0x7F000000` already got for being one bit smaller. */
    const signed = reinterpreted.get(index);
    if (signed !== undefined) {
      return { kind: "numLit" as const, value: signed, type: F64, loc: locOf(argument) };
    }
    const expected = binding.arguments[index]!.type;
    /* The three nullable source forms are unions the call site may narrow, so
     * they are lowered from the CONTEXTUAL type below rather than against one
     * expected script type. Everything else has exactly one. */
    if (
      expected.kind !== "nullableString" &&
      expected.kind !== "nullableStringArray" &&
      expected.kind !== "nullableNativeHandle"
    ) {
      return L.lowerExprExpecting(argument, nativeArgumentScriptType(expected, nullableUnionIdOf(L)));
    }
    const mapped = L.mapTypeOf(
      L.checker.getContextualType(argument) ?? L.typeOf(argument),
    );
    if (mapped === null || !matchesNativeArgumentSource(L, expected, mapped)) {
      failSignature(L, binding, `argument ${index + 1} is not string | null`, loc);
    }
    return L.lowerExprExpecting(argument, mapped);
  });
  L.usesNativeTarget = true;
  L.usedNativeBindingIds.add(binding.id);
  if (binding.result.ownership.kind === "owned") {
    L.usedNativeBindingIds.add(binding.result.ownership.destructor);
  }
  for (const argument of binding.arguments) {
    if (argument.callback && nativeCallbackIsOwnerScoped(argument.callback)) {
      L.usedNativeBindingIds.add(argument.callback.cancellationBinding);
    }
    /* A payload destructor is reached through the CONTRACT and nowhere else.
     * The program never names it — the reference arrives with the payload and
     * the trampoline gives it back — so a binding reached only this way would
     * be stripped, and the emitter would fail resolving a destructor the
     * contract still points at. Every other binding a contract depends on is
     * marked here for the same reason; this one was missing because no program
     * had a handle payload until one did. */
    for (const source of argument.callback?.sourceArguments ?? []) {
      if (source.kind === "callback-parameter" && source.destructor !== undefined) {
        L.usedNativeBindingIds.add(source.destructor);
      }
    }
  }
  for (const argument of binding.arguments) useNativeArgumentType(L, argument.type);
  if (binding.result.type.kind === "nativeStruct" || binding.result.type.kind === "nativeHandle") {
    L.useNativeType(binding.result.type.typeId);
  }
  const mappedResult = sourceResult === null ? null : L.mapTypeOf(sourceResult);
  const resultType: IrType = sourceResult === null
    ? binding.result.type.kind === "void" && binding.result.projection.kind === "direct"
      ? { kind: "void" }
      : failBinding(L, binding, "a native setter must have a direct void result", loc)
    : sourceResult.flags & ts.TypeFlags.Never
    ? binding.error.detect.kind !== "never" &&
        binding.result.projection.kind === "direct" &&
        binding.result.type.kind !== "nativePointer"
      ? { ...binding.result.type }
      : failBinding(L, binding, "a non-failing native call cannot produce 'never'", loc)
    : mappedResult !== null && matchesNativeResultSource(L, binding, mappedResult)
      ? mappedResult
      : failBinding(L, binding, nativeResultMismatchReason(L, binding, mappedResult), loc);
  return {
    kind: "nativeCall",
    binding: binding.id,
    args,
    type: { ...resultType },
    loc,
  };
}

/** Lower one direct call of an exact checker-owned native declaration. */
/* Every nominal type an ARGUMENT names, which is not the same as every type a
 * program mentions. Two arms name one without the program ever holding a value
 * of it: a slot that admits absence, where passing null can be the whole use,
 * and a callback payload the handler receives and hands straight back. Walking
 * only the required-value arms dropped both, and the module then carried a
 * binding pointing at a type its own table no longer had — an internal error
 * rather than a wrong answer, and one that surfaces at the PARAMETER, far from
 * the argument that failed to name it.
 *
 * Neither gap was reachable from a program that also created such a value: the
 * neighbouring nullable test constructs a counter and reads it, which marks the
 * type through an ordinary expression and left this path correct by accident. A
 * framework binding is where they separate — a lifecycle handler receives an
 * optional object it never touches.
 *
 * Exhaustive so that a new argument arm carrying a typeId has to answer this
 * question rather than inherit "no" by omission. */
function useNativeArgumentType(L: Lowerer, type: IrNativeArgumentType): void {
  switch (type.kind) {
    case "nativeStruct":
    case "nativeHandle":
    case "nullableNativeHandle":
      L.useNativeType(type.typeId);
      return;
    case "func":
      for (const parameter of type.params) {
        if (
          parameter.kind === "nativeHandle" ||
          parameter.kind === "nullableNativeHandle"
        ) {
          L.useNativeType(parameter.typeId);
        }
      }
      return;
    case "nativeScalar":
    case "f64":
    case "bool":
    case "string":
    case "nullableString":
    case "bytes":
    case "array":
    case "nullableStringArray":
      return;
    default: {
      const remaining: never = type;
      return remaining;
    }
  }
}

/** `super.m(args)` inside an override of a native base class.
 *
 * Routed through the ordinary native invocation rather than reimplemented, so
 * the base call is validated, projected and error-handled exactly like the
 * call a program writes by hand — which is what `docs/native-subclassing.md`
 * asks for when it says the compiler validates a base call "like any other
 * native operation".
 *
 * Two things differ from an ordinary method call, and both are the point.
 * The BINDING is the one the manifest recorded as this member's base call,
 * not the one the member's own symbol names — that is what makes `super`
 * static and stops it redispatching to the override. And the binding is
 * validated against ITS OWN declaration, because the call site names the base
 * member while the binding names the bridge that reaches it.
 */
export function lowerNativeBaseCall(
  L: Lowerer,
  baseCallId: string,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const binding = (L.nativeInput?.bindings ?? [])
    .find((candidate) => candidate.id === baseCallId);
  const loc = locOf(call);
  if (binding === undefined) {
    L.pushDiag(nativeBindingDiag(
      baseCallId,
      `named as a base call by '${access.name.text}', but no binding declares it`,
      loc,
    ));
    return null;
  }
  const symbol = declarationSymbol(
    L,
    binding.declaration,
    binding.sourceCall.kind === "method" ? "instance" : "value",
  );
  if (symbol === null) {
    L.pushDiag(nativeBindingDiag(
      binding.id,
      "a base call must resolve to its own declaration",
      loc,
    ));
    return null;
  }
  /* `super` lowers to the override's receiver, so the receiver node here is
   * the same expression an ordinary method call would pass. */
  return lowerNativeInvocation(
    L,
    binding,
    symbol,
    call.arguments,
    binding.sourceCall.kind === "method" ? access.expression : null,
    L.typeOf(call),
    loc,
  );
}

export function lowerNativeCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  /* `super.m(...)` is NEVER this path, whatever the member resolves to.
   *
   * The member symbol behind `super.m` is the base's own declaration, and a
   * platform base declares its lifecycle members as ordinary methods — so this
   * path resolves `super.onCreate(state)` to `Activity.onCreate` and emits the
   * VIRTUAL call, which redispatches straight back into the override that made
   * it. On Android that is an unbounded recursion reported as
   * SuperNotCalledException, with no diagnostic anywhere.
   *
   * Declining here rather than reordering the dispatch, because the reason is
   * about meaning rather than precedence: `super.m` denotes the base
   * implementation, which is a different operation from the member of that
   * name, and the manifest names it separately (`baseCall`). The super path in
   * `lowerCall` owns the choice and refuses by name when no base call exists.
   *
   * This was invisible for as long as the fixture's base declared no callable
   * member of its own — with no binding to resolve, this path returned null
   * and the super path got the call by default. */
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return null;
  }
  const symbol = nativeExpressionSymbol(L, callee);
  if (symbol === null) return null;
  const operation = L.nativeOperationsBySymbol.get(symbol);
  if (operation !== undefined) {
    const loc = locOf(expr);
    const fail = (detail: string): never => {
      L.pushDiag(nativeSignatureDiag(operation.id, detail, loc));
      throw new PoisonError();
    };
    if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined) {
      fail("only direct, non-generic operation calls are supported");
    }
    if (expr.arguments.some(ts.isSpreadElement)) {
      fail("spread arguments are unnecessary for a variadic exact operation");
    }
    if (operation.type.scalar === "isize" || operation.type.scalar === "usize") {
      L.usesNativeTarget = true;
    }
    /* The two conversions are the named crossings between an exact scalar and
     * an ordinary number. They are operations rather than operators because
     * TypeScript has no syntax that could carry the direction, and named
     * rather than implicit because the language profile requires a conversion
     * to say what it does. */
    if (operation.kind === "to-number" || operation.kind === "from-number") {
      if (expr.arguments.length !== 1) {
        fail("a conversion takes exactly one argument");
      }
      const argument = expr.arguments[0]!;
      const sourceResult = L.mapTypeOf(L.typeOf(expr));
      if (operation.kind === "to-number") {
        const value = L.lowerExpr(argument);
        if (!typeEquals(value.type, operation.type)) {
          fail("the argument does not have the configured exact type");
        }
        if (sourceResult === null || sourceResult.kind !== "f64") {
          fail("a to-number conversion must be declared to return number");
        }
        return {
          kind: "nativeScalarToNumber",
          value,
          type: { kind: "f64" },
          loc,
        };
      }
      const value = L.lowerExprExpecting(argument, { kind: "f64" });
      if (value.type.kind !== "f64") {
        fail("a from-number conversion takes an ordinary number");
      }
      if (sourceResult === null || !typeEquals(sourceResult, operation.type)) {
        fail("a from-number conversion must be declared to return its exact type");
      }
      return {
        kind: "nativeScalarFromNumber",
        value,
        type: { ...operation.type },
        loc,
      };
    }
    if (expr.arguments.length === 0) {
      fail("an exact integer reduction requires at least one argument");
    }
    if (operation.type.scalar === "f64") {
      fail("an exact integer operation cannot use native f64 storage");
    }
    const sourceResult = L.mapTypeOf(L.typeOf(expr));
    if (sourceResult === null || !typeEquals(sourceResult, operation.type)) {
      fail("the declaration result does not preserve the configured exact integer type");
    }
    const values = expr.arguments.map((argument, index) => {
      const value = L.lowerExpr(argument);
      if (!typeEquals(value.type, operation.type)) {
        fail(`argument ${index + 1} does not have the configured exact integer type`);
      }
      return value;
    });
    const reduceOperator = operation.operator;
    const reduceType = { ...operation.type };
    return values.slice(1).reduce<IrExpr>(
      (left, right) => ({
        kind: "nativeIntegerBin",
        op: reduceOperator,
        left,
        right,
        type: { ...reduceType },
        loc,
      }),
      values[0]!,
    );
  }
  const binding = nativeBindingByKind(
    L,
    symbol,
    ["function", "method", "constructor", "getter", "setter"],
  );
  if (binding === undefined) return null;
  const loc = locOf(expr);
  if (binding.sourceCall.kind === "constructor") {
    failBinding(L, binding, "a native constructor must be invoked with 'new'", loc);
  }
  if (binding.sourceCall.kind === "getter") {
    failBinding(L, binding, "a native getter must be read as a property", loc);
  }
  if (binding.sourceCall.kind === "setter") {
    failBinding(L, binding, "a native setter must be written as a property", loc);
  }
  if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined) {
    failSignature(L, binding, "only direct, non-generic calls are supported", loc);
  }
  if (expr.arguments.some(ts.isSpreadElement)) {
    failSignature(L, binding, "spread arguments do not have a fixed native ABI", loc);
  }
  if (
    (binding.sourceCall.kind === "method" && !ts.isPropertyAccessExpression(callee))
  ) {
    failBinding(L, binding, `the source call is not a ${binding.sourceCall.kind}`, loc);
  }
  return lowerNativeInvocation(
    L,
    binding,
    symbol,
    expr.arguments,
    binding.sourceCall.kind === "method"
      ? (callee as ts.PropertyAccessExpression).expression
      : null,
    L.typeOf(expr),
    loc,
  );
}

/** Lower one direct read of an exact checker-owned native getter. */
export function lowerNativeGet(
  L: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const symbol = nativeExpressionSymbol(L, expr);
  if (symbol === null) return null;
  const binding = nativeBindingByKind(L, symbol, ["getter"]);
  if (binding === undefined) return null;
  const loc = locOf(expr);
  if (expr.questionDotToken !== undefined) {
    failSignature(L, binding, "optional native getter access is unsupported", loc);
  }
  return lowerNativeInvocation(
    L,
    binding,
    symbol,
    [],
    expr.expression,
    L.typeOf(expr),
    loc,
  );
}

/** Lower one statement-position write of an exact checker-owned native setter. */
export function lowerNativeSet(
  L: Lowerer,
  expr: ts.PropertyAccessExpression,
  value: ts.Expression,
): IrExpr | null {
  const symbol = nativeExpressionSymbol(L, expr);
  if (symbol === null) return null;
  const binding = nativeBindingByKind(L, symbol, ["setter"]);
  if (binding === undefined) return null;
  const loc = locOf(expr);
  if (expr.questionDotToken !== undefined) {
    failSignature(L, binding, "optional native setter access is unsupported", loc);
  }
  return lowerNativeInvocation(
    L,
    binding,
    symbol,
    [value],
    expr.expression,
    null,
    loc,
  );
}

/** Lower `new C(...)` for one exact external native class declaration. */
export function lowerNativeConstruct(L: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const symbol = nativeExpressionSymbol(L, expr.expression);
  if (symbol === null) return null;
  const binding = nativeBindingByKind(
    L,
    symbol,
    ["constructor", "function", "method", "getter", "setter"],
  );
  if (binding === undefined) return null;
  const loc = locOf(expr);
  if (binding.sourceCall.kind !== "constructor") {
    failBinding(L, binding, "this native declaration is callable but not constructable", loc);
  }
  if (expr.typeArguments !== undefined) {
    failSignature(L, binding, "generic construction is unsupported", loc);
  }
  const args = expr.arguments ?? [];
  if (args.some(ts.isSpreadElement)) {
    failSignature(L, binding, "spread arguments do not have a fixed native ABI", loc);
  }
  return lowerNativeInvocation(L, binding, symbol, args, null, L.typeOf(expr), loc);
}

/* The value of a numeric literal argument, seen through the parentheses and
 * unary sign a caller may spell it with. Every literal spelling — decimal,
 * hex, exponent, separator — reaches the emitter as the same folded double,
 * so the frontend reads the folded value rather than the source text. */
/** A literal written in hex, binary or octal — a BIT PATTERN spelling.
 *
 * Radix-prefixed spellings name bits; decimal names a quantity. Every language
 * with both draws that line, and Java draws it in the grammar: `int x =
 * 0xFF000000;` compiles and means -16777216, while `int x = 4278190080;` is
 * "integer number too large" (JLS 3.10.1). A program writing a colour, a mask
 * or a flag set writes the bits, and the slot it writes them into is the same
 * width either way. */
function radixSpelledLiteral(node: ts.Expression): boolean {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isNumericLiteral(expression)) return false;
  return /^0[xXbBoO]/.test(expression.getText());
}

function numericLiteralValue(node: ts.Expression): number | null {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  let sign = 1;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    sign = expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    expression = expression.operand;
  }
  if (!ts.isNumericLiteral(expression)) return null;
  return sign * Number(expression.text);
}

/** The signed value a radix-spelled literal names when it fills the slot from
 * the top, or null when this is not that case.
 *
 * Only a SIGNED slot has an unreachable upper half to reinterpret: in an
 * unsigned one the same bits are already the value the literal states, so
 * `provenNumberLiteral` has admitted it before this is asked. */
function twosComplementLiteral(
  node: ts.Expression,
  value: number,
  info: { min: bigint; max: bigint; bits: number },
): number | null {
  if (info.min >= 0n || !radixSpelledLiteral(node)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  const exact = BigInt(value);
  const span = 1n << BigInt(info.bits);
  if (exact <= info.max || exact >= span) return null;
  return Number(exact - span);
}

/* A checked-number parameter converts at run time, but a literal argument is
 * decided at compile time: either the emitters prove it and drop the check
 * entirely, or no value of the native type can hold it and the call could
 * only ever throw. A guaranteed throw is a program defect, so it is reported
 * where the caller can fix it instead of being deferred to a TypeError. */
function refuseUnprovableNumberLiterals(
  L: Lowerer,
  binding: NativeInputBinding,
  argumentNodes: readonly ts.Expression[],
): ReadonlyMap<number, number> {
  const reinterpreted = new Map<number, number>();
  for (const parameter of binding.parameters) {
    if (
      parameter.projection.kind !== "number" ||
      parameter.type.kind !== "nativeScalar"
    ) {
      continue;
    }
    const node = argumentNodes[parameter.projection.argument];
    if (node === undefined) continue;
    const value = numericLiteralValue(node);
    if (value === null) continue;
    const pointerBits = L.nativeInput?.target.pointerBits;
    if (pointerBits !== 32 && pointerBits !== 64) {
      throw new Error("native frontend input has no valid target pointer width");
    }
    /* Only an integer slot can disprove a literal. A float slot holds every
     * number a caller can write — NaN and the infinities included, and the
     * rest by rounding — so there is nothing here to refuse. */
    const info = nativeIntegerInfo(parameter.type.scalar, pointerBits);
    if (info === null) continue;
    if (provenNumberLiteral(value, parameter.type.scalar, pointerBits) !== null) continue;
    /* A bit pattern that fills the slot is not out of range, it is written
     * from the other end. `0xFF000000` in a 32-bit signed slot is the colour
     * every Android program writes, and refusing it taught `| 0` — a spelling
     * that means "reinterpret" and reads as arithmetic.
     *
     * Admitted for the RADIX spellings only, which is the line Java's own
     * grammar draws for the same slot, and only for a literal written at the
     * call: a computed value stays strict, because the moment it is computed
     * nobody can see what width it was meant for. */
    const signed = twosComplementLiteral(node, value, info);
    if (signed !== null) {
      reinterpreted.set(parameter.projection.argument, signed);
      continue;
    }
    failSignature(
      L,
      binding,
      `argument ${parameter.projection.argument + 1} is the literal ${String(value)}, ` +
        `which no '${parameter.type.scalar}' value represents, so this call could only ` +
        `throw (a bit pattern this wide is admitted written as hex, binary or octal)`,
      locOf(node),
    );
  }
  return reinterpreted;
}

function exactIntegerLiteral(
  node: ts.Expression,
  target: IrNativeScalarType,
  pointerBits: 32 | 64,
): string | null {
  const info = nativeIntegerInfo(target.scalar, pointerBits);
  if (info === null) return null;
  const pointerSized = target.scalar === "isize" || target.scalar === "usize";
  const bigintCarrier = pointerSized || info.bits === 64;
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  let negative = false;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    if (bigintCarrier && expression.operator === ts.SyntaxKind.PlusToken) return null;
    negative = expression.operator === ts.SyntaxKind.MinusToken;
    expression = expression.operand;
  }
  const digits = bigintCarrier
    ? ts.isBigIntLiteral(expression) && /^[0-9]+n$/.test(expression.text)
      ? expression.text.slice(0, -1)
      : null
    : ts.isNumericLiteral(expression) && /^[0-9]+$/.test(expression.text)
      ? expression.text
      : null;
  if (digits === null) return null;
  const value = BigInt(`${negative ? "-" : ""}${digits}`);
  if (value < info.min || value > info.max) return null;
  return value.toString();
}

function exactFloatLiteral(node: ts.Expression): string | null {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  let sign = 1;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    sign = expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    expression = expression.operand;
  }
  if (!ts.isNumericLiteral(expression)) return null;
  const value = sign * Number(expression.text);
  if (!Number.isFinite(value)) return null;
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Exact-scalar assertions are representation constructors, not erased
 * JavaScript casts. Fixed-width integers up to 32 bits accept decimal number
 * literals; 64-bit and pointer-sized integers accept decimal BigInt literals.
 * The stable BigInt carrier keeps an `isize`/`usize` declaration independent
 * of whether the selected target is 32- or 64-bit; its range still follows
 * that target. Every type also accepts a value already carrying the same
 * exact representation. General JavaScript BigInt values remain outside
 * ScriptC's static representation. */
export function lowerNativeScalarAssertion(
  L: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  target: IrNativeScalarType,
): IrExpr {
  if (target.scalar === "isize" || target.scalar === "usize") {
    L.usesNativeTarget = true;
  }
  let arithmeticExpression: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(arithmeticExpression)) {
    arithmeticExpression = arithmeticExpression.expression;
  }
  if (
    target.scalar !== "f64" &&
    ts.isBinaryExpression(arithmeticExpression)
  ) {
    let operation: IrNativeIntegerBinOp | null = null;
    switch (arithmeticExpression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        operation = "+";
        break;
      case ts.SyntaxKind.MinusToken:
        operation = "-";
        break;
      case ts.SyntaxKind.AsteriskToken:
        operation = "*";
        break;
      case ts.SyntaxKind.AmpersandToken:
        operation = "&";
        break;
      case ts.SyntaxKind.BarToken:
        operation = "|";
        break;
      case ts.SyntaxKind.CaretToken:
        operation = "^";
        break;
      /* The trapping four ride the same construction form as the wrapping
       * six. They are operators because JavaScript spells them as operators
       * on a BigInt, and the cast is here for the reason it is there: the
       * checker types arithmetic over a branded number as a plain one, so
       * the assertion is what names the exact result. */
      case ts.SyntaxKind.SlashToken:
        operation = "/";
        break;
      case ts.SyntaxKind.PercentToken:
        operation = "%";
        break;
      case ts.SyntaxKind.LessThanLessThanToken:
        operation = "<<";
        break;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        operation = ">>";
        break;
    }
    if (operation !== null) {
      const left = L.lowerExpr(arithmeticExpression.left);
      const right = L.lowerExpr(arithmeticExpression.right);
      if (
        typeEquals(left.type, target) &&
        typeEquals(right.type, target)
      ) {
        return {
          kind: "nativeIntegerBin",
          op: operation,
          left,
          right,
          type: { ...target },
          loc: locOf(expr),
        };
      }
    }
  }
  const source = L.mapTypeOf(L.typeOf(expr.expression));
  if (source !== null && typeEquals(source, target)) return L.lowerExpr(expr.expression);
  const pointerBits = L.nativeInput?.target.pointerBits;
  if (pointerBits !== 32 && pointerBits !== 64) {
    throw new Error("native frontend input has no valid target pointer width");
  }
  const value = target.scalar === "f64"
    ? exactFloatLiteral(expr.expression)
    : exactIntegerLiteral(expr.expression, target, pointerBits);
  if (value === null) {
    L.pushDiag(
      nativeConversionDiag(
        target.scalar,
        target.scalar === "f64"
          ? "the source is not a finite numeric literal or the same exact type"
          : target.scalar === "isize" ||
          target.scalar === "usize" ||
          nativeIntegerInfo(target.scalar, pointerBits)?.bits === 64
          ? "the source is not a provably in-range decimal BigInt literal or the same exact type"
          : "the source is not a provably in-range decimal number literal, same exact type, or same-type exact integer +, -, *, /, %, <<, >>, &, |, or ^ expression",
        locOf(expr),
      ),
    );
    throw new PoisonError();
  }
  return { kind: "nativeScalarLit", value, type: { ...target }, loc: locOf(expr) };
}

/** A direct object-literal assertion is the sole aggregate constructor in
 * this slice. It copies exact native field values into nominal aggregate
 * storage; arbitrary JavaScript objects and post-hoc reinterpretation are
 * deliberately rejected. */
export function lowerNativeStructAssertion(
  L: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  target: IrNativeStructType,
): IrExpr {
  const definition = L.nativeTypeDefsById.get(target.typeId);
  if (definition?.kind !== "struct") throw new Error(`missing native struct definition '${target.typeId}'`);
  const source = L.mapTypeOf(L.typeOf(expr.expression));
  if (source !== null && typeEquals(source, target)) return L.lowerExpr(expr.expression);
  if (!ts.isObjectLiteralExpression(expr.expression)) {
    L.pushDiag(nativeConversionDiag(target.typeId, "the source is not a direct object literal or the same nominal native type", locOf(expr)));
    throw new PoisonError();
  }
  const initializers = new Map<string, ts.Expression>();
  for (const property of expr.expression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      L.pushDiag(nativeConversionDiag(target.typeId, "native aggregate constructors require explicit property assignments without spreads or shorthand", locOf(property)));
      throw new PoisonError();
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null;
    if (name === null || initializers.has(name)) {
      L.pushDiag(nativeConversionDiag(target.typeId, "native aggregate field names must be unique identifiers or string literals", locOf(property)));
      throw new PoisonError();
    }
    initializers.set(name, property.initializer);
  }
  const expected = new Set(definition.fields.map((field) => field.name));
  const unexpected = [...initializers.keys()].filter((name) => !expected.has(name));
  const missing = definition.fields.filter((field) => !initializers.has(field.name)).map((field) => field.name);
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing field(s): ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unknown field(s): ${unexpected.join(", ")}`] : []),
    ];
    L.pushDiag(nativeConversionDiag(target.typeId, details.join("; "), locOf(expr)));
    throw new PoisonError();
  }
  const expectedFields = new Map(definition.fields.map((field) => [field.name, field]));
  // Preserve JavaScript object-literal evaluation order. Backends may place
  // the resulting temporaries in physical-layout order only after every
  // initializer has been evaluated in source order.
  const fields = [...initializers].map(([name, initializer]) => {
    const field = expectedFields.get(name)!;
    /* A number-projected field is declared as plain `number`, so its
     * initializer arrives as f64 and the exact expecting-path would refuse
     * it. Construction still writes the exact field, so the initializer must
     * be a provably in-range decimal literal — the same rule an exact scalar
     * construction applies. */
    /* A double field's source view is its own representation, so an
     * ordinary f64 expression constructs it — no literal proof to discharge
     * and nothing to check. */
    if (
      field.projection === "number" && field.type.kind === "nativeScalar" &&
      field.type.scalar === "f64"
    ) {
      return { name, value: L.lowerExprExpecting(initializer, { kind: "f64" }) };
    }
    /* Writing the truth test back: a boolean has exactly two values, so there
     * is no literal to prove and nothing to refuse. 1 and 0 are the canonical
     * pair the same test reads. */
    if (field.projection === "boolean") {
      return { name, value: L.lowerExprExpecting(initializer, { kind: "bool" }) };
    }
    if (field.projection === "number" && field.type.kind === "nativeScalar") {
      const pointerBits = L.nativeInput?.target.pointerBits;
      if (pointerBits !== 32 && pointerBits !== 64) {
        throw new Error("native frontend input has no valid target pointer width");
      }
      const value = exactIntegerLiteral(initializer, field.type, pointerBits);
      if (value === null) {
        L.pushDiag(nativeConversionDiag(
          target.typeId,
          `field "${name}" reads as a plain number but is stored exactly, so ` +
            "its initializer must be a provably in-range decimal number literal",
          locOf(initializer),
        ));
        throw new PoisonError();
      }
      return {
        name,
        value: {
          kind: "nativeScalarLit" as const,
          value,
          type: { ...field.type },
          loc: locOf(initializer),
        },
      };
    }
    return {
      name,
      value: L.lowerExprExpecting(initializer, field.type),
    };
  });
  L.usesNativeTarget = true;
  L.useNativeType(target.typeId);
  return { kind: "nativeStructLit", fields, type: { ...target }, loc: locOf(expr) };
}

export function lowerNativeStructFieldRead(
  L: Lowerer,
  expr: ts.PropertyAccessExpression,
  target: IrNativeStructType,
): IrExpr {
  const definition = L.nativeTypeDefsById.get(target.typeId);
  if (definition?.kind !== "struct") throw new Error(`missing native struct definition '${target.typeId}'`);
  const field = definition.fields.find((candidate) => candidate.name === expr.name.text);
  if (field === undefined) {
    throw new Error(`TypeScript checker exposed unknown native struct field '${expr.name.text}'`);
  }
  L.usesNativeTarget = true;
  L.useNativeType(target.typeId);
  return {
    kind: "nativeStructGet",
    value: L.lowerExpr(expr.expression),
    field: field.name,
    /* A marked field reads as an ordinary number: the exact value widens at
     * the read, so everything downstream is plain f64 arithmetic. */
    type: field.projection === "number"
      ? { kind: "f64" }
      : field.projection === "boolean"
        ? { kind: "bool" }
        : { ...field.type },
    loc: locOf(expr),
  };
}

export function materializeNativeBinding(binding: NativeInputBinding): IrNativeBinding {
  return {
    id: binding.id,
    declaration: { ...binding.declaration },
    sourceAccess: binding.sourceCall.kind === "getter"
      ? "read"
      : binding.sourceCall.kind === "setter"
        ? "write"
        : "call",
    ...(binding.baseCall === undefined ? {} : { baseCall: binding.baseCall }),
    ...(binding.terminal === undefined ? {} : { terminal: true as const }),
    entry: { ...binding.entry },
    error: {
      detect: { ...binding.error.detect },
      message: { ...binding.error.message },
      release: { ...binding.error.release },
    },
    arguments: binding.arguments.map((argument) => ({
      name: argument.name,
      type: { ...argument.type },
      ...(argument.callback === undefined
        ? {}
        : { callback: materializeNativeCallbackContract(argument.callback) }),
    })),
    parameters: binding.parameters.map((parameter) => ({
      name: parameter.name,
      type: { ...parameter.type },
      passMode: parameter.passMode,
      ownership: { ...parameter.ownership },
      projection: { ...parameter.projection },
    })),
    result: {
      type: { ...binding.result.type },
      passMode: binding.result.passMode,
      ownership: { ...binding.result.ownership },
      projection: { ...binding.result.projection },
      ...(binding.result.frameBounded === undefined
        ? {}
        : {
            frameBounded: {
              entry: { ...binding.result.frameBounded.entry },
              release: { ...binding.result.frameBounded.release },
            },
          }),
    },
  };
}

function materializeNativeCallbackContract(
  contract: Readonly<IrNativeCallbackContract>,
): IrNativeCallbackContract {
  const sourceArguments = contract.sourceArguments.map((argument) =>
    argument.kind !== "callback-parameter" || argument.frameBounded === undefined
      ? { ...argument }
      : {
          ...argument,
          frameBounded: {
            promote: { ...argument.frameBounded.promote },
            release: { ...argument.frameBounded.release },
          },
        }
  );
  if (contract.owner.kind === "call") {
    return {
      owner: { kind: "call" },
      allowedInvocationExecutors: ["same-as-caller"],
      synchronousReturn: true,
      sourceArguments,
    };
  }
  if (contract.owner.kind === "process") {
    /* Nothing in the program owns it, so there is no cancellation binding to
     * carry and no owner to preserve — which is what makes this its own arm
     * rather than a case of the retained one below. `nativeCallbackIsOwnerScoped`
     * stays as it is and keeps its name: a process registration genuinely is
     * not owner-scoped, and widening that predicate to admit it here would
     * make it false wherever else it is asked.
     *
     * Both deliveries exist for this owner. Direct when the thread that
     * registered is the one the library calls back on, which is the framework
     * dispatch case; queued when a foreign producer raised it and the payload
     * had to be copied to cross. The contract already says which, so this
     * carries the answer rather than deciding it. */
    return contract.synchronousReturn
      ? {
        owner: { kind: "process" },
        allowedInvocationExecutors: ["same-as-caller"],
        synchronousReturn: true,
        sourceArguments,
      }
      : {
        owner: { kind: "process" },
        allowedInvocationExecutors: [...contract.allowedInvocationExecutors],
        synchronousReturn: false,
        sourceArguments,
      };
  }
  if (!nativeCallbackIsOwnerScoped(contract)) {
    throw new Error("frontend bug: a non-call callback owner must be retained");
  }
  const owner = { ...contract.owner };
  const cancellationBinding = contract.cancellationBinding;
  /* A retained callback the native side asks synchronously reads its payloads
   * for the call, exactly as a call-scoped one does: nothing outlives the
   * answer, so nothing is copied. */
  if (contract.synchronousReturn) {
    return {
      owner,
      cancellationBinding,
      allowedInvocationExecutors: ["same-as-caller"],
      synchronousReturn: true,
      sourceArguments,
    };
  }
  return {
    owner,
    cancellationBinding,
    allowedInvocationExecutors: [...contract.allowedInvocationExecutors],
    synchronousReturn: false,
    sourceArguments,
  };
}

export function materializeNativeType(
  definition: NativeFrontendInput["types"][number],
): IrNativeTypeDef {
  if (definition.kind === "handle") {
    const result: IrNativeHandleDef = {
      ...definition,
      declaration: { ...definition.declaration },
      ...(definition.peerSlot === undefined
        ? {}
        : { peerSlot: { ...definition.peerSlot } }),
      upcasts: definition.upcasts.map((upcast) => ({ ...upcast })),
    };
    return result;
  }
  return {
    ...definition,
    declaration: { ...definition.declaration },
    abi: {
      result: cloneNativePhysicalAbiValue(definition.abi.result),
      parameters: definition.abi.parameters.map(cloneNativePhysicalAbiValue),
    },
    fields: definition.fields.map((field) => ({
      ...field,
      type: { ...field.type },
    })),
  };
}

function cloneNativePhysicalAbiType(
  type: IrNativeStructDef["abi"]["result"]["type"],
): IrNativeStructDef["abi"]["result"]["type"] {
  switch (type.kind) {
    case "array":
    case "vector":
      return { ...type, element: cloneNativePhysicalAbiType(type.element) };
    case "struct":
      return { ...type, fields: type.fields.map(cloneNativePhysicalAbiType) };
    default:
      return { ...type };
  }
}

function cloneNativePhysicalAbiValue(
  value: IrNativeStructDef["abi"]["result"],
): IrNativeStructDef["abi"]["result"] {
  return { ...value, type: cloneNativePhysicalAbiType(value.type) };
}

/** Opaque handles can only originate at a native ownership boundary. An
 * assertion may preserve an already-identical handle type, but can never
 * manufacture or reinterpret a foreign reference. */
export function lowerNativeHandleAssertion(
  L: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  target: IrNativeHandleType,
): IrExpr {
  const source = L.mapTypeOf(L.typeOf(expr.expression));
  if (source !== null && typeEquals(source, target)) return L.lowerExpr(expr.expression);
  L.pushDiag(
    nativeConversionDiag(
      target.typeId,
      "opaque native handles can only be returned by a configured native binding",
      locOf(expr),
    ),
  );
  throw new PoisonError();
}
