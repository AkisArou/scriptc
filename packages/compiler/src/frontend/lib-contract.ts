/* Library mode's contract-sidecar input: the ENTRY source file's exported
 * type declarations, exported function signatures, and the exported-const
 * contract conventions — all read from the SYNTAX TREE in statement order.
 * Declaration order is the ratified contract (the sidecar's field, member,
 * and arm orders are wire semantics), and the checker's property
 * enumeration hands back internal/sorted order, so the AST is the only
 * trustworthy order source; this module never touches the checker.
 *
 * The projection into the sidecar schema's closed vocabulary happens in
 * library/sidecar.ts; this module only captures syntactic shapes. The
 * exported-const conventions this module reads (the ratified ask-2
 * drafting item — under an embedder's profile a generated facade declares
 * these; authors declare nothing):
 *
 *   export const modelUnbound  = ["fieldOrHelper", ...] as const;
 *   export const msgUnbound    = ["arm", ...] as const;
 *   export const appearanceMsg = "arm";
 *   export const chromeMsg     = "arm";
 *   export const envMsgs       = [{ env: "NAME", msg: "arm" }, ...] as const;
 */
import * as ts from "./ts7/adapter.js";
import type { SrcLoc } from "../ir/nodes.js";

/** A syntactic type shape — exactly what the source spells, no checker. */
export type ContractTypeShape =
  | { k: "bool" }
  | { k: "number" }
  | { k: "text" }
  | { k: "bytes" }
  | { k: "void" }
  | { k: "absent" } // `null` / `undefined` type constituents
  | { k: "ref"; name: string }
  | { k: "array"; elem: ContractTypeShape }
  | { k: "tuple"; elems: ContractTypeShape[] }
  | { k: "object"; fields: ContractField[] }
  | { k: "stringLit"; text: string }
  | { k: "union"; parts: ContractTypeShape[] }
  | { k: "unsupported"; text: string };

export interface ContractField {
  name: string;
  optional: boolean;
  shape: ContractTypeShape;
  loc: SrcLoc;
}

export interface ContractTypeDecl {
  name: string;
  /** `interface` projects to a by-reference record; a type-alias object
   * literal to a by-value record; alias unions classify downstream. */
  form: "interface" | "alias";
  shape: ContractTypeShape;
  loc: SrcLoc;
}

export interface ContractFnDecl {
  name: string;
  params: { name: string; shape: ContractTypeShape | null }[];
  returns: ContractTypeShape | null;
  generic: boolean;
  loc: SrcLoc;
}

/** One recognized exported-const convention value; `malformed` carries the
 * reason when the initializer does not fit the convention's shape. */
export interface ContractConst<T> {
  value: T;
  loc: SrcLoc;
}

export interface ContractFacts {
  /** Exported interface/type-alias declarations, statement order. */
  types: ContractTypeDecl[];
  /** Exported function declarations, statement order. */
  functions: ContractFnDecl[];
  modelUnbound: ContractConst<string[]> | null;
  msgUnbound: ContractConst<string[]> | null;
  appearanceMsg: ContractConst<string> | null;
  chromeMsg: ContractConst<string> | null;
  envMsgs: ContractConst<{ env: string; msg: string }[]> | null;
  /** Convention-named consts whose initializers do not fit the expected
   * shape — refusals, never guesses. */
  malformedConsts: { name: string; detail: string; loc: SrcLoc }[];
}

const CONVENTION_CONSTS = new Set(["modelUnbound", "msgUnbound", "appearanceMsg", "chromeMsg", "envMsgs"]);

function locOf(file: ts.SourceFile, node: ts.Node): SrcLoc {
  return { file: file.fileName, start: node.getStart(), end: node.end };
}

