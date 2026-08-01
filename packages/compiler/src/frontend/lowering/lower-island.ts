/* Island-boundary lowering: jsval marshaling into the island (jsvalIn and
 * its boundary fences), island-expression detection, the island method-call
 * surface (Math and number/string methods under --dynamic), and the npm
 * package boundary fences for node_modules-declared symbols. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BYTES_U8, DYN, F64, IrExpr, IrStmt, IrType, JSVAL, MAX_ISLAND_CALLBACK_ARITY, STRING, VOID, canConvertToDyn, canMarshalTypedFuncIntoIsland, islandPromisePayloadTag, isUnitType } from "../../ir/nodes.js";
import { ISLAND_SURFACE, IslandFnEntry, STATIC_MATH_FNS, boundaryIntoIslandMsg } from "./surfaces.js";
import { requiresDynamicApiDiag, requiresDynamicPackageDiag } from "../../diagnostics/diagnostic.js";
import { isCjsJsFile, isJsSourceFile, locOf, npmPackageNameOf } from "../program.js";
import { lowerDynObjectLiteral, pureReemittable } from "./lower-exprs.js";
import { PoisonError, dynUndefinedExpr, newFnCtx, own } from "./lowerer.js";
import {
  NODE24_FETCH_COMPAT_PROFILE,
  STATIC_HEADERS_CALLS,
  STATIC_READABLE_STREAM_CALLS,
  STATIC_READABLE_STREAM_READS,
  STATIC_REQUEST_INIT_KEYS,
  STATIC_RESPONSE_CALLS,
  STATIC_RESPONSE_READS,
} from "../../compat/fetch-profile.js";

/** True iff the checker's type for this node maps to jsval ('any') —
   * the island test in front of every engine-op lowering (receivers,
   * callees, assignment targets). ALSO true for an identifier bound to an
   * island-HANDLE local whose declared type says otherwise (`const {
   * readFileSync } = await import("fs")` — the binding's declared
   * function/Buffer type never held the value; the handle is the value's
   * only story), so its uses dispatch to engine ops instead of
   * re-reporting the declared type. The one exclusion is promise-mapped
   * declared types: a package promise held as a handle keeps its existing
   * checker-driven dispatch (the await/.catch bridge lowerings own it). */
  export function isIslandExpr(L: Lowerer, node: ts.Expression): boolean {
    const mapped = L.mapTypeOf(L.typeOf(node));
    if (mapped?.kind === "jsval") return true;
    if (mapped?.kind !== "promise" && ts.isIdentifier(node)) {
      const local = L.peekLocal(node);
      if (local?.type.kind === "jsval") return true;
      // File-scope handle bindings (a module global slotted jsval by the
      // island-pattern or unchecked-overload rules) take the same rule as
      // locals: the handle is the value's only story.
      if (!local && L.globalOf(node)?.type.kind === "jsval") return true;
    }
    return false;
  }

/** Marshal a static value into the island (--dynamic): primitives by
   * value, JSON-safe composites as a deep copy (the documented aliasing
   * divergence). Values with no island representation — closures, class
   * instances, promises, un-validated 'unknown' — are rejected with the
   * boundary message. */
  /** The call-time deferral of a FUNC-value island crossing in a JS
   * source: captures the just-recorded diagnostic into the runtime-fence
   * ledger and answers a marshaled host closure that THROWS it when
   * invoked — building the value compiles; only a call through the
   * island stops the run. Null (caller rethrows) outside the JS deferral
   * gate: TypeScript sources, probe mode, ICEs. */
  export function islandFuncValueFence(L: Lowerer, err: unknown, diagsBefore: number, node: ts.Node): IrExpr | null {
    if (
      !(err instanceof PoisonError) ||
      !isJsSourceFile(node.getSourceFile()) ||
      L.diagSink !== null ||
      L.diags.length <= diagsBefore ||
      L.diags.slice(diagsBefore).some((d) => d.code === "SC9001")
    ) {
      return null;
    }
    const captured = L.diags.splice(diagsBefore);
    L.runtimeFences.push(...captured);
    const first = captured[0]!;
    const pos = ts.getLineAndCharacterOfPosition(
      L.program.getSourceFile(first.loc.file) ?? node.getSourceFile(),
      first.loc.start,
    );
    const loc = locOf(node);
    const fnName = `%fn${L.lambdaCounter++}_islfence`;
    L.liftedFns.push({
      name: fnName,
      params: [],
      returnType: VOID,
      locals: [],
      captures: [],
      body: [
        {
          kind: "runtimeFence",
          code: first.code,
          message: `${first.message} [${first.code} at ${first.loc.file}:${pos.line + 1}]`,
          loc,
        },
      ],
      loc,
    });
    return {
      kind: "jsMarshal",
      value: { kind: "closure", fnName, captures: [], type: { kind: "func", params: [], ret: VOID }, loc },
      type: JSVAL,
      loc,
    };
  }

  export function jsvalIn(L: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
    if (e.type.kind === "jsval") return e;
    // Bare unit literals (`undefined` / `null` in an 'any' slot): the
    // engine's own units — unit-typed expressions are literals (units have
    // no other producers), so dropping the operand loses nothing.
    if (isUnitType(e.type)) {
      return { kind: "jsOp", op: e.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc: e.loc };
    }
    if (e.type.kind === "dyn") {
      // A CHECKED-DYNAMIC value entering the island: the dyn tree
      // deep-copies into engine values — exactly coerceToExpected's
      // jsval-IN rule (data kinds only; a dyn carrying a boxed
      // function/handle throws the catchable TypeError at runtime).
      return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
    }
    // Closures cross INTO the island as host functions — THE package
    // callback pattern (`.action((a, b) => ...)`). Unannotated params stay
    // 'any' (contextual typing against package signatures) and pass through
    // as handles; TYPED params convert at call time through the validated-
    // exit machinery (strict primitives, JSON round-trip composites,
    // `T | undefined` taking the undefined arm for an absent argument), so
    // a conversion failure throws back into the island as a TypeError.
    // Anything outside both shapes gets the specific fix, not the generic
    // boundary recitation.
    if (
      e.type.kind === "func" &&
      !canMarshalTypedFuncIntoIsland(e.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
    ) {
      const diagsBefore = L.diags.length;
      try {
        L.unsupported(
          "SC1090",
          node,
          `functions with this signature crossing into dynamically-executed code ` +
            `(a callback passed to a package/'any' API may take 'any' parameters — ` +
            `leave them unannotated so contextual typing keeps them 'any' — or parameters ` +
            `convertible at the boundary (number, string, boolean, JSON-safe ` +
            `records/arrays/unions, 'T | undefined'), and return 'any', void, number, ` +
            `string, boolean, a JSON-safe composite, or a Promise of the primitive kinds${
              e.type.kind === "func" && e.type.params.length > MAX_ISLAND_CALLBACK_ARITY
                ? `; at most ${MAX_ISLAND_CALLBACK_ARITY} parameters`
                : ""
            })`,
        );
      } catch (err) {
        // JS sources defer the crossing like a statement fence, one level
        // deeper: the slot receives a host closure that THROWS the
        // diagnostic when INVOKED (the withPlugins aggregation shape —
        // wrappers built at module init around functions the smoke path
        // never calls). TypeScript and probe mode keep the poison.
        const fence = islandFuncValueFence(L, err, diagsBefore, node);
        if (fence) return fence;
        throw err;
      }
    }
    // A STATIC promise crossing INTO the island: a real engine thenable
    // settled when the scriptc promise settles (the async-callback return
    // bridge, scr_jsval_from_promise) — the loadBuiltinPlugins cache
    // shape and the island Promise.all arm's static entries. Only
    // fulfillments in the bridge's payload domain cross; the rest keep
    // the boundary fence below with the promise type named.
    if (e.type.kind === "promise" && islandPromisePayloadTag(e.type.inner) !== null) {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
    }
    if (e.type.kind !== "func" && !L.boundarySafe(e.type)) {
      // A RegExp crossing INTO the island (`z.string().regex(/^a+$/)` —
      // the validation-pattern argument): the engine compiles its own
      // from source+flags. A fresh engine RegExp per marshal — identity
      // and lastIndex state do not cross (SEMANTICS.md). Only literal
      // and pure-read spellings lower (the rebuild reads the operand
      // twice); computed regex values keep the boundary fence.
      if (e.type.kind === "regex") {
        const re = islandRegexpOf(e);
        if (re) return re;
      }
      // jsval-BEARING composites (an `any[]` value, a record holding one)
      // have no JSON marshal but an honest per-field/per-element island
      // construction — the same lift the implicit coercion path uses.
      if (L.jsvalLiftable(e.type)) return L.jsvalLiftExpr(e, e.loc);
      L.unsupported("SC1090", node, boundaryIntoIslandMsg(L.fmt(e.type)));
    }
    return { kind: "jsMarshal", value: e, type: JSVAL, loc: e.loc };
  }

/** A static RegExp value as a fresh ENGINE RegExp — `new RegExp(source,
   * flags)` in the island, the pattern TEXT crossing (both worlds compile
   * the ES-spec grammar). Literals rebuild from their own pattern/flags;
   * pure reads (a regex-typed binding) read the source/flags intrinsics —
   * the rebuild emits the operand twice, so effectful producers return
   * null into the caller's boundary fence. */
  export function islandRegexpOf(e: IrExpr): IrExpr | null {
    if (e.type.kind !== "regex") return null;
    const loc = e.loc;
    let src: IrExpr;
    let flags: IrExpr;
    if (e.kind === "regexLit") {
      src = { kind: "strLit", value: e.pattern, type: STRING, loc };
      flags = { kind: "strLit", value: e.flags, type: STRING, loc };
    } else if (pureReemittable(e)) {
      src = { kind: "regexIntrinsic", method: "source", receiver: e, args: [], type: STRING, loc };
      flags = { kind: "regexIntrinsic", method: "flags", receiver: e, args: [], type: STRING, loc };
    } else {
      return null;
    }
    const ctor: IrExpr = { kind: "jsOp", op: "globalGet", name: "RegExp", args: [], type: JSVAL, loc };
    return {
      kind: "jsOp",
      op: "construct",
      args: [
        ctor,
        { kind: "jsMarshal", value: src, type: JSVAL, loc },
        { kind: "jsMarshal", value: flags, type: JSVAL, loc },
      ],
      type: JSVAL,
      loc,
    };
  }

/** The gate on every ISLAND_SURFACE lowering: under --dynamic the caller
   * proceeds to engine ops; without it the use site is a per-site SC2012
   * (poison-recovered, so every site in the program reports — and the
   * coverage report groups them under "runs with --dynamic"). */
  export function requireDynamicApi(L: Lowerer, feature: string, node: ts.Node): void {
    if (L.dynamic) return;
    L.pushDiag(requiresDynamicApiDiag(feature, locOf(node)));
    throw new PoisonError();
  }

/** Resolves an identifier to an island-backed ambient GLOBAL function
   * (parseFloat, isFinite). Provenance, not name: the
   * symbol's declaration must live in the ambient file, so a user function
   * named `parseFloat` never matches. */
  export function islandGlobalFnOf(L: Lowerer, ident: ts.Identifier): IslandFnEntry | null {
    const entry = own(ISLAND_SURFACE.globals, ident.text);
    if (!entry) return null;
    const symbol = L.resolveValueSymbol(ident);
    if (!symbol || !L.isStdlibSymbol(symbol)) return null;
    return entry;
  }

function requestInitLiteralKey(
  prop: ts.ObjectLiteralElementLike,
): string | null {
  if (
    !ts.isPropertyAssignment(prop) &&
    !ts.isShorthandPropertyAssignment(prop) &&
    !ts.isMethodDeclaration(prop)
  ) {
    return null;
  }
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const value = name.expression;
    if (ts.isStringLiteral(value)) return value.text;
    if (ts.isNumericLiteral(value)) return String(Number(value.text));
  }
  return null;
}

