/* --npm-static's bundler-emitted-CJS export surface: the getter-table
 * shapes. A bundler-emitted CJS dist exports through runtime plumbing the
 * checker cannot model — the `__export(target, { name: () => value, ... })`
 * getter table behind `module.exports = __toCommonJS(target)`, the
 * `Object.defineProperty(exports, 'n', { get })` family, and the
 * transpiler star re-exports (`__exportStar(require('./x'), exports)`,
 * `__reExport(target, require('./x'), module.exports)`). Node's CJS lexer
 * SEES those named exports (cjs-lexer.ts mirrors it exactly), so named
 * imports link under Node — but the inferred surface the opted-in
 * resolution feeds the checker is an opaque object, and every import site
 * reports "X has no exported member" (the SC0001 storm that used to gate
 * the whole build).
 *
 * THE REWRITE. For an opted-in package's CJS file whose exports come from
 * these shapes, the fs shadow (npm-static.ts) serves BOTH worlds — the
 * checker and the lowering ride one program — a text rewrite that spells
 * the same export surface in the plain CJS the whole existing machinery
 * already models:
 *
 *   - the recognized plumbing statements are SPACE-PADDED in place
 *     (newlines kept, so every original line/offset survives): the
 *     `module.exports = __toCommonJS(target)` assignment, the
 *     `__export(target, {...})` call, the star-pattern calls, the
 *     recognized defineProperty exports, and the dead esbuild annotation
 *     `0 && (module.exports = {...})` (left live it poisons the checker's
 *     alias resolution — multiple module.exports assignments make import
 *     aliases land on properties no lowering path resolves);
 *   - one canonical export table is APPENDED at the tail:
 *     `module.exports = { ...require("./star"), own: local, ... };`
 *     Each getter body the chase can follow types the export by its
 *     resolved VALUE (`() => localBinding` resolves to the binding's
 *     inferred type; member chains and scalar literals hoist to a tail
 *     const first), and every lexer-visible name the chase cannot follow
 *     falls back to a checked-dynamic `any` binding (value undefined —
 *     exactly what Node's import binds for a lexer-visible name the
 *     runtime export object never carries).
 *
 * LEXER PARITY IS THE CONTRACT: the rewritten text must answer the SAME
 * name set to cjs-lexer.ts that the original answers to Node — named
 * imports must link exactly where Node's would. The table is formatted
 * for merve's byte rules (`name: IDENT,` — value ident runs directly
 * followed by ','), star re-exports ride spread entries (recorded as
 * reexports and resolved recursively, exactly Node's union), and the
 * esbuild `__esModule: !0` marker is spelled as a deliberate SCAN STOPPER
 * so it stays lexer-invisible (Node never lexes __esModule out of
 * __toCommonJS) while member-access star entries after it are covered by
 * the spread records.
 *
 * SNAPSHOT SEMANTICS (the documented divergence): the getter table reads
 * its locals LIVE at every access; the canonical table captures values
 * ONCE, at module tail — after every top-level statement ran, so ordinary
 * modules see identical values, and only post-evaluation reassignment of
 * an exported local (the lazy-cache counter idiom) can diverge. Star
 * re-export targets load at module tail instead of their original
 * statement positions (visible only to load-order-sensitive side
 * effects). Node's __esModule marker survives on the rewritten object.
 *
 * Everything here is SYNTACTIC (typescript5 world, the cjs-lexer's
 * sanctioned island): the chase decides only what TEXT to emit — the
 * checker then infers the types from the emitted spellings. A file whose
 * export mechanism the recognizers cannot fully account for is left
 * untouched (null): its import-site errors stay, and the frontend's
 * offender attribution degrades the PACKAGE to the island with a note. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import ts from "typescript5";
import { cjsLexedExportsOf, cjsLexerVisibleNames } from "./cjs-lexer.js";

/** True when `e` is exactly the `exports` identifier. */
function isExportsIdent(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && e.text === "exports";
}