function isExported(stmt: ts.Node): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function propName(name: ts.Node): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function shapeOfMembers(file: ts.SourceFile, members: readonly ts.Node[], onBad: (text: string) => void): ContractField[] {
  const fields: ContractField[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m)) {
      onBad("a non-property member (methods/index signatures have no contract projection)");
      continue;
    }
    const name = propName(m.name);
    if (name === null) {
      onBad("a computed property name");
      continue;
    }
    const shape = m.type !== undefined ? typeShape(file, m.type) : ({ k: "unsupported", text: "missing type annotation" } as const);
    fields.push({ name, optional: m.postfixToken?.kind === ts.SyntaxKind.QuestionToken, shape, loc: locOf(file, m) });
  }
  return fields;
}

/** The syntactic shape of a type node, over the closed vocabulary the
 * sidecar schema can express. Anything else lands as `unsupported` with
 * the source text preserved for the refusal message. */
export function typeShape(file: ts.SourceFile, node: ts.TypeNode): ContractTypeShape {
  switch (node.kind) {
    case ts.SyntaxKind.BooleanKeyword:
      return { k: "bool" };
    case ts.SyntaxKind.NumberKeyword:
      return { k: "number" };
    case ts.SyntaxKind.StringKeyword:
      return { k: "text" };
    case ts.SyntaxKind.VoidKeyword:
      return { k: "void" };
    case ts.SyntaxKind.UndefinedKeyword:
      return { k: "absent" };
    default:
      break;
  }
  if (ts.isParenthesizedTypeNode(node)) return typeShape(file, node.type);
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit)) return { k: "stringLit", text: lit.text };
    if (lit.kind === ts.SyntaxKind.NullKeyword) return { k: "absent" };
    return { k: "unsupported", text: node.getText(file) };
  }
  if (ts.isArrayTypeNode(node)) return { k: "array", elem: typeShape(file, node.elementType) };
  if (ts.isTupleTypeNode(node)) {
    const elems: ContractTypeShape[] = [];
    for (const e of node.elements) {
      // Named tuple members carry the type under `.type`.
      const t = ts.isNamedTupleMember(e) ? e.type : (e as ts.TypeNode);
      elems.push(typeShape(file, t));
    }
    return { k: "tuple", elems };
  }
  if (ts.isUnionTypeNode(node)) {
    return { k: "union", parts: node.types.map((t) => typeShape(file, t)) };
  }
  if (ts.isTypeLiteralNode(node)) {
    let bad: string | null = null;
    const fields = shapeOfMembers(file, node.members, (text) => {
      bad = text;
    });
    if (bad !== null) return { k: "unsupported", text: bad };
    return { k: "object", fields };
  }
  if (ts.isTypeReferenceNode(node)) {
    if (!ts.isIdentifier(node.typeName)) return { k: "unsupported", text: node.getText(file) };
    const name = node.typeName.text;
    if (name === "Uint8Array" && (node.typeArguments?.length ?? 0) === 0) return { k: "bytes" };
    if (name === "Array" && node.typeArguments?.length === 1) {
      return { k: "array", elem: typeShape(file, node.typeArguments[0]!) };
    }
    if ((node.typeArguments?.length ?? 0) > 0) return { k: "unsupported", text: node.getText(file) };
    return { k: "ref", name };
  }
  return { k: "unsupported", text: node.getText(file) };
}