/** Fence declared RequestInit members outside the native static slice.
 * Computed runtime keys and non-literal objects are validated again by
 * scr_fetch_static, so no unsupported option can be silently discarded. */
function fenceStaticRequestInitLiteral(
  L: Lowerer,
  init: ts.ObjectLiteralExpression,
): void {
  const contextual = L.checker.getContextualType(init);
  for (const prop of init.properties) {
    const key = requestInitLiteralKey(prop);
    if (key === null || STATIC_REQUEST_INIT_KEYS.has(key)) continue;
    const contextualArms =
      contextual?.isUnionType() ? contextual.getTypes() : contextual ? [contextual] : [];
    const sym = contextualArms
      .map((arm) => L.checker.getPropertyOfType(arm, key))
      .find((member) => member !== undefined);
    L.noLowering(
      `RequestInit option '${key}' in a static build`,
      prop,
      "the native static RequestInit surface is method, headers, body, duplex, redirect, and signal; use --dynamic for the wider fetch options",
      sym,
    );
  }
}

/** USER-code `fetch(url)` / `fetch(url, init)` — the ambient global
   * (provenance, not the name: a user's own `fetch` never matches).
   *
   * The static tier owns URL requests directly: scr_fetch_static runs
   * over the native net/http/tls stack, consumes a checked-dynamic
   * RequestInit object, and returns a promise of an opaque native
   * Response handle. AbortSignal and readable Web Streams are native
   * checked-dynamic handles too, so cancellation and streaming bodies
   * stay engine-free.
   *
   * The engine's own fetch executes (the same one embedded npm code calls —
   * scr_fetch.c over the native net/tls stack): the url marshals in (strings; template
   * results), an init OBJECT LITERAL builds natively in the island through
   * the existing 'any'-contextual literal path (RequestInit maps to jsval,
   * so field values marshal individually and an AbortSignal handle passes
   * straight through), and the engine's promise bridges to a static
   * `promise of jsval` (jsBridgePromise) — `await fetch(...)` parks the
   * fiber like any await and resumes with the Response HANDLE. Member
   * reads/calls on the handle are engine ops; typed extraction happens at
   * the user's narrowing sites through the validated-exit machinery.
   * Null for anything that isn't THE ambient fetch, so lowerCall keeps
   * trying. */
  export function lowerFetchCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
    const callee = call.expression;
    if (!ts.isIdentifier(callee) || callee.text !== "fetch") return null;
    if (call.questionDotToken) return null;
    const symbol = L.resolveValueSymbol(callee);
    if (!symbol || !L.isStdlibSymbol(symbol)) return null;
    if (call.arguments.length < 1) return null;
    const loc = locOf(call);
    if (!L.dynamic) {
      const inputNode = call.arguments[0]!;
      const input = L.lowerExpr(inputNode);
      const initNode = call.arguments[1];
      let init: IrExpr;
      if (initNode === undefined) {
        init = dynUndefinedExpr(loc);
      } else if (ts.isObjectLiteralExpression(initNode)) {
        fenceStaticRequestInitLiteral(L, initNode);
        init = lowerDynObjectLiteral(L, initNode);
      } else {
        init = L.lowerExprExpecting(initNode, DYN);
      }

      // Calling a WebIDL operation has two distinct phases: JavaScript
      // first evaluates every argument expression, then the callee converts
      // those values. In particular, evaluating RequestInit may mutate a
      // URL object passed as input; its href must not be snapshotted until
      // all argument expressions (including ignored surplus ones) ran.
      const inputLocal = L.declareHiddenLocal("%fetchInput", input.type);
      const initLocal = L.declareHiddenLocal("%fetchInit", init.type);
      const inputRef: IrExpr = {
        kind: "varRef",
        localId: inputLocal.id,
        type: input.type,
        loc: locOf(inputNode),
      };
      const initRef: IrExpr = {
        kind: "varRef",
        localId: initLocal.id,
        type: init.type,
        loc,
      };
      const stmts: IrStmt[] = [
        { kind: "varDecl", localId: inputLocal.id, init: input, loc },
        { kind: "varDecl", localId: initLocal.id, init, loc },
      ];
      for (const argument of call.arguments.slice(2)) {
        if (ts.isSpreadElement(argument)) {
          L.noLowering(
            "spread surplus arguments on static fetch()",
            argument,
            "pass surplus arguments without spread syntax",
          );
        }
        const discarded = ts.isVoidExpression(argument)
          ? L.lowerExpr(argument.expression)
          : L.lowerExpr(argument);
        stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
      }
      const url: IrExpr =
        input.type.kind === "url"
          ? {
              kind: "libCall",
              fn: "url.href",
              args: [inputRef],
              type: STRING,
              loc: locOf(inputNode),
            }
          : L.coerceInto(inputNode, inputRef, STRING);
      const answer: IrExpr = {
        kind: "libCall",
        fn: "fetch.start",
        args: [url, initRef],
        type: { kind: "promise", inner: DYN },
        loc,
      };
      return { kind: "seqExpr", stmts, result: answer, type: answer.type, loc };
    }
    const fetchFn: IrExpr = { kind: "jsOp", op: "globalGet", name: "fetch", args: [], type: JSVAL, loc };
    // Init OBJECT LITERALS build natively in the island (the general
    // 'any'-contextual literal path can't claim them: the optional param's
    // contextual type is `RequestInit | undefined`, a union) — field
    // values marshal individually, so an AbortSignal HANDLE passes
    // through and dashed header keys ("content-type") are plain engine
    // property names. Non-literal inits marshal as a whole (JSON-safe
    // records; a signal field inside one fences with the boundary rule).
    const args = call.arguments.map((a) =>
      ts.isObjectLiteralExpression(a) ? lowerIslandObjectLiteral(L, a) : L.jsvalIn(L.lowerExpr(a), a),
    );
    const raw: IrExpr = { kind: "jsOp", op: "callFn", args: [fetchFn, ...args], type: JSVAL, loc };
    return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** Static Response.json(): consume the native Response's readable body
 * stream and parse its UTF-8 payload into the ordinary checked-dynamic
 * JSON tree. Syntax and stream failures reject at await like the web API. */
