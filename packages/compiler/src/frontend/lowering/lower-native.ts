import { resolve } from "node:path";
import { nativeBindingDiag, nativeConversionDiag, nativeSignatureDiag } from "../../diagnostics/diagnostic.js";
import type { IrExpr, IrNativeBinding, IrNativeScalarType, SrcLoc } from "../../ir/nodes.js";
import { typeEquals } from "../../ir/nodes.js";
import type { NativeFrontendInput } from "../native.js";
import { locOf } from "../program.js";
import { tsgoPath } from "../shared.js";
import * as ts from "../ts7/adapter.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

export type NativeInputBinding = NativeFrontendInput["bindings"][number];

export interface ResolvedNativeFrontend {
  readonly typesBySymbol: ReadonlyMap<ts.Symbol, IrNativeScalarType>;
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
  let symbol = moduleSymbol?.getExports().get(declaration.name as ts.__String);
  if (symbol === undefined) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = L.checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Resolve embedder declaration identities once per lowering pass. Exact
 * checker symbol identity is the only recognition key used later. Missing
 * entries remain inert until source reaches a value that requires them. */
export function resolveNativeFrontend(
  L: Lowerer,
  input: NativeFrontendInput | undefined,
): ResolvedNativeFrontend {
  const typesBySymbol = new Map<ts.Symbol, IrNativeScalarType>();
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
  return { typesBySymbol, bindingsBySymbol };
}

export function nativeTypeOf(
  L: Lowerer,
  type: ts.Type,
): IrNativeScalarType | null {
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
  const functions = declarations.filter(ts.isFunctionDeclaration);
  if (
    functions.length === 0 ||
    declarations.some((declaration) => !ts.isFunctionDeclaration(declaration)) ||
    functions.some((declaration) => declaration.body !== undefined)
  ) {
    failBinding(
      L,
      binding,
      "the configured declaration does not resolve exclusively to signature-only function declarations",
      loc,
    );
  }
  if (functions.some((declaration) => (declaration.typeParameters?.length ?? 0) > 0)) {
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
  if (parameters.length !== binding.parameters.length) {
    failSignature(
      L,
      binding,
      `the declaration has ${parameters.length} parameter(s), but Native IR requires ${binding.parameters.length}`,
      loc,
    );
  }
  for (let index = 0; index < parameters.length; index++) {
    const sourceType = L.checker.getTypeOfSymbol(parameters[index]!);
    if (sourceType.flags & ts.TypeFlags.Never) {
      failSignature(L, binding, `parameter ${index + 1} is 'never'`, loc);
    }
    const mapped = L.mapTypeOf(sourceType);
    const expected = binding.parameters[index]!.type;
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
    failSignature(L, binding, "the return type is 'never', but the native call may return", loc);
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
  if (!ts.isIdentifier(expr.expression)) return null;
  const symbol = L.resolveValueSymbol(expr.expression);
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
  if (expr.arguments.length !== binding.parameters.length) {
    failSignature(
      L,
      binding,
      `this call passes ${expr.arguments.length} argument(s), but Native IR requires exactly ${binding.parameters.length}`,
      loc,
    );
  }
  const args = expr.arguments.map((argument, index) =>
    L.lowerExprExpecting(argument, binding.parameters[index]!.type)
  );
  L.usedNativeBindingIds.add(binding.id);
  return {
    kind: "nativeCall",
    binding: binding.id,
    args,
    type: { ...binding.result.type },
    loc,
  };
}

function decimalI32Literal(node: ts.Expression): string | null {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  let negative = false;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    negative = expression.operator === ts.SyntaxKind.MinusToken;
    expression = expression.operand;
  }
  if (!ts.isNumericLiteral(expression) || !/^[0-9]+$/.test(expression.text)) return null;
  const value = BigInt(`${negative ? "-" : ""}${expression.text}`);
  if (value < -2147483648n || value > 2147483647n) return null;
  return value.toString();
}

/** Exact-scalar assertions are representation constructors, not erased
 * JavaScript casts. The initial i32 slice accepts a provably in-range
 * decimal literal or a value already carrying exact i32. */
export function lowerNativeScalarAssertion(
  L: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  target: IrNativeScalarType,
): IrExpr {
  const source = L.mapTypeOf(L.typeOf(expr.expression));
  if (source !== null && typeEquals(source, target)) return L.lowerExpr(expr.expression);
  const value = target.scalar === "i32" ? decimalI32Literal(expr.expression) : null;
  if (value === null) {
    L.pushDiag(
      nativeConversionDiag(
        target.scalar,
        "the source is not a provably in-range decimal integer literal or the same exact type",
        locOf(expr),
      ),
    );
    throw new PoisonError();
  }
  return { kind: "nativeScalarLit", value, type: { ...target }, loc: locOf(expr) };
}

export function materializeNativeBinding(binding: NativeInputBinding): IrNativeBinding {
  return {
    id: binding.id,
    declaration: { ...binding.declaration },
    entry: { ...binding.entry },
    callingConvention: binding.callingConvention,
    variadic: false,
    parameters: binding.parameters.map((parameter) => ({
      name: parameter.name,
      type: { ...parameter.type },
      passMode: "value",
    })),
    result: { type: { ...binding.result.type }, passMode: "value" },
  };
}