/** True when `e` is exactly `module.exports`. */
function isModuleExports(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    e.questionDotToken === undefined &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "module" &&
    ts.isIdentifier(e.name) &&
    e.name.text === "exports"
  );
}

/** The bare `require('spec')` call (identifier callee, one string arg). */
function bareRequireSpecOf(e: ts.Expression): string | null {
  if (!ts.isCallExpression(e) || e.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(e.expression) || e.expression.text !== "require") return null;
  if (e.arguments.length !== 1) return null;
  const arg = e.arguments[0]!;
  return ts.isStringLiteral(arg) ? arg.text : null;
}

/** The last NAME of a callee: bare identifier or any member chain's final
 * name (`tslib_1.__exportStar` → "__exportStar"). */
function calleeNameOf(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

/** An entry the canonical table can carry. */
interface EntrySpec {
  /** The export name (may need string-key spelling). */
  name: string;
  /** "ident": VALUE is a plain identifier spelled directly in the table.
   * "hoist": VALUE is an expression text hoisted to a tail const first.
   * "any": the checked-dynamic fallback (`__scriptc_any`). */
  kind: "ident" | "hoist" | "any";
  value?: string;
}

/** A chaseable getter/descriptor VALUE: a plain identifier, an
 * identifier-rooted member/element chain (string keys only), or a scalar
 * literal. Answers the classification or null (not chaseable). */
function chaseValue(e: ts.Expression): { kind: "ident" | "hoist"; text: string } | null {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  if (ts.isIdentifier(cur)) return { kind: "ident", text: cur.text };
  if (
    ts.isNumericLiteral(cur) ||
    ts.isStringLiteral(cur) ||
    ts.isNoSubstitutionTemplateLiteral(cur) ||
    cur.kind === ts.SyntaxKind.TrueKeyword ||
    cur.kind === ts.SyntaxKind.FalseKeyword ||
    cur.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { kind: "hoist", text: cur.getText() };
  }
  // ident-rooted member chains: this.x / a.b.c / a["k"].d — side-effect
  // free reads the tail const can evaluate once.
  let walk: ts.Expression = cur;
  while (
    (ts.isPropertyAccessExpression(walk) && walk.questionDotToken === undefined && ts.isIdentifier(walk.name)) ||
    (ts.isElementAccessExpression(walk) && walk.questionDotToken === undefined && ts.isStringLiteral(walk.argumentExpression))
  ) {
    walk = walk.expression;
  }
  if (ts.isIdentifier(walk)) return { kind: "hoist", text: cur.getText() };
  return null;
}

/** The getter body's returned expression for the two descriptor getter
 * spellings (`get() { return X }` / `get: function () { return X }`) and
 * the arrow forms the esbuild table uses (`() => X`, `() => { return X }`). */
function getterReturnOf(fn: ts.Node): ts.Expression | null {
  let body: ts.ConciseBody | undefined;
  if (ts.isArrowFunction(fn) && fn.parameters.length === 0) body = fn.body;
  else if (ts.isFunctionExpression(fn) && fn.parameters.length === 0) body = fn.body;
  else if (ts.isMethodDeclaration(fn) && fn.parameters.length === 0 && fn.body !== undefined) body = fn.body;
  else return null;
  if (body === undefined) return null;
  if (!ts.isBlock(body)) return body; // expression-bodied arrow
  if (body.statements.length !== 1) return null;
  const ret = body.statements[0]!;
  return ts.isReturnStatement(ret) && ret.expression !== undefined ? ret.expression : null;
}

/** The `__export(IDENT, { name: () => value, ... })` call's parts, or null.
 * Every property must be a `name: <function>` assignment (identifier or
 * string-literal name) — anything else is not the esbuild table. */
function exportCallOf(call: ts.CallExpression): { target: string; entries: [string, ts.Expression | null][] } | null {
  if (calleeNameOf(call) !== "__export") return null;
  if (call.arguments.length !== 2) return null;
  const [target, table] = call.arguments as unknown as [ts.Expression, ts.Expression];
  if (!ts.isIdentifier(target) || !ts.isObjectLiteralExpression(table)) return null;
  const entries: [string, ts.Expression | null][] = [];
  for (const prop of table.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    let name: string;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    else return null;
    entries.push([name, getterReturnOf(prop.initializer)]);
  }
  return { target: target.text, entries };
}

/** `Object.defineProperty(exports|module.exports, 'name', {...})` — the
 * name plus the chased descriptor value (getter return or `value:`), or
 * null when the statement is not that shape at all. `value: null` means
 * recognized but unchaseable. */
function definePropertyExportOf(
  call: ts.CallExpression,
): { name: string; value: ts.Expression | null; esModuleStamp: boolean } | null {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "defineProperty"
  ) {
    return null;
  }
  if (call.arguments.length !== 3) return null;
  const [recv, nameArg, desc] = call.arguments as unknown as [ts.Expression, ts.Expression, ts.Expression];
  if (!isExportsIdent(recv) && !isModuleExports(recv)) return null;
  if (!ts.isStringLiteral(nameArg) || !ts.isObjectLiteralExpression(desc)) return null;
  const name = nameArg.text;
  let value: ts.Expression | null = null;
  for (const p of desc.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      if (p.name.text === "value") value = p.initializer;
      else if (p.name.text === "get") value = getterReturnOf(p.initializer);
    } else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === "get") {
      value = getterReturnOf(p);
    }
  }
  const esModuleStamp =
    name === "__esModule" && value !== null && value.kind === ts.SyntaxKind.TrueKeyword;
  return { name, value, esModuleStamp };
}