export function lowerStaticResponseCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (
    L.dynamic ||
    call.questionDotToken ||
    (!ts.isPropertyAccessExpression(call.expression) &&
      !ts.isElementAccessExpression(call.expression))
  ) {
    return null;
  }
  const access = call.expression;
  const member = staticResponseMemberName(L, access);
  if (
    access.questionDotToken ||
    (member !== "json" &&
      member !== "text" &&
      member !== "bytes" &&
      member !== "arrayBuffer") ||
    call.arguments.length !== 0
  ) {
    return null;
  }
  const recvType = L.checker.getBaseTypeOfLiteralType(L.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Response" || !L.isStdlibSymbol(sym)) return null;
  if (member === "arrayBuffer") {
    L.noLowering(
      "Response.arrayBuffer() in a static build",
      call,
      "use Response.bytes() for the native Uint8Array body; free-standing ArrayBuffer values have no static representation",
      sym,
    );
  }
  const recv = L.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  if (member === "text" || member === "bytes") {
    return {
      kind: "libCall",
      fn: member === "text" ? "fetch.responseText" : "fetch.responseBytes",
      args: [recv],
      type: { kind: "promise", inner: member === "text" ? STRING : BYTES_U8 },
      loc: locOf(call),
    };
  }
  return {
    kind: "libCall",
    fn: "fetch.responseJson",
    args: [recv],
    type: { kind: "promise", inner: DYN },
    loc: locOf(call),
  };
}

type StaticResponseAccess =
  | ts.PropertyAccessExpression
  | ts.ElementAccessExpression;

function staticResponseMemberName(
  L: Lowerer,
  access: StaticResponseAccess,
): string | null {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const keyExpr = access.argumentExpression;
  if (
    ts.isPropertyAccessExpression(keyExpr) &&
    L.isStdlibGlobal(keyExpr.expression, "Symbol") &&
    (keyExpr.name.text === "iterator" ||
      keyExpr.name.text === "asyncIterator" ||
      keyExpr.name.text === "toStringTag")
  ) {
    return `[Symbol.${keyExpr.name.text}]`;
  }
  const key = L.typeOf(access.argumentExpression);
  return key.isStringLiteralType() ? key.value : null;
}

function fetchInventoryStatus(
  owner: string,
  member: string,
  placement: "static" | "prototype" | "prototype-symbol",
): "static" | "dynamic-only" | "unsupported" | "out-of-scope" | null {
  return NODE24_FETCH_COMPAT_PROFILE.inventory.entries.find((entry) =>
    entry.owner === owner &&
    entry.member === member &&
    entry.placement === placement
  )?.status ?? null;
}

/** Constructor-object operations are distinct from Response instance
 * methods. The inventory marks the former unsupported in both tiers; fence
 * them explicitly so the generic call fallback cannot report SC1090 for
 * Response.json while the other statics report SC2020. */
export function fenceUnsupportedFetchConstructorMember(
  L: Lowerer,
  access: StaticResponseAccess,
): IrExpr | null {
  if (!L.isStdlibGlobal(access.expression, "Response")) return null;
  const member = staticResponseMemberName(L, access);
  if (
    member === null ||
    fetchInventoryStatus("Response", member, "static") !== "unsupported"
  ) {
    return null;
  }
  L.noLowering(
    `Response.${member}`,
    access,
    "Response constructor-object operations have no compiler lowering in either tier",
  );
}

function hasLiveWebMutableArm(L: Lowerer, type: IrType): boolean {
  if (
    type.kind === "record" ||
    type.kind === "array" ||
    type.kind === "bytes"
  ) {
    return true;
  }
  if (type.kind !== "union") return false;
  return L.unions.get(type.unionId)?.arms.some((arm) =>
    hasLiveWebMutableArm(L, arm)
  ) ?? false;
}

/** Box mutable data for Web API slots that expose the exact JavaScript
 * value again. Ordinary dynFrom remains the documented copy boundary;
 * this capsule is deliberately limited to records/arrays/bytes (including
 * those selected at runtime from a union) that the live materializer can
 * snapshot and commit. */
function lowerLiveWebValue(L: Lowerer, node: ts.Expression): IrExpr {
  const value = L.lowerExpr(node);
  if (
    hasLiveWebMutableArm(L, value.type) &&
    canConvertToDyn(
      value.type,
      (id) => L.shapes.get(id),
      (id) => L.unions.get(id),
    )
  ) {
    return {
      kind: "dynFrom",
      value,
      liveRef: true,
      type: DYN,
      loc: value.loc,
    };
  }
  return L.coerceInto(node, value, DYN);
}

/** The adopted undici Response declaration is wider than the native static
 * handle. Keep the supported fallback slice on checked-dynamic dispatch, but
 * fence every other declared member before the generic dyn keyed-read/call
 * paths can turn a missing handle operation into a runtime TypeError. */
