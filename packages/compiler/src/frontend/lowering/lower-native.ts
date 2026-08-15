import { resolve } from "node:path";
import { nativeBindingDiag, nativeConversionDiag, nativeSignatureDiag } from "../../diagnostics/diagnostic.js";
import type {
  IrExpr,
  IrNativeBinding,
  IrNativeCallbackContract,
  IrNativeHandleDef,
  IrNativeHandleType,
  IrNativeScalarType,
  IrNativeStructType,
  IrNativeTypeDef,
  IrNativeValueType,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
import { nativeIntegerInfo, typeEquals } from "../../ir/nodes.js";
import type { NativeFrontendInput } from "../native.js";
import { locOf } from "../program.js";
import { tsgoPath } from "../shared.js";
import * as ts from "../ts7/adapter.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

export type NativeInputBinding = NativeFrontendInput["bindings"][number];

export interface ResolvedNativeFrontend {
  readonly typesBySymbol: ReadonlyMap<ts.Symbol, IrNativeValueType>;
  readonly typeDefsById: ReadonlyMap<string, NativeFrontendInput["types"][number]>;
  readonly bindingsBySymbol: ReadonlyMap<ts.Symbol, readonly NativeInputBinding[]>;
  readonly bindingsByDeclaration: ReadonlyMap<ts.Node, readonly NativeInputBinding[]>;
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
  for (const sourceType of input?.sourceTypes ?? []) {
    const symbol = declarationSymbol(L, sourceType.declaration);
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
  return { typesBySymbol, typeDefsById, bindingsBySymbol, bindingsByDeclaration };
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
  if (!binding.result.projection.nullable) return mapped.kind === "string";
  if (mapped.kind !== "union") return false;
  const arms = L.unions.get(mapped.unionId)?.arms;
  return arms?.length === 2 &&
    arms.some((arm) => arm.kind === "string") &&
    arms.some((arm) => arm.kind === "nullT");
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
  const callDeclarations = declarations.filter(declarationGuard);
  if (
    callDeclarations.length === 0 ||
    declarations.some((declaration) => !declarationGuard(declaration)) ||
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
    if (mapped === null || !typeEquals(mapped, expected)) {
      failSignature(
        L,
        binding,
        `the setter value maps to '${mapped === null ? L.checker.typeToString(sourceType) : L.fmt(mapped)}', not '${L.fmt(expected)}'`,
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
    if (mapped === null || !typeEquals(mapped, expected)) {
      failSignature(
        L,
        binding,
        `parameter ${index + 1} maps to '${mapped === null ? L.checker.typeToString(sourceType) : L.fmt(mapped)}', ` +
          `not '${L.fmt(expected)}'`,
        loc,
      );
    }
  }
  const sourceResult = L.checker.getReturnTypeOfSignature(signature);
  if (sourceResult.flags & ts.TypeFlags.Never) {
    if (binding.error.kind === "no-fail") {
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
  const args = argumentNodes.map((argument, index) =>
    L.lowerExprExpecting(argument, binding.arguments[index]!.type)
  );
  L.usesNativeTarget = true;
  L.usedNativeBindingIds.add(binding.id);
  if (binding.result.ownership.kind === "owned") {
    L.usedNativeBindingIds.add(binding.result.ownership.destructor);
  }
  for (const argument of binding.arguments) {
    if (argument.callback?.lifetime === "until-cancelled") {
      L.usedNativeBindingIds.add(argument.callback.cancellationBinding);
    }
  }
  for (const argument of binding.arguments) {
    if (argument.type.kind === "nativeStruct" || argument.type.kind === "nativeHandle") {
      L.useNativeType(argument.type.typeId);
    }
  }
  if (binding.result.type.kind === "nativeStruct" || binding.result.type.kind === "nativeHandle") {
    L.useNativeType(binding.result.type.typeId);
  }
  const mappedResult = sourceResult === null ? null : L.mapTypeOf(sourceResult);
  const resultType: IrType = sourceResult === null
    ? binding.result.type.kind === "void" && binding.result.projection.kind === "direct"
      ? { kind: "void" }
      : failBinding(L, binding, "a native setter must have a direct void result", loc)
    : sourceResult.flags & ts.TypeFlags.Never
    ? binding.error.kind !== "no-fail" &&
        binding.result.projection.kind === "direct" &&
        binding.result.type.kind !== "nativePointer"
      ? { ...binding.result.type }
      : failBinding(L, binding, "a non-failing native call cannot produce 'never'", loc)
    : mappedResult !== null && matchesNativeResultSource(L, binding, mappedResult)
      ? mappedResult
      : failBinding(L, binding, "the validated declaration lost its source result type", loc);
  return {
    kind: "nativeCall",
    binding: binding.id,
    args,
    type: { ...resultType },
    loc,
  };
}

/** Lower one direct call of an exact checker-owned native declaration. */
export function lowerNativeCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  const symbol = nativeExpressionSymbol(L, callee);
  if (symbol === null) return null;
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
    const operation = arithmeticExpression.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? "+"
      : arithmeticExpression.operatorToken.kind === ts.SyntaxKind.MinusToken
        ? "-"
        : arithmeticExpression.operatorToken.kind === ts.SyntaxKind.AsteriskToken
          ? "*"
          : null;
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
          : "the source is not a provably in-range decimal number literal, same exact type, or same-type exact integer +, -, or * expression",
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
  const fields = [...initializers].map(([name, initializer]) => ({
    name,
    value: L.lowerExprExpecting(initializer, expectedFields.get(name)!.type),
  }));
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
    type: { ...field.type },
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
    entry: { ...binding.entry },
    callingConvention: binding.callingConvention,
    variadic: false,
    error: { ...binding.error },
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
    },
  };
}

function materializeNativeCallbackContract(
  contract: Readonly<IrNativeCallbackContract>,
): IrNativeCallbackContract {
  if (contract.lifetime === "call") {
    return {
      ...contract,
      registrationOwner: { kind: "native-call" },
      allowedInvocationExecutors: ["same-as-caller"],
      transports: contract.transports.map(() => ({ kind: "borrow" })),
      sourceArguments: contract.sourceArguments.map((argument) => ({ ...argument })),
    };
  }
  return {
    ...contract,
    registrationOwner: { ...contract.registrationOwner },
    allowedInvocationExecutors: [...contract.allowedInvocationExecutors],
    transports: contract.transports.map(() => ({ kind: "copy" })),
    sourceArguments: contract.sourceArguments.map((argument) => ({ ...argument })),
  };
}

export function materializeNativeType(
  definition: NativeFrontendInput["types"][number],
): IrNativeTypeDef {
  if (definition.kind === "handle") {
    const result: IrNativeHandleDef = {
      ...definition,
      declaration: { ...definition.declaration },
      upcasts: definition.upcasts.map((upcast) => ({ ...upcast })),
    };
    return result;
  }
  return {
    ...definition,
    declaration: { ...definition.declaration },
    abi: { ...definition.abi },
    fields: definition.fields.map((field) => ({
      ...field,
      type: { ...field.type },
    })),
  };
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