/** Resolves a RELATIVE CJS require target with Node's file-first probes
 * (the dist-tree subset: exact, .js/.cjs, /index.js, package.json "main"
 * for directories). Bare specifiers answer null — their names ride the
 * spread entry and the program resolver. */
function resolveRelativeCjs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = resolvePath(dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.cjs`];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile() && /\.(js|cjs)$/.test(c)) return c;
    } catch {
      /* keep probing */
    }
  }
  try {
    if (existsSync(base) && statSync(base).isDirectory()) {
      const pkgPath = resolvePath(base, "package.json");
      if (existsSync(pkgPath)) {
        const main = (JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: unknown }).main;
        if (typeof main === "string") {
          const m = resolvePath(base, main);
          for (const c of [m, `${m}.js`, `${m}.cjs`, resolvePath(m, "index.js")]) {
            if (existsSync(c) && statSync(c).isFile() && /\.(js|cjs)$/.test(c)) return c;
          }
        }
      }
      const idx = resolvePath(base, "index.js");
      if (existsSync(idx)) return idx;
    }
  } catch {
    /* unresolved */
  }
  return null;
}

/** The Node-visible named-export set of a star-re-export TARGET file:
 * its recursive lexer-visible names (relative edges only — exactly what
 * the emitted member entries must enumerate). */
function starTargetNames(file: string): Set<string> {
  try {
    return cjsLexerVisibleNames(
      file,
      (f) => readFileSync(f, "utf8"),
      (from, spec) => resolveRelativeCjs(from, spec),
    );
  } catch {
    return new Set();
  }
}

/** Space-pads [start, end) of `text` preserving newlines — the recognized
 * statement disappears while every original offset survives. */
function padSpan(text: string, start: number, end: number): string {
  let pad = "";
  for (let i = start; i < end; i++) pad += text[i] === "\n" ? "\n" : " ";
  return text.slice(0, start) + pad + text.slice(end);
}

/** A valid identifier-run export name (the table can spell it bare). */
function isPlainName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

const RESERVED_KEYS = new Set(["__proto__"]);

/** The rewrite (see the header). Null = not a recognized bundle shape (or
 * nothing to fix) — serve the file untouched. */
export function rewriteBundlerCjsExports(source: string, filePath: string): string | null {
  // Cheap gates before any parse: CJS bundle plumbing leaves textual
  // fingerprints; files without any are never candidates.
  if (
    !source.includes("__toCommonJS") &&
    !source.includes("__exportStar") &&
    !source.includes("__reExport") &&
    !(source.includes("Object.defineProperty(exports") && source.includes("get"))
  ) {
    return null;
  }
  // parents ON: the helper sweep excludes declarator-name self references
  // and the chase reads expression text through the tree
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // ESM syntax → not CJS; leave alone.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return null;
  }

  interface Neutralize {
    start: number;
    end: number;
  }
  const neutralize: Neutralize[] = [];
  const exportTables: { target: string; entries: [string, ts.Expression | null][] }[] = [];
  const definePropEntries: { name: string; value: ts.Expression | null }[] = [];
  const memberStmts: {
    names: string[];
    finalRhs: ts.Expression;
    viaBareExports: boolean;
    pos: number;
    start: number;
    end: number;
  }[] = [];
  /** Star spec → require-load emission order (statement order). */
  const starSpecsInOrder: string[] = [];
  let esbuildMainTarget: string | null = null;
  let tablePos: number | null = null;
  let sawBundleShape = false;

  const addStarSpec = (spec: string): void => {
    if (!starSpecsInOrder.includes(spec)) starSpecsInOrder.push(spec);
  };

  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const e = stmt.expression;
    // `module.exports = <rhs>`
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExports(e.left)) {
      const rhs = e.right;
      if (ts.isCallExpression(rhs) && calleeNameOf(rhs) === "__toCommonJS" && rhs.arguments.length === 1 && ts.isIdentifier(rhs.arguments[0]!)) {
        esbuildMainTarget = (rhs.arguments[0] as ts.Identifier).text;
        tablePos = stmt.getStart(sf);
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        sawBundleShape = true;
        continue;
      }
      // Any other real module.exports assignment: the file has an export
      // mechanism the checker already models (or a shape outside the
      // recognizers) — not ours to rewrite.
      return null;
    }
    // member exports — `exports.N = RHS;` / `module.exports.N = RHS;`,
    // chains included (`exports.a = exports.b = void 0;` — the tsc
    // void-init preamble collects every name with the chain's final RHS).
    {
      let cur: ts.Expression = e;
      const names: string[] = [];
      let viaBareExports = false;
      while (
        ts.isBinaryExpression(cur) &&
        cur.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(cur.left) &&
        cur.left.questionDotToken === undefined &&
        ts.isIdentifier(cur.left.name) &&
        (isExportsIdent(cur.left.expression) || isModuleExports(cur.left.expression))
      ) {
        names.push(cur.left.name.text);
        if (isExportsIdent(cur.left.expression)) viaBareExports = true;
        cur = cur.right;
      }
      if (names.length > 0) {
        memberStmts.push({
          names,
          finalRhs: cur,
          viaBareExports,
          pos: stmt.getStart(sf),
          start: stmt.getStart(sf),
          end: stmt.getEnd(),
        });
        continue; // classified later (only when a rewrite actually happens)
      }
    }
    // the dead esbuild annotation: `0 && (module.exports = { ... });`
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isNumericLiteral(e.left) &&
      e.left.text === "0"
    ) {
      let inner: ts.Expression = e.right;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (
        ts.isBinaryExpression(inner) &&
        inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(inner.left) &&
        ts.isObjectLiteralExpression(inner.right)
      ) {
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        sawBundleShape = true;
        continue;
      }
    }
    if (!ts.isCallExpression(e)) continue;
    const name = calleeNameOf(e);
    // `__export(TARGET, { getter table });`
    const table = exportCallOf(e);
    if (table !== null) {
      exportTables.push(table);
      neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
      sawBundleShape = true;
      continue;
    }
    // `__exportStar(require('spec'), exports);` — the tsc/tslib spelling —
    // and `__export(require('spec'))`, the legacy twin.
    if ((name === "__exportStar" || name === "__export") && e.arguments.length >= 1) {
      const spec = bareRequireSpecOf(e.arguments[0]!);
      if (spec !== null) {
        addStarSpec(spec);
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        sawBundleShape = true;
        continue;
      }
    }
    // `__reExport(TARGET, require('spec')[, module.exports]);` — esbuild's
    // `export * from` plumbing.
    if (name === "__reExport" && e.arguments.length >= 2) {
      const spec = bareRequireSpecOf(e.arguments[1]!);
      if (spec !== null) {
        addStarSpec(spec);
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        sawBundleShape = true;
        continue;
      }
    }
    // Object.defineProperty(exports, 'n', {...})
    const def = definePropertyExportOf(e);
    if (def !== null) {
      if (def.esModuleStamp) {
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        // the canonical table re-stamps it (lexer-visibly — merve detects
        // this defineProperty form, so parity wants a visible entry)
        continue;
      }
      const chased = def.value !== null ? chaseValue(def.value) : null;
      if (chased !== null) {
        definePropEntries.push({ name: def.name, value: def.value });
        neutralize.push({ start: stmt.getStart(sf), end: stmt.getEnd() });
        sawBundleShape = true;
      }
      // unchaseable descriptor: LEAVE the statement (its runtime fence is
      // loud where an undefined-valued entry would be a silent lie); the
      // name still types through the any-fallback below.
      continue;
    }
  }

  if (!sawBundleShape) return null;
  const lexed = cjsLexedExportsOf(source, filePath);
  if (lexed.exports.size === 0 && lexed.reexports.length === 0) return null;

  /* Star specs Node actually honors are the lexer's SURVIVING reexports
   * (annotation spreads for esbuild bundles, star-pattern calls for tsc
   * output). The statements walked above contribute load order; specs the
   * lexer dropped (cleared by a later module.exports=) drop here too. */
  const lexerSpecs = new Set(lexed.reexports);
  const starSpecs = starSpecsInOrder.filter((s) => lexerSpecs.has(s));
  for (const s of lexed.reexports) {
    if (!starSpecs.includes(s)) starSpecs.push(s);
  }

  /* The entry list, first-wins per name: own getter-table entries, then
   * defineProperty entries, then surviving top-level member exports, then
   * (for names still uncovered) star enumerations in spec order, then the
   * any fallback for every remaining lexer-visible name. */
  const entries = new Map<string, EntrySpec>();
  const claim = (name: string, spec: EntrySpec): void => {
    if (name === "__esModule" || RESERVED_KEYS.has(name)) return;
    if (!entries.has(name)) entries.set(name, spec);
  };
  const classify = (name: string, value: ts.Expression | null): EntrySpec => {
    const chased = value !== null ? chaseValue(value) : null;
    if (chased === null) return { name, kind: "any" };
    if (chased.kind === "ident") return { name, kind: "ident", value: chased.text };
    return { name, kind: "hoist", value: chased.text };
  };

  // Own names: the getter table(s) — the one feeding module.exports first.
  const tablesOrdered = [
    ...exportTables.filter((t) => t.target === esbuildMainTarget),
    ...exportTables.filter((t) => t.target !== esbuildMainTarget),
  ];
  for (const t of tablesOrdered) {
    for (const [name, value] of t.entries) claim(name, classify(name, value));
  }
  for (const d of definePropEntries) claim(d.name, classify(d.name, d.value));

  /* Top-level member exports. Node's export-object identity rules decide
   * each statement's fate against the ORIGINAL table (esbuildMainTarget's
   * assignment): a member attached BEFORE it was discarded (the table
   * replaced the object), a bare `exports.N =` AFTER it wrote the stale
   * object — both keep only their lexer-visible NAME (value undefined,
   * exactly Node's link answer: the any fallback below). A surviving
   * member (`module.exports.N =` after the table, or any spelling when no
   * table exists) re-emits its VALUE as a canonical entry — identifier
   * RHS only; any other RHS would need a second evaluation, so the file
   * is left alone (the offender path owns it). Every member statement is
   * then NEUTRALIZED: the canonical tail table replaces the object, and
   * a stray earlier attach would meet the lowering's discard fence. */
  for (const m of memberStmts) {
    let cur: ts.Expression = m.finalRhs;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    const isVoidInit = cur.kind === ts.SyntaxKind.VoidExpression || (ts.isIdentifier(cur) && cur.text === "undefined");
    const discarded = tablePos !== null && (m.pos < tablePos || m.viaBareExports);
    if (!isVoidInit) {
      // Only side-effect-free RHS shapes may be neutralized (identifiers,
      // scalar literals, ident-rooted member chains — chaseValue's set);
      // anything else keeps the file untouched (the offender path owns
      // it: neutralizing would drop an evaluation, keeping it meets the
      // lowering's discard fence at load).
      const chased = chaseValue(cur);
      if (chased === null) return null;
      if (!discarded) {
        for (const name of m.names) claim(name, { name, kind: chased.kind, value: chased.text });
      }
      // discarded members keep only their lexer-visible NAME (the any
      // fallback below) — value undefined, exactly Node's link answer
    }
    neutralize.push({ start: m.start, end: m.end });
  }

  /* Direct-vs-hoist for ident entries: only bindings declared by a
   * top-level const/function/class may be spelled directly (alias
   * plumbing needs an immutable target — a `var`/`let` in the table would
   * fence the whole statement). Everything else snapshots via a tail
   * const. */
  const immutableTopLevel = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) immutableTopLevel.add(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) immutableTopLevel.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) immutableTopLevel.add(d.name.text);
      }
    }
  }
  for (const spec of entries.values()) {
    if (spec.kind === "ident" && !immutableTopLevel.has(spec.value!)) spec.kind = "hoist";
  }

  // Star enumerations for names the own entries left uncovered.
  const starMembers: { name: string; ref: string }[] = [];
  const requireConsts: string[] = [];
  starSpecs.forEach((spec, i) => {
    const target = resolveRelativeCjs(filePath, spec);
    if (target === null) return; // bare/unresolved: the spread entry carries it
    const names = starTargetNames(target);
    let refVar: string | null = null;
    for (const n of names) {
      if (n === "default" || n === "__esModule" || entries.has(n) || RESERVED_KEYS.has(n)) continue;
      if (starMembers.some((m) => m.name === n)) continue; // earlier spec wins
      if (refVar === null) {
        refVar = `__scriptc_r${i}`;
        requireConsts.push(`const ${refVar} = require(${JSON.stringify(spec)});`);
      }
      starMembers.push({ name: n, ref: refVar });
    }
  });

  // The any fallback: every lexer-visible name nothing above covered.
  for (const n of lexed.exports) claim(n, { name: n, kind: "any" });

  if (entries.size === 0 && starSpecs.length === 0) return null;

  /* Bundler HELPPER declarations left unused once the plumbing statements
   * are gone would still fence at module load (`var __defProp =
   * Object.defineProperty;` — a stdlib generic method as a value has no
   * lowering, and a top-level declaration's fence throws when init runs
   * it). Mark-and-sweep the RECOGNIZED helper names: a helper whose every
   * reference lies inside an already-neutralized span (the plumbing
   * calls, or another swept helper's declaration) is neutralized too.
   * Helpers live code still calls (__toESM interop wrappers, __commonJS
   * chunk factories) stay — their declarations are plain function values
   * whose bodies defer per the JS function-poison rule. */
  {
    const HELPER_NAMES = new Set([
      "__create", "__defProp", "__defProps", "__getOwnPropDesc", "__getOwnPropDescs",
      "__getOwnPropNames", "__getOwnPropSymbols", "__getProtoOf", "__hasOwnProp",
      "__propIsEnum", "__export", "__copyProps", "__reExport", "__toESM", "__toCommonJS",
      "__exportStar", "__createBinding", "__setModuleDefault", "__importStar", "__importDefault",
    ]);
    const helperDecls = new Map<string, { start: number; end: number }>();
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const decls = stmt.declarationList.declarations;
      if (decls.length !== 1) continue;
      const d = decls[0]!;
      if (ts.isIdentifier(d.name) && HELPER_NAMES.has(d.name.text)) {
        helperDecls.set(d.name.text, { start: stmt.getStart(sf), end: stmt.getEnd() });
      }
    }
    // every identifier occurrence of a helper name outside its own
    // declarator name node, position-recorded for the span test
    const refs = new Map<string, number[]>();
    const record = (node: ts.Node): void => {
      ts.forEachChild(node, record);
      if (ts.isIdentifier(node) && helperDecls.has(node.text)) {
        const parent = node.parent;
        if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node) return;
        const list = refs.get(node.text);
        if (list === undefined) refs.set(node.text, [node.getStart(sf)]);
        else list.push(node.getStart(sf));
      }
    };
    record(sf);
    const dead = [...neutralize];
    const inDead = (pos: number): boolean => dead.some((s) => pos >= s.start && pos < s.end);
    const removed = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, span] of helperDecls) {
        if (removed.has(name)) continue;
        // SELF-references inside the candidate's own declaration don't
        // keep it alive (`var __createBinding = (this && this.__createBinding)
        // || ...` — the tsc helper's UMD-style self probe).
        const live = (refs.get(name) ?? []).filter((p) => p < span.start || p >= span.end);
        if (live.every(inDead)) {
          removed.add(name);
          dead.push(span);
          changed = true;
        }
      }
    }
    neutralize.length = 0;
    neutralize.push(...dead);
  }

  /* ── emission ─────────────────────────────────────────────────────── */
  let text = source;
  // pad from the END so earlier spans' offsets stay valid
  for (const n of [...neutralize].sort((a, b) => b.start - a.start)) {
    text = padSpan(text, n.start, n.end);
  }

  const lines: string[] = [""];
  const hasAnyFallback = [...entries.values()].some((s) => s.kind === "any");
  if (hasAnyFallback) {
    // checked-dynamic undefined: an implicit-any IIFE result registers a
    // dyn module global the table's alias plumbing can resolve.
    lines.push("const __scriptc_any = (() => { let u; return u; })();");
  }
  lines.push(...requireConsts);
  const hoists: string[] = [];
  let hoistN = 0;
  const keyOf = (name: string): string => (isPlainName(name) ? name : JSON.stringify(name));
  const plainParts: string[] = [];
  for (const spec of entries.values()) {
    if (spec.kind === "ident") {
      plainParts.push(`${keyOf(spec.name)}: ${spec.value!},`);
    } else if (spec.kind === "hoist") {
      const v = `__scriptc_e${hoistN++}`;
      hoists.push(`const ${v} = ${spec.value!};`);
      plainParts.push(`${keyOf(spec.name)}: ${v},`);
    } else {
      plainParts.push(`${keyOf(spec.name)}: __scriptc_any,`);
    }
  }
  lines.push(...hoists);
  /* The table. Spread entries first (REVERSED: Node's star copies are
   * first-wins, an object literal's later-wins — reversing makes them
   * agree), then the scan-visible plain entries, then — only where the
   * original stamped it LEXER-DETECTABLY (the tsc defineProperty form;
   * Node links `import { __esModule }` there) — the `__esModule: true`
   * entry, then the member-access star entries whose names the spread
   * records already cover. esbuild's marker lives inside __toCommonJS
   * where Node's lexer never saw it, and spelling it here would flip the
   * checker's default-import interop (an __esModule-stamped surface binds
   * `import def` to exports.default) away from Node's CJS answer — so it
   * is deliberately OMITTED from the canonical table. */
  const spreadParts = [...starSpecs].reverse().map((s) => `...require(${JSON.stringify(s)}),`);
  const esModulePart = lexed.exports.has("__esModule") ? "__esModule: true," : "";
  const memberParts = starMembers.map(
    (m) => `${keyOf(m.name)}: ${m.ref}${isPlainName(m.name) ? `.${m.name}` : `[${JSON.stringify(m.name)}]`},`,
  );
  lines.push(`module.exports = {${spreadParts.join("")}${plainParts.join("")}${esModulePart}${memberParts.join("")}};`);
  return text + lines.join("\n") + "\n";
}