export function fenceStaticResponseMember(
  L: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const recvType = L.checker.getBaseTypeOfLiteralType(L.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Response" || !L.isStdlibSymbol(sym)) return null;
  const member = staticResponseMemberName(L, access);
  if (member === null) return null;
  const placement = member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype";
  const status = fetchInventoryStatus("Response", member, placement);
  if (L.dynamic && status !== "unsupported") return null;
  const supported =
    use === "call"
      ? STATIC_RESPONSE_CALLS.has(member)
      : STATIC_RESPONSE_READS.has(member);
  if (supported) return null;
  L.noLowering(
    `Response.${member} in a static build`,
    access,
    "the native static Response surface is status/ok/statusText/url/redirected/headers/body/bodyUsed plus json(), text(), and bytes(); use --dynamic for the wider Web API",
    sym,
  );
}

/** Response Headers are native checked-dynamic handles. Keep their exact
 * supported method slice aligned with the compatibility census so newly
 * observed Node members cannot fall through to a runtime missing-method
 * error in an engine-free build. */
export function fenceStaticHeadersMember(
  L: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const recvType = L.checker.getBaseTypeOfLiteralType(L.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "Headers" || !L.isStdlibSymbol(sym)) return null;
  const member = staticResponseMemberName(L, access);
  if (member === null) return null;
  const placement = member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype";
  const status = fetchInventoryStatus("Headers", member, placement);
  if (L.dynamic && status !== "unsupported") return null;
  if (use === "call" && STATIC_HEADERS_CALLS.has(member)) return null;
  if (status === "unsupported") {
    L.noLowering(
      `Headers.${member}`,
      access,
      "symbol-keyed Headers iteration has no compiler lowering in either tier; call entries() with --dynamic instead",
      sym,
    );
  }
  L.noLowering(
    `Headers.${member} in a static build`,
    access,
    "the native static Headers surface is append/delete/get/getSetCookie/has/set/forEach; use keys()/values()/entries() with --dynamic, while construction and symbol-keyed iteration remain unsupported",
    sym,
  );
}

/** The fallback ambient declaration intentionally exposes only the native
 * stream slice, but @types/node adopts the complete WHATWG ReadableStream
 * interface. Fence that wider surface before its checked-dynamic handle can
 * fall through to a runtime missing-method error. */
export function fenceStaticReadableStreamMember(
  L: Lowerer,
  access: StaticResponseAccess,
  use: "read" | "call",
): IrExpr | null {
  const recvType = L.checker.getBaseTypeOfLiteralType(L.typeOf(access.expression));
  const sym = recvType.getAliasSymbol() ?? recvType.getSymbol();
  if (!sym || sym.name !== "ReadableStream" || !L.isStdlibSymbol(sym)) {
    return null;
  }
  const member = staticResponseMemberName(L, access);
  if (member === null) return null;
  const placement = member.startsWith("[Symbol.") ? "prototype-symbol" : "prototype";
  const status = fetchInventoryStatus("ReadableStream", member, placement);
  if (L.dynamic && status !== "unsupported") return null;
  const supported =
    use === "call"
      ? STATIC_READABLE_STREAM_CALLS.has(member)
      : STATIC_READABLE_STREAM_READS.has(member);
  if (supported) return null;
  if (status === "unsupported") {
    L.noLowering(
      `ReadableStream.${member}`,
      access,
      "symbol-keyed async iteration has no compiler lowering in either tier; call values() with --dynamic instead",
      sym,
    );
  }
  L.noLowering(
    `ReadableStream.${member} in a static build`,
    access,
    "the native static ReadableStream surface is locked plus cancel() and getReader(); use a reader directly or --dynamic for the wider Web Streams API",
    sym,
  );
}

/** Static AbortSignal constructors and ReadableStream.from(). These
 * ambient globals have no first-class constructor-object representation;
 * claim the direct calls by declaration provenance before the general
 * member-call path tries to lower the receiver as a value. */
function staticCallWithSurplusArgs(
  L: Lowerer,
  call: ts.CallExpression,
  first: IrExpr,
  result: (first: IrExpr) => IrExpr,
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.length === 1) return result(first);
  const firstLocal = L.declareHiddenLocal("%fetchArg", first.type);
  const firstRef = (): IrExpr => ({
    kind: "varRef",
    localId: firstLocal.id,
    type: first.type,
    loc,
  });
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: firstLocal.id, init: first, loc },
  ];
  for (const argument of call.arguments.slice(1)) {
    if (ts.isSpreadElement(argument)) {
      L.noLowering(
        "spread surplus arguments on the static fetch companion APIs",
        argument,
        "pass surplus arguments without spread syntax",
      );
    }
    // The callee ignores the value, but JavaScript still evaluates every
    // surplus argument in source order. A direct void has the operand's
    // effects and no additional work of its own.
    const discarded = ts.isVoidExpression(argument)
      ? L.lowerExpr(argument.expression)
      : L.lowerExpr(argument);
    stmts.push({ kind: "exprStmt", expr: discarded, loc: discarded.loc });
  }
  const answer = result(firstRef());
  return { kind: "seqExpr", stmts, result: answer, type: answer.type, loc };
}

