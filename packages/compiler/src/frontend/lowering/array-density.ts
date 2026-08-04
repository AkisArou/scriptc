import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";

/** A hole can be read as JavaScript undefined only when the element slot has
 * an actual undefined value. */
export function arrayElementCanRepresentUndefined(L: Lowerer, elem: IrType): boolean {
  if (elem.kind === "jsval" || elem.kind === "dyn" || elem.kind === "undefinedT") return true;
  return elem.kind === "union" &&
    (L.unions.get(elem.unionId)?.arms.some((arm) => arm.kind === "undefinedT") ?? false);
}

export function requireArrayGetSafe(
  L: Lowerer,
  source: ts.Expression,
  elem: IrType,
  blame: ts.Node,
  construct: string,
): void {
  if (arrayElementCanRepresentUndefined(L, elem) || !arrayExprIsProvablySparse(L, source)) return;
  L.unsupported(
    "SC1090",
    blame,
    `${construct} on a sparse '${L.fmt({ kind: "array", elem })}' value ` +
      `(a hole must be observed as undefined, which '${L.fmt(elem)}' element slots cannot represent - ` +
      "use an undefined-capable element type or a dense array)",
  );
}

function stripWrappers(expr: ts.Expression): ts.Expression {
  let value = expr;
  while (
    ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value) ||
    ts.isAsExpression(value) || ts.isTypeAssertion(value) || ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isWriteTarget(node: ts.Expression): boolean {
  let value = node;
  let parent = value.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) || ts.isTypeAssertion(parent) || ts.isSatisfiesExpression(parent))
  ) {
    value = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isDeleteExpression(parent) && parent.expression === value) return true;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === value &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  return ts.isBinaryExpression(parent) && parent.left === value && isAssignmentOperator(parent.operatorToken.kind);
}

const READ_ONLY_ARRAY_METHODS = new Set([
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast",
  "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys",
  "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "toReversed", "toSorted",
  "toSpliced", "values", "with",
]);

function symbolUsePreservesSparsity(L: Lowerer, node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent)) && parent.name === node
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    if (isWriteTarget(parent)) return false;
    if (parent.name.text === "length") return true;
    return ts.isCallExpression(parent.parent) && parent.parent.expression === parent &&
      READ_ONLY_ARRAY_METHODS.has(parent.name.text);
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    return !isWriteTarget(parent);
  }
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.expression === node) return true;
  if (ts.isSpreadElement(parent) && parent.expression === node) return true;
  if (ts.isBinaryExpression(parent)) {
    if (parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) return true;
    return !isAssignmentOperator(parent.operatorToken.kind) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);
  }
  return parent.kind === ts.SyntaxKind.TypeQuery;
}

function symbolUsesPreserveSparsity(
  L: Lowerer,
  symbol: ts.Symbol,
  file: ts.SourceFile,
  before: number,
): boolean {
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (
      ts.isIdentifier(node) && node.pos < before &&
      node.text === symbol.name && L.resolveValueSymbol(node) === symbol
    ) {
      safe = symbolUsePreservesSparsity(L, node);
      if (!safe) return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return safe;
}

function isSparseArrayInitializer(L: Lowerer, source: ts.Expression): boolean {
  const value = stripWrappers(source);
  if (ts.isArrayLiteralExpression(value)) return value.elements.some(ts.isOmittedExpression);
  if (!ts.isCallExpression(value) && !ts.isNewExpression(value)) return false;
  const callee = value.expression;
  if (
    !ts.isIdentifier(callee) || callee.text !== "Array" ||
    !L.isStdlibSymbol(L.resolveValueSymbol(callee) ?? undefined)
  ) {
    return false;
  }
  const args = value.arguments ?? [];
  if (args.length !== 1) return false;
  const length = stripWrappers(args[0]!);
  return ts.isNumericLiteral(length) && Number.isInteger(Number(length.text)) && Number(length.text) > 0;
}

/** Prove only the narrow case needed to fence unrepresentable hole reads.
 * Unknown provenance deliberately keeps the historical lowering behavior. */
function arrayExprIsProvablySparse(L: Lowerer, source: ts.Expression): boolean {
  const value = stripWrappers(source);
  if (isSparseArrayInitializer(L, value)) return true;
  if (!ts.isIdentifier(value)) return false;
  const symbol = L.resolveValueSymbol(value);
  if (!symbol) return false;
  const declarations = L.checker.declarationsOf(symbol);
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const list = declaration.parent;
  const statement = list.parent;
  if (
    !ts.isVariableDeclarationList(list) || list.declarations.length !== 1 ||
    !ts.isVariableStatement(statement) ||
    (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0 ||
    declaration.end > value.pos || !isSparseArrayInitializer(L, declaration.initializer)
  ) {
    return false;
  }
  return symbolUsesPreserveSparsity(L, symbol, declaration.getSourceFile(), value.pos);
}
