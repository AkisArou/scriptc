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
  readonly bindingsBySymbol: ReadonlyMap<ts.Symbol, NativeInputBinding>;
}

function declarationSymbol(
  L: Lowerer,
  declaration: { readonly module: string; readonly name: string },
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
  for (const member of members) {
    symbol = L.checker
      .getPropertiesOfType(L.checker.getDeclaredTypeOfSymbol(symbol))
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
  const bindingsBySymbol = new Map<ts.Symbol, NativeInputBinding>();
  for (const sourceType of input?.sourceTypes ?? []) {
    const symbol = declarationSymbol(L, sourceType.declaration);
    if (symbol !== null) {
      const type = { ...sourceType.type };
      typesBySymbol.set(symbol, type);
    }
  }
  for (const binding of input?.bindings ?? []) {
    const symbol = declarationSymbol(L, binding.declaration);
    if (symbol !== null) bindingsBySymbol.set(symbol, binding);
  }
  return { typesBySymbol, typeDefsById, bindingsBySymbol };
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

function validateDeclaration(
  L: Lowerer,
  binding: NativeInputBinding,
  symbol: ts.Symbol,
  loc: SrcLoc,
): void {
  const declarations = L.checker.declarationsOf(symbol);
  const declarationGuard = (
    declaration: ts.Node,
  ): declaration is ts.FunctionDeclaration | ts.MethodSignature =>
    binding.sourceCall.kind === "function"
      ? ts.isFunctionDeclaration(declaration)
      : declaration.kind === ts.SyntaxKind.MethodSignature;
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
  if (callDeclarations.some((declaration) => (declaration.typeParameters?.length ?? 0) > 0)) {
    failSignature(L, binding, "generic declarations cannot describe one fixed native ABI", loc);
  }
  const signatures = L.checker.getCallSignatures(L.checker.getTypeOfSymbol(symbol));
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
      binding.sourceCall.kind !== "method" || index !== binding.sourceCall.receiverArgument,
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
  if (mappedResult === null || !typeEquals(mappedResult, binding.result.type)) {
    failSignature(
      L,
      binding,
      `the return maps to '${mappedResult === null ? L.checker.typeToString(sourceResult) : L.fmt(mappedResult)}', ` +
        `not '${L.fmt(binding.result.type)}'`,
      loc,
    );
  }
}

/** Lower one direct call of an exact checker-owned native declaration. */
export function lowerNativeCall(L: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  const symbol = ts.isIdentifier(callee)
    ? L.resolveValueSymbol(callee)
    : ts.isPropertyAccessExpression(callee)
      ? L.checker.getSymbolAtLocation(callee.name) ?? null
      : null;
  if (symbol === null) return null;
  const binding = L.nativeBindingsBySymbol.get(symbol);
  if (binding === undefined) return null;
  const loc = locOf(expr);
  if (!L.validatedNativeBindingSymbols.has(symbol)) {
    validateDeclaration(L, binding, symbol, loc);
    L.validatedNativeBindingSymbols.add(symbol);
  }
  if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined) {
    failSignature(L, binding, "only direct, non-generic calls are supported", loc);
  }
  if (expr.arguments.some(ts.isSpreadElement)) {
    failSignature(L, binding, "spread arguments do not have a fixed native ABI", loc);
  }
  if (
    (binding.sourceCall.kind === "function" && !ts.isIdentifier(callee)) ||
    (binding.sourceCall.kind === "method" && !ts.isPropertyAccessExpression(callee))
  ) {
    failBinding(L, binding, `the source call is not a ${binding.sourceCall.kind}`, loc);
  }
  const sourceParameterCount = binding.arguments.length -
    (binding.sourceCall.kind === "method" ? 1 : 0);
  if (expr.arguments.length !== sourceParameterCount) {
    failSignature(
      L,
      binding,
      `this call passes ${expr.arguments.length} explicit argument(s), but Native IR requires exactly ${sourceParameterCount}`,
      loc,
    );
  }
  const argumentNodes = [...expr.arguments];
  if (binding.sourceCall.kind === "method") {
    if (
      binding.sourceCall.receiverArgument < 0 ||
      binding.sourceCall.receiverArgument >= binding.arguments.length
    ) {
      failBinding(L, binding, "the method receiver argument index is outside the logical argument list", loc);
    }
    argumentNodes.splice(binding.sourceCall.receiverArgument, 0, (callee as ts.PropertyAccessExpression).expression);
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
    if (argument.type.kind === "nativeStruct" || argument.type.kind === "nativeHandle") {
      L.usedNativeTypeIds.add(argument.type.typeId);
    }
  }
  if (binding.result.type.kind === "nativeStruct" || binding.result.type.kind === "nativeHandle") {
    L.usedNativeTypeIds.add(binding.result.type.typeId);
  }
  return {
    kind: "nativeCall",
    binding: binding.id,
    args,
    type: { ...binding.result.type },
    loc,
  };
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
  L.usedNativeTypeIds.add(target.typeId);
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
  L.usedNativeTypeIds.add(target.typeId);
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
    };
  }
  return {
    ...contract,
    registrationOwner: { kind: "result" },
    allowedInvocationExecutors: [...contract.allowedInvocationExecutors],
    transports: contract.transports.map(() => ({ kind: "copy" })),
  };
}

export function materializeNativeType(
  definition: NativeFrontendInput["types"][number],
): IrNativeTypeDef {
  if (definition.kind === "handle") {
    const result: IrNativeHandleDef = {
      ...definition,
      declaration: { ...definition.declaration },
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