export function lowerStaticFetchCompanionCall(
  L: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (
    L.dynamic ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    !ts.isIdentifier(call.expression.expression)
  ) {
    return null;
  }
  const root = call.expression.expression;
  const symbol = L.resolveValueSymbol(root);
  if (!symbol || !L.isStdlibSymbol(symbol)) return null;
  const loc = locOf(call);
  if (root.text === "AbortSignal") {
    switch (call.expression.name.text) {
      case "timeout":
        if (call.arguments[0] && ts.isSpreadElement(call.arguments[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          L,
          call,
          call.arguments[0]
            ? L.lowerExprExpecting(call.arguments[0], DYN)
            : dynUndefinedExpr(loc),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortTimeout",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      case "abort":
        if (call.arguments.length === 0) {
          return {
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [dynUndefinedExpr(loc)],
            type: DYN,
            loc,
          };
        }
        if (ts.isSpreadElement(call.arguments[0]!)) return null;
        return staticCallWithSurplusArgs(
          L,
          call,
          lowerLiveWebValue(L, call.arguments[0]!),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortNow",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      case "any":
        if (call.arguments[0] && ts.isSpreadElement(call.arguments[0])) {
          return null;
        }
        return staticCallWithSurplusArgs(
          L,
          call,
          call.arguments[0]
            ? L.lowerExprExpecting(call.arguments[0], DYN)
            : dynUndefinedExpr(loc),
          (first) => ({
            kind: "libCall",
            fn: "fetch.abortAny",
            args: [first],
            type: DYN,
            loc,
          }),
        );
      default:
        return null;
    }
  }
  if (
    root.text === "ReadableStream" &&
    call.expression.name.text === "from" &&
    (!call.arguments[0] || !ts.isSpreadElement(call.arguments[0]))
  ) {
    if (!call.arguments[0]) {
      return {
        kind: "libCall",
        fn: "fetch.streamFrom",
        args: [dynUndefinedExpr(loc)],
        type: DYN,
        loc,
      };
    }
    let source = L.lowerExpr(call.arguments[0]!);
    // A readonly tuple satisfies the fallback's readonly-array overload,
    // but maps to a monomorphic record in IR. Reuse the ordinary
    // tuple→array width conversion with the resolved generic parameter so
    // `ReadableStream.from([1, 2] as const)` follows every other tuple
    // flowing into a readonly T[] slot.
    if (source.type.kind === "record") {
      const signature = L.checker.getResolvedSignature(call);
      const iterableParam = signature?.getParameters()[0];
      const iterableType = iterableParam
        ? L.mapTypeOf(L.checker.getTypeOfSymbol(iterableParam))
        : null;
      if (iterableType?.kind === "array") {
        source = L.widthCoerce(source, iterableType) ?? source;
      }
    }
    const preserve =
      source.type.kind === "string" ||
      (source.type.kind === "bytes" && source.type.elem === "u8") ||
      (source.type.kind === "array" &&
        canConvertToDyn(
          source.type.elem,
          (id) => L.shapes.get(id),
          (id) => L.unions.get(id),
        )) ||
      source.type.kind === "dyn";
    if (!preserve) {
      L.noLowering(
        `ReadableStream.from() over ${L.checker.typeToString(L.typeOf(call.arguments[0]!))} iterables`,
        call.arguments[0]!,
        "arrays, Uint8Array, and strings are supported — spread other synchronous iterables into an array first: [...iterable]",
      );
    }
    return staticCallWithSurplusArgs(L, call, source, (first) => ({
      kind: "libCall",
      fn: "fetch.streamFrom",
      // Arrays and bytes must cross by reference: their iterators read each
      // entry at pull time, so mutations after ReadableStream.from() remain
      // observable just as they are in Node. Other supported iterable
      // shapes retain the checked-dynamic fallback.
      args: [first],
      type: DYN,
      loc,
    }));
  }
  return null;
}

/** `ReadableStreamDefaultController.enqueue(value)` is a dyn-handle call,
 * but unlike a general checked-dynamic boundary the Web Streams contract
 * exposes the same chunk reference from reader.read(). */
export function lowerStaticReadableStreamControllerCall(
  L: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    L.dynamic ||
    call.questionDotToken ||
    call.arguments.length > 1 ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken ||
    staticResponseMemberName(L, access) !== "enqueue"
  ) {
    return null;
  }
  const receiverTs = L.checker.getBaseTypeOfLiteralType(
    L.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol?.name !== "ReadableStreamDefaultController" ||
    !L.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        L.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const recv = L.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv,
    method: "enqueue",
    calleeName: access.getText(),
    args: [
      call.arguments[0]
        ? lowerLiveWebValue(L, call.arguments[0])
        : dynUndefinedExpr(loc),
    ],
    type: DYN,
    loc,
  };
}

/** AbortSignal retains listener object identity for duplicate detection and
 * removeEventListener(). Functions already box by closure identity; mutable
 * record/array/bytes listeners need the same live capsule used by stream
 * chunks so repeated crossings still denote one EventListener object. */
export function lowerStaticAbortSignalListenerCall(
  L: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    L.dynamic ||
    call.questionDotToken ||
    call.arguments.length < 2 ||
    call.arguments.some((arg) => ts.isSpreadElement(arg)) ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(L, access);
  if (member !== "addEventListener" && member !== "removeEventListener") {
    return null;
  }
  const receiverTs = L.checker.getBaseTypeOfLiteralType(
    L.typeOf(access.expression),
  );
  const symbol = receiverTs.getAliasSymbol() ?? receiverTs.getSymbol();
  if (
    symbol?.name !== "AbortSignal" ||
    !L.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        L.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const recv = L.lowerExpr(access.expression);
  if (recv.type.kind !== "dyn") return null;
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv,
    method: member,
    calleeName: access.getText(),
    args: call.arguments.map((arg, index) =>
      index === 1
        ? lowerLiveWebValue(L, arg)
        : L.lowerExprExpecting(arg, DYN),
    ),
    type: DYN,
    loc,
  };
}

/** `new ReadableStream(source?)` in a static build. The source record is
 * boxed into the checked-dynamic tree so start/pull/cancel callbacks can
 * be retained by the native controller. Strategies and BYOB sources are
 * deliberately left to the existing per-site fence. */
export function lowerStaticReadableStreamNew(
  L: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (
    L.dynamic ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "ReadableStream"
  ) {
    return null;
  }
  const symbol = L.resolveValueSymbol(expr.expression);
  if (!symbol || !L.isStdlibSymbol(symbol)) return null;
  const args = expr.arguments ?? [];
  if (args.length > 1) return null;
  const loc = locOf(expr);
  const source =
    args.length === 0
      ? dynUndefinedExpr(loc)
      : ts.isObjectLiteralExpression(args[0]!)
        ? lowerDynObjectLiteral(L, args[0]!)
        : lowerLiveWebValue(L, args[0]!);
  return {
    kind: "libCall",
    fn: "fetch.streamNew",
    args: [source],
    type: DYN,
    loc,
  };
}

/** A static default reader's read() exits the native checked-dynamic
 * transport into the checker's concrete chunk type. An exact chunk type
 * preserves ReadableStream.from(array)'s element identity; structural
 * widening keeps the compiler's ordinary copy-based width semantics. */
export function lowerStaticReadableStreamReaderCall(
  L: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (
    L.dynamic ||
    call.questionDotToken ||
    call.arguments.length !== 0 ||
    (!ts.isPropertyAccessExpression(access) &&
      !ts.isElementAccessExpression(access)) ||
    access.questionDotToken
  ) {
    return null;
  }
  const member = staticResponseMemberName(L, access);
  if (member !== "read") return null;
  const receiverTs = L.typeOf(access.expression);
  const symbol = receiverTs.getSymbol();
  if (
    symbol?.name !== "ReadableStreamDefaultReader" ||
    !L.checker.declarationsOf(symbol).some(
      (d) =>
        ts.isInterfaceDeclaration(d) &&
        L.isStdlibFile(d.getSourceFile()),
    )
  ) {
    return null;
  }
  const type = L.mapTypeOf(L.typeOf(call));
  if (
    type?.kind !== "promise" ||
    type.inner.kind !== "record"
  ) {
    return null;
  }
  return {
    kind: "libCall",
    fn: "fetch.readerRead",
    args: [L.lowerExprExpecting(access.expression, DYN)],
    type,
    loc: locOf(call),
  };
}

/** Dynamic `import(spec)` — the island's module system at a USER site.
   * Under --dynamic the call lowers to island.importDyn(key): the engine
   * loads the module (embedded npm graph, a shipped local .js/.mjs the
   * build embedded, or a builtin shim — collectDynamicImports resolved and
   * embedded the specifier at collection time) and answers an ENGINE
   * promise of the namespace object, bridged to a static
   * `Promise<jsval>` (jsBridgePromise, the fetch precedent) — so `await
   * import(x)` parks the fiber and resumes with the namespace HANDLE, and
   * a load/evaluation failure crosses as a catchable rejection, exactly
   * where Node puts it. Specifiers must be string literals: the module
   * graph is a BUILD-time artifact — a runtime-computed name has nothing
   * to embed, and the fence says so. Static builds report the per-site
   * SC2012. Null for anything that isn't `import(...)`. */
  export function lowerDynamicImportCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
    if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    L.requireDynamicApi("'import()'", call);
    const loc = locOf(call);
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isStringLiteralLike(arg)) {
      L.unsupported(
        "SC1090",
        call,
        "dynamic import() of computed specifiers (the module graph embeds at " +
          "build time — the specifier must be a string literal)",
      );
    }
    if (call.arguments.length !== 1) {
      L.unsupported("SC1090", call, "dynamic import() with import attributes");
    }
    const res = L.dynImports.get(`${call.getSourceFile().fileName}\u0000${arg.text}`);
    if (!res) {
      // Collection walks every file before bodies lower, so a missing
      // entry is a lowerer bug, not user error.
      throw new Error(`lowerer bug: unresolved dynamic import '${arg.text}'`);
    }
    if (res.kind === "program-module") {
      return lowerOwnModuleImport(L, call, arg);
    }
    if (res.kind !== "module") {
      throw new PoisonError(); // resolution failed — collection reported it
    }
    const raw: IrExpr = {
      kind: "libCall",
      fn: "island.importDyn",
      args: [{ kind: "strLit", value: res.key, type: STRING, loc }],
      type: JSVAL,
      loc,
    };
    return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** Dynamic `import()` of one of the program's OWN modules: the compiled
   * module's exports, marshaled into the engine as a namespace object.
   * The site lowers to `Promise.resolve().then(<builder>)` in the engine —
   * the builder is a synthesized compiled function (dynNsBuilderOf) that
   * runs on the engine MICROTASK, calls the target module's run-once %init
   * (Node's evaluation point for a module first reached through import():
   * after the importer's synchronous code, before the .then handlers), and
   * returns the exports object. Node differences (numbered divergences,
   * pinned in island.test.ts): the namespace is a SNAPSHOT taken when the
   * import resolves (Node's is live), a plain engine object (no Module
   * toStringTag, keys still sorted like Node's, each import minting a
   * fresh object where Node caches one), and exports with no island
   * representation (classes, generic functions, un-marshalable
   * signatures) cross as trap functions that throw a pointed TypeError
   * when USED — the namespace still builds, exactly like Node still
   * resolves it. */
  function lowerOwnModuleImport(L: Lowerer, call: ts.CallExpression, arg: ts.StringLiteralLike): IrExpr {
    const loc = locOf(call);
    let dep: ts.SourceFile | null = null;
    const modSym = L.checker.getSymbolAtLocation(arg);
    for (const d of (modSym ? L.checker.declarationsOf(modSym) : [])) {
      if (ts.isSourceFile(d) && !d.isDeclarationFile) {
        dep = d;
        break;
      }
    }
    if (dep !== null && (dep.fileName.endsWith(".cts") || isCjsJsFile(dep))) {
      L.unsupported(
        "SC1090",
        call,
        `dynamic import of the program's own CommonJS module '${arg.text}' ` +
          "(its namespace comes from module.exports through Node's CJS lexer, " +
          "which has no compiled story — require it, or import it statically)",
      );
    }
    const builder = dep !== null ? dynNsBuilderOf(L, dep, loc) : null;
    if (builder === null) {
      L.unsupported(
        "SC1090",
        call,
        `dynamic import of the program's own module '${arg.text}' ` +
          "(this module is not part of the compiled module graph — import it statically)",
      );
    }
    const promiseCtor: IrExpr = { kind: "jsOp", op: "globalGet", name: "Promise", args: [], type: JSVAL, loc };
    const resolved: IrExpr = { kind: "jsOp", op: "callMethod", name: "resolve", args: [promiseCtor], type: JSVAL, loc };
    const builderAsync = dep !== null && L.asyncInitFiles.has(dep);
    const builderFn: IrType & { kind: "func" } = {
      kind: "func",
      params: [],
      ret: builderAsync ? { kind: "promise", inner: JSVAL } : JSVAL,
    };
    const marshaled: IrExpr = {
      kind: "jsMarshal",
      value: { kind: "closure", fnName: builder, captures: [], type: builderFn, loc },
      type: JSVAL,
      loc,
    };
    const chained: IrExpr = { kind: "jsOp", op: "callMethod", name: "then", args: [resolved, marshaled], type: JSVAL, loc };
    return { kind: "jsBridgePromise", value: chained, type: { kind: "promise", inner: JSVAL }, loc };
  }

/** The namespace-BUILDER function for one program module, synthesized on
   * first demand and shared by every import() of that module (deterministic
   * name per file tag, so the discovery and emit passes agree). Body: the
   * module's guarded %init (skipped for the entry — it is running or ran),
   * then `return { <sorted exports> }` as an engine object. Null when the
   * module never joined the compiled graph (no %init exists — an empty
   * preflight order or a cycle the extension refused). */
  function dynNsBuilderOf(L: Lowerer, dep: ts.SourceFile, loc: IrExpr["loc"]): string | null {
    const cached = L.dynNsBuilders.get(dep);
    if (cached !== undefined) return cached;
    const initName = L.initNameOf.get(dep);
    if (initName === undefined) return null;
    const rawTag = L.fileTag.get(dep) ?? "";
    const name = `%dynns.${rawTag === "" ? "e." : rawTag.replace(/^%/, "")}`;
    L.dynNsBuilders.set(dep, name);
    const isAsync = L.asyncInitFiles.has(dep);
    const fnCtx = newFnCtx(true, null, null, JSVAL);
    fnCtx.isAsync = isAsync;
    L.fnStack.push(fnCtx);
    try {
      const body: IrStmt[] = [];
      // A synchronous entry has no run-once guard, so its historical
      // self-import path must not call %init again. An ASYNC entry does
      // have the stronger evaluation-promise cache: awaiting that cached
      // promise is essential for top-level `await import("./self")`,
      // which deadlocks (and ultimately exits 13) in Node rather than
      // exposing a half-evaluated namespace.
      if (dep !== L.entry || isAsync) {
        const call: IrExpr = {
          kind: "call",
          callee: initName,
          args: [],
          type: isAsync ? { kind: "promise", inner: VOID } : VOID,
          loc,
        };
        const cyclePromiseId = L.asyncCyclePromiseOf.get(dep);
        if (isAsync && cyclePromiseId !== undefined) {
          // Starting the REQUESTED member matters for dynamically-only
          // cycles: build-time discovery may have encountered another
          // member first, but Node roots evaluation at the first module
          // actually imported at runtime. The spawn wrapper publishes
          // that outermost promise in the SCC's shared slot after eager
          // recursive spawning returns. Discard the member promise here
          // and await the shared root before exposing any namespace.
          body.push({ kind: "exprStmt", expr: call, loc });
          const promiseT: IrType = { kind: "promise", inner: VOID };
          body.push({
            kind: "exprStmt",
            expr: {
              kind: "awaitExpr",
              value: { kind: "varRef", localId: cyclePromiseId, type: promiseT, loc },
              type: VOID,
              loc,
            },
            loc,
          });
        } else {
          body.push({
            kind: "exprStmt",
            expr: isAsync
              ? { kind: "awaitExpr", value: call, type: VOID, loc }
              : call,
            loc,
          });
        }
      }
      // Node sorts module-namespace keys (code-unit order); tsc erases
      // type-only exports, so only VALUE exports appear.
      const entries: [string, ts.Symbol][] = [];
      const modSym = L.checker.getSymbolAtLocation(dep);
      modSym?.getExports().forEach((sym: ts.Symbol, key: ts.__String) => {
        const n = String(key);
        if (!n.startsWith("__") && n !== "export=") entries.push([n, sym]);
      });
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const args: IrExpr[] = [];
      for (const [exportName, sym] of entries) {
        const value = exportJsvalValue(L, exportName, sym, loc);
        if (value === null) continue;
        args.push(
          { kind: "jsMarshal", value: { kind: "strLit", value: exportName, type: STRING, loc }, type: JSVAL, loc },
          value,
        );
      }
      body.push({ kind: "return", value: { kind: "jsOp", op: "objLit", args, type: JSVAL, loc }, loc });
      const ctx = L.ctx;
      L.liftedFns.push({
        name,
        params: [],
        returnType: JSVAL,
        locals: ctx.locals,
        captures: ctx.captures ?? [],
        body,
        ...(isAsync ? { async: true as const } : {}),
        loc,
      });
    } finally {
      L.fnStack.pop();
    }
    return name;
  }

/** One export's island value for the namespace object — the jsvalIn
   * marshal set (primitives and JSON-safe composites by deep copy, units as
   * the engine's own, marshalable closures as host functions, jsval-bearing
   * composites through the per-field lift), with every UN-marshalable
   * export crossing as a trap function that throws a pointed TypeError when
   * called or constructed — the namespace still builds (Node resolves it;
   * only the USE has no compiled story). Null for exports that do not exist
   * at runtime (type-only). */
  function exportJsvalValue(L: Lowerer, name: string, sym: ts.Symbol, loc: IrExpr["loc"]): IrExpr | null {
    const trap = (what: string): IrExpr =>
      islandTrapFnValue(
        L,
        `the '${name}' export is ${what} of the compiled program, which cannot cross into dynamically-executed code yet`,
        loc,
      );
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      // `export type { x }` / `export { type x }`: erased at runtime.
      for (const d of L.checker.declarationsOf(sym)) {
        if (ts.isExportSpecifier(d)) {
          const exportDecl = d.parent.parent;
          if (d.isTypeOnly || (ts.isExportDeclaration(exportDecl) && exportDecl.isTypeOnly)) return null;
        }
        if (ts.isImportSpecifier(d)) {
          const clause = d.parent.parent;
          if (d.isTypeOnly || (ts.isImportClause(clause) && clause.phaseModifier === ts.SyntaxKind.TypeKeyword)) return null;
        }
      }
      resolved = L.checker.getAliasedSymbol(sym);
    }
    if (!(resolved.flags & ts.SymbolFlags.Value)) return null; // pure type surface
    const g = L.globalsBySymbol.get(resolved);
    if (g) {
      const ref: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
      if (ref.type.kind === "jsval") return ref;
      if (isUnitType(ref.type)) {
        return { kind: "jsOp", op: ref.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc };
      }
      if (ref.type.kind === "func") {
        return canMarshalTypedFuncIntoIsland(ref.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))
          ? { kind: "jsMarshal", value: ref, type: JSVAL, loc }
          : trap(`a function value of type '${L.fmt(ref.type)}'`);
      }
      if (L.boundarySafe(ref.type)) return { kind: "jsMarshal", value: ref, type: JSVAL, loc };
      if (L.jsvalLiftable(ref.type)) return L.jsvalLiftExpr(ref, loc);
      return trap(`a value of type '${L.fmt(ref.type)}'`);
    }
    const sig = L.fnSigsBySymbol.get(resolved);
    const decl0 = L.checker.declarationsOf(resolved).find(
      (d) => ts.isFunctionDeclaration(d) && (ts.isSourceFile(d.parent) || L.nsBlocks.get(d.parent) === "flattened"),
    );
    if (sig && decl0) {
      if (!sig.params.every((p) => p.mode === "required")) {
        return trap("a function with optional, default, or rest parameters");
      }
      const funcType: IrType & { kind: "func" } = {
        kind: "func",
        params: sig.params.map((p) => p.type),
        ret: sig.returnType,
      };
      if (!canMarshalTypedFuncIntoIsland(funcType, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
        return trap(`a function of type '${L.fmt(funcType)}'`);
      }
      L.noteEdge(sig.name);
      return {
        kind: "jsMarshal",
        value: { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc },
        type: JSVAL,
        loc,
      };
    }
    if (L.genericFnsBySymbol.has(resolved)) return trap("a generic function");
    const flags = resolved.flags;
    if (flags & ts.SymbolFlags.Class) return trap("a class");
    if (flags & ts.SymbolFlags.Enum) return trap("an enum object");
    if (flags & ts.SymbolFlags.ValueModule || flags & ts.SymbolFlags.NamespaceModule) {
      return trap("a namespace object");
    }
    return trap("a binding");
  }

/** An engine value whose any USE throws: `new Function("<throw>")` — a
   * real engine function, so the namespace member reads back fine (Node's
   * namespace holds the value too), property probes answer like a
   * function's, and calling or `new`-ing it runs the body, which throws
   * the pointed TypeError. */
  function islandTrapFnValue(L: Lowerer, message: string, loc: IrExpr["loc"]): IrExpr {
    void L;
    const code = `throw new TypeError(${JSON.stringify(message)})`;
    return {
      kind: "jsOp",
      op: "construct",
      args: [
        { kind: "jsOp", op: "globalGet", name: "Function", args: [], type: JSVAL, loc },
        { kind: "jsMarshal", value: { kind: "strLit", value: code, type: STRING, loc }, type: JSVAL, loc },
      ],
      type: JSVAL,
      loc,
    };
  }

/** An object literal built NATIVELY in the island — one engine object,
   * each field marshaled individually (nested object/array literals
   * recurse, island handles pass straight through, everything else takes
   * the JSON-safe copy-marshal). The same jsOp the 'any'-contextual
   * literal path emits, callable from lowerings that KNOW the literal is
   * island-bound (fetch's init) even when the contextual type is a union
   * the generic path declines. Identifier AND string-literal keys — engine
   * property names have no identifier restriction ("content-type"). */
  export function lowerIslandObjectLiteral(L: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
    const loc = locOf(expr);
    const args: IrExpr[] = [];
    for (const prop of expr.properties) {
      if (
        !ts.isPropertyAssignment(prop) ||
        !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ) {
        L.unsupported(
          "SC1090",
          prop,
          "this property form in an island-built object literal (only `name: value` is supported)",
        );
      }
      const nameLoc = locOf(prop.name);
      args.push({
        kind: "jsMarshal",
        value: { kind: "strLit", value: prop.name.text, type: STRING, loc: nameLoc },
        type: JSVAL, loc: nameLoc,
      });
      const init = prop.initializer;
      if (ts.isObjectLiteralExpression(init)) {
        args.push(lowerIslandObjectLiteral(L, init));
      } else if (ts.isArrayLiteralExpression(init) && !init.elements.some(ts.isSpreadElement)) {
        const elems = init.elements.map((el) => L.jsvalIn(L.lowerExpr(el), el));
        args.push({ kind: "jsOp", op: "arrLit", args: elems, type: JSVAL, loc: locOf(init) });
      } else {
        args.push(L.jsvalIn(L.lowerExpr(init), init));
      }
    }
    return { kind: "jsOp", op: "objLit", args, type: JSVAL, loc };
  }

/** Method calls on the island-backed ambient surface: `Math.<fn>(...)`
   * (the engine's own Math object executes) and the number/string methods
   * the static runtime doesn't implement (`x.toPrecision(2)`,
   * `s.replace("a", "b")`, ...). Each site is self-contained — the receiver
   * and arguments marshal in, the engine executes with JS-exact semantics,
   * and the result exits (validated) to the DECLARED static return type,
   * so no jsval leaks into the program's types. tsc has already checked
   * receiver, arity, and argument types against ambient/scriptc.d.ts; an
   * ambient member missing from ISLAND_SURFACE returns null into the
   * existing generic rejections. */
  export function lowerIslandMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(access, call)) return null;
    const name = access.name.text;
    const loc = locOf(call);
    const finish = (receiver: IrExpr, entry: IslandFnEntry): IrExpr => {
      const args = call.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
      const result: IrExpr = {
        kind: "jsOp", op: "callMethod", name, args: [receiver, ...args], type: JSVAL, loc,
      };
      return { kind: "jsExit", value: result, type: entry.ret, loc };
    };
    // `AbortSignal.timeout(ms)` / `.abort(reason?)` / `.any(signals)` —
    // the fetch-cancellation ambient: the engine's own AbortSignal mints
    // the signal, which stays a HANDLE (its checker type, AbortSignal,
    // maps to jsval — see ISLAND_AMBIENT_TYPES) so it can ride a
    // RequestInit literal into fetch without a JSON detour. The prelude
    // implements all three statics.
    {
      const sigMember = L.stdlibGlobalMember(access, "AbortSignal");
      if (
        (sigMember === "timeout" || sigMember === "abort" || sigMember === "any") &&
        call.arguments.length <= 1 &&
        (sigMember === "abort" || call.arguments.length === 1)
      ) {
        L.requireDynamicApi(`'AbortSignal.${sigMember}'`, call);
        const args = call.arguments.map((a) => L.jsvalIn(L.lowerExpr(a), a));
        const signalGlobal: IrExpr = {
          kind: "jsOp", op: "globalGet", name: "AbortSignal", args: [], type: JSVAL, loc,
        };
        return {
          kind: "jsOp", op: "callMethod", name: sigMember,
          args: [signalGlobal, ...args], type: JSVAL, loc,
        };
      }
    }
    const isMath = L.stdlibGlobalMember(access, "Math") !== null;
    // The STATIC Math members (floor/min/max/random): one C call IS the
    // JS operation — no island, no --dynamic. Only the tabled arity with
    // plain (non-spread) arguments takes this path; other forms fall
    // through to the spread fold / island / lib fence below.
    const staticMath = isMath ? own(STATIC_MATH_FNS, name) : undefined;
    if (
      staticMath &&
      call.arguments.every((a) => !ts.isSpreadElement(a))
    ) {
      // Math.max/Math.min at ANY plain arity — Node's are variadic. The
      // spec's reduction is a left fold of the same NaN-poisoning
      // ±0-ordered scalar compare the two-arg form lowers to, so n
      // arguments nest n-1 scalar calls (arguments still evaluate left to
      // right, before any compare that involves them). One argument is
      // the value itself (every argument here is number-typed, so the
      // spec's ToNumber is the identity — NaN included), and zero
      // arguments are the fold's seed: -Infinity for max, +Infinity for
      // min, exactly Node.
      if (name === "max" || name === "min") {
        if (call.arguments.length === 0) {
          return { kind: "numLit", value: name === "max" ? -Infinity : Infinity, type: F64, loc };
        }
        const args = call.arguments.map((a) => L.lowerExprExpecting(a, F64));
        let acc = args[0]!;
        for (let i = 1; i < args.length; i++) {
          acc = { kind: "libCall", fn: staticMath.fn, args: [acc, args[i]!], type: F64, loc };
        }
        return acc;
      }
      if (call.arguments.length === staticMath.arity) {
        const args = call.arguments.map((a) => L.lowerExprExpecting(a, F64));
        return { kind: "libCall", fn: staticMath.fn, args, type: F64, loc };
      }
    }
    // `Math.max(...xs)` / `Math.min(...xs)` over a number[]: a STATIC
    // runtime fold (JS-exact: NaN poisons, ±0 order by the JS rules, the
    // empty array yields ∓Infinity like the zero-arg calls) — no island
    // involved, so it works without --dynamic too. Only the exact
    // one-spread form lowers; mixed spread/positional argument lists keep
    // the nest-calls fence.
    if (
      isMath &&
      (name === "max" || name === "min") &&
      call.arguments.length === 1 &&
      ts.isSpreadElement(call.arguments[0]!)
    ) {
      const spread = call.arguments[0]! as ts.SpreadElement;
      const src = L.lowerExpr(spread.expression);
      if (src.type.kind !== "array" || src.type.elem.kind !== "f64") {
        L.unsupported(
          "SC1090",
          spread,
          `spreading '${L.fmt(src.type)}' into Math.${name} (only a number[] spreads)`,
        );
      }
      return {
        kind: "libCall",
        fn: name === "max" ? "math.maxArr" : "math.minArr",
        args: [src],
        type: F64,
        loc,
      };
    }
    const mathFn = isMath ? own(ISLAND_SURFACE.math.fns, name) : undefined;
    if (mathFn && call.arguments.length === mathFn.args.length) {
      L.requireDynamicApi(`'Math.${name}'`, call);
      return finish(
        { kind: "jsOp", op: "globalGet", name: "Math", args: [], type: JSVAL, loc },
        mathFn,
      );
    }
    const kind = L.mapTypeOf(L.typeOf(access.expression))?.kind;
    const entry =
      kind === "f64"
        ? own(ISLAND_SURFACE.number, name)
        : kind === "string"
          ? own(ISLAND_SURFACE.string, name)
          : undefined;
    if (!entry || call.arguments.length !== entry.args.length) return null;
    if (!L.isStdlibMember(access)) return null;
    L.requireDynamicApi(
      `'.${name}()' on ${kind === "f64" ? "numbers" : "strings"}`,
      call,
    );
    return finish(L.jsvalIn(L.lowerExpr(access.expression), access.expression), entry);
  }