/** Unwrap `expr as const` / parenthesized initializers. */
function unwrapConst(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

function stringArray(expr: ts.Expression): string[] | null {
  const e = unwrapConst(expr);
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: string[] = [];
  for (const el of e.elements) {
    const v = unwrapConst(el as ts.Expression);
    if (!ts.isStringLiteral(v)) return null;
    out.push(v.text);
  }
  return out;
}

function envMsgArray(expr: ts.Expression): { env: string; msg: string }[] | null {
  const e = unwrapConst(expr);
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: { env: string; msg: string }[] = [];
  for (const el of e.elements) {
    const v = unwrapConst(el as ts.Expression);
    if (!ts.isObjectLiteralExpression(v)) return null;
    let env: string | null = null;
    let msg: string | null = null;
    for (const prop of v.properties) {
      if (!ts.isPropertyAssignment(prop)) return null;
      const name = propName(prop.name);
      const val = unwrapConst(prop.initializer);
      if (!ts.isStringLiteral(val)) return null;
      if (name === "env") env = val.text;
      else if (name === "msg") msg = val.text;
      else return null;
    }
    if (env === null || msg === null) return null;
    out.push({ env, msg });
  }
  return out;
}

/** Everything the sidecar projection needs from the entry module's syntax
 * tree, in statement (declaration) order. Call before the frontend is
 * disposed. */
export function entryContractFacts(entry: ts.SourceFile): ContractFacts {
  const facts: ContractFacts = {
    types: [],
    functions: [],
    modelUnbound: null,
    msgUnbound: null,
    appearanceMsg: null,
    chromeMsg: null,
    envMsgs: null,
    malformedConsts: [],
  };
  for (const stmt of entry.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      if (!isExported(stmt)) continue;
      let bad: string | null = null;
      const fields = shapeOfMembers(entry, stmt.members, (text) => {
        bad = text;
      });
      const generic = (stmt.typeParameters?.length ?? 0) > 0;
      const heritage = (stmt.heritageClauses?.length ?? 0) > 0;
      facts.types.push({
        name: stmt.name.text,
        form: "interface",
        shape:
          bad !== null
            ? { k: "unsupported", text: bad }
            : generic
              ? { k: "unsupported", text: "a generic interface" }
              : heritage
                ? { k: "unsupported", text: "an interface with heritage clauses" }
                : { k: "object", fields },
        loc: locOf(entry, stmt),
      });
      continue;
    }
    if (ts.isTypeAliasDeclaration(stmt)) {
      if (!isExported(stmt)) continue;
      const generic = (stmt.typeParameters?.length ?? 0) > 0;
      facts.types.push({
        name: stmt.name.text,
        form: "alias",
        shape: generic ? { k: "unsupported", text: "a generic type alias" } : typeShape(entry, stmt.type),
        loc: locOf(entry, stmt),
      });
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      if (!isExported(stmt)) continue;
      if (stmt.body === undefined && facts.functions.some((f) => f.name === stmt.name!.text)) continue; // overload signature
      facts.functions.push({
        name: stmt.name.text,
        params: stmt.parameters.map((p) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : "<pattern>",
          shape: p.type !== undefined ? typeShape(entry, p.type) : null,
        })),
        returns: stmt.type !== undefined ? typeShape(entry, stmt.type) : null,
        generic: (stmt.typeParameters?.length ?? 0) > 0,
        loc: locOf(entry, stmt),
      });
      continue;
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (!CONVENTION_CONSTS.has(name)) continue;
        const loc = locOf(entry, decl);
        if (decl.initializer === undefined) {
          facts.malformedConsts.push({ name, detail: "has no initializer", loc });
          continue;
        }
        if (name === "appearanceMsg" || name === "chromeMsg") {
          const v = unwrapConst(decl.initializer);
          if (!ts.isStringLiteral(v)) {
            facts.malformedConsts.push({ name, detail: "must be a string literal naming a msg arm", loc });
            continue;
          }
          facts[name] = { value: v.text, loc };
          continue;
        }
        if (name === "envMsgs") {
          const v = envMsgArray(decl.initializer);
          if (v === null) {
            facts.malformedConsts.push({
              name,
              detail: 'must be an array of { env: "NAME", msg: "arm" } object literals with string-literal values',
              loc,
            });
            continue;
          }
          facts.envMsgs = { value: v, loc };
          continue;
        }
        const v = stringArray(decl.initializer);
        if (v === null) {
          facts.malformedConsts.push({ name, detail: "must be an array of string literals", loc });
          continue;
        }
        facts[name === "modelUnbound" ? "modelUnbound" : "msgUnbound"] = { value: v, loc };
      }
    }
  }
  return facts;
}