/** `Math.PI` / `Math.E` property READS: getProp off globalGet("Math"),
   * exiting to the declared number type. Math methods referenced without a
   * call are rejected specifically (no value form exists, --dynamic or
   * not). Null for non-Math receivers (the property chain keeps trying). */
  export function lowerMathProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    const member = L.stdlibGlobalMember(expr, "Math");
    if (member === null) return null;
    const loc = locOf(expr);
    const propType = own(ISLAND_SURFACE.math.props, member);
    if (propType !== undefined) {
      L.requireDynamicApi(`'Math.${member}'`, expr);
      const math: IrExpr = { kind: "jsOp", op: "globalGet", name: "Math", args: [], type: JSVAL, loc };
      const read: IrExpr = { kind: "jsOp", op: "getProp", name: member, args: [math], type: JSVAL, loc };
      return { kind: "jsExit", value: read, type: propType, loc };
    }
    if (
      own(ISLAND_SURFACE.math.fns, member) !== undefined ||
      own(STATIC_MATH_FNS, member) !== undefined
    ) {
      L.unsupported("SC1090", expr, `Math methods as values (call '${member}' directly)`);
    }
    return null; // declared-but-untabled members fall through generically
  }

/** The npm package a type is declared by ("commander", "@scope/pkg"),
   * or null when the type isn't package-declared. Union parts are searched
   * too: `string | Command` fails mapping as a whole, but the blame (and
   * the --dynamic attribution) belongs to the package-declared part. */
  export function npmPackageOf(L: Lowerer, type: ts.Type): string | null {
    const pkg = L.npmPackageOfSymbol(type.getAliasSymbol() ?? type.getSymbol());
    if (pkg) return pkg;
    if (type.isUnionType()) {
      for (const part of type.getTypes()) {
        const partPkg = L.npmPackageOf(part);
        if (partPkg) return partPkg;
      }
    }
    return null;
  }

/** The npm chokepoint for member reads and method calls in a STATIC
   * build: a receiver whose type (or member whose symbol) a package's
   * .d.ts declares means the operation runs in the embedded engine —
   * attribute the site to the package instead of the generic property/
   * method rejection. No-op under --dynamic (the island paths claimed
   * these) and for non-package receivers, so callers' fallbacks apply. */
  export function npmMemberFence(L: Lowerer, access: ts.PropertyAccessExpression): void {
    if (L.dynamic) return;
    const pkg =
      L.npmPackageOf(L.typeOf(access.expression)) ??
      L.npmPackageOfSymbol(L.checker.getSymbolAtLocation(access.name));
    if (!pkg) return;
    L.pushDiag(requiresDynamicPackageDiag(pkg, locOf(access)));
    throw new PoisonError();
  }

/** The npm package a SYMBOL is declared by, or null. The symbol half of
   * npmPackageOf, also asked directly for import-alias bindings (whose
   * aliased symbol is the package's export). */
  export function npmPackageOfSymbol(L: Lowerer, sym: ts.Symbol | undefined): string | null {
    const decls = sym ? L.checker.declarationsOf(sym) : undefined;
    if (!decls || decls.length === 0) return null;
    if (!decls.every((d) => L.isNpmFile(d.getSourceFile()))) return null;
    return npmPackageNameOf(decls[0]!.getSourceFile().fileName);
  }
