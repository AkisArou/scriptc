/* The node:events EventEmitter lowering (the spoke-module pattern, like
 * lower-server.ts): every EMITTER_API_MEMBERS method call on a receiver
 * whose class roots at %EventEmitter lands here, from
 * lowerObjectMethodCall.
 *
 * THE TYPING STANCE. Node types EventEmitter untyped — `emit(name,
 * ...args: any[])`, listeners `(...args: any[]) => void` — which has no
 * static lowering. The honest model here is per-event monomorphization:
 * event names must be compile-time string literals (the net/http/process
 * precedent), and each event name gets ONE argument tuple, unified across
 * the whole program (a pre-pass scans every emit site's argument types
 * and every registered listener's annotated parameter types). Emit sites
 * must supply exactly the tuple; listeners may declare any PREFIX of it
 * (Node calls listeners with all arguments; extra parameters would read
 * undefined and have no honest type). The table is program-global, not
 * per-class: every emitter class shares the %EventEmitter root and
 * upcasts alias freely, so per-class tables would be unsound. The JS
 * lane's unannotated listeners (checker `any` — dyn) do not fence: they
 * register through the checked-dynamic boundary (lowerDynListenerCall —
 * emit arguments box to dyn, JS-exact arity, the original kept as the
 * registry entry's identity). What the static model cannot carry is
 * fenced with its own words: non-literal names, symbol names,
 * conflicting tuples, the meta-events' listener-function argument (meta
 * listeners take at most the event name; dyn meta listeners fence — Node
 * passes the listener function second, which has no dyn conversion), and
 * listeners()/rawListeners() of an event with any dyn-flavored
 * registration (the bucket has no one honest element type).
 *
 * Two special names: 'error' is forced to the one-%Error tuple (emit
 * routes through emitter.emitError — no listener means the payload
 * THROWS, Node's contract — and subclass payloads upcast to the root);
 * 'newListener'/'removeListener' are forced to the one-string tuple (the
 * runtime emits them internally with the affected event's name). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynFallbackType } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { locOf } from "../program.js";
import { arrayOf, BOOL, canBoxFuncIntoDyn, canConvertToDyn, DYN, F64, IrExpr, IrStmt, IrType, isUnitType, STRING, SrcLoc, typeEquals, typeKey, VOID } from "../../ir/nodes.js";
import { streamForcedTuple, streamSidesOf } from "./lower-stream.js";

/** True when the class descends from (or is) the runtime emitter. */
export function emitterRooted(L: Lowerer, info: ClassInfo | undefined | null): boolean {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinEmitter) return true;
  }
  return false;
}

const REGISTER_MEMBERS: ReadonlySet<string> = new Set([
  "on", "addListener", "once", "prependListener", "prependOnceListener",
]);

const META_EVENTS: ReadonlySet<string> = new Set(["newListener", "removeListener"]);

interface EventSig {
  /** The unified argument tuple, positions in emit order. */
  tuple: IrType[];
  /** True once ANY emit site pinned the arity/types (listeners may then
   * only prefix it; without one, the longest listener defines the tuple). */
  fromEmit: boolean;
  /** A human-readable conflict, reported at every touching site. */
  conflict: string | null;
  /** True when ANY registration site's listener is dyn-flavored (a
   * checked-dynamic value, or a function whose parameters include dyn —
   * the JS lane's unannotated listeners). Such listeners register through
   * a dyn-converting adapter; they impose no tuple constraint (a dyn
   * parameter takes anything, including undefined beyond the tuple), and
   * the event's runtime bucket may hold originals of MIXED signatures —
   * so listeners()/rawListeners() have no one honest element type. */
  dynListener: boolean;
}

/** The program-wide event-signature table, built lazily on the first
 * emitter lowering (class shapes are collected before any body lowers, so
 * receiver classes resolve). The scan is DIAGNOSTIC-FREE: unmappable
 * types and non-literal names are simply not candidates — the touching
 * sites speak for themselves when they lower. */
function emitterEvents(L: Lowerer): Map<string, EventSig> {
  const holder = L as unknown as { emitterEventTable?: Map<string, EventSig> };
  if (holder.emitterEventTable) return holder.emitterEventTable;
  const table = new Map<string, EventSig>();
  const sigOf = (name: string): EventSig => {
    let sig = table.get(name);
    if (!sig) table.set(name, (sig = { tuple: [], fromEmit: false, conflict: null, dynListener: false }));
    return sig;
  };
  // The two forced tuples (see the header comment).
  table.set("error", { tuple: [{ kind: "object", className: "%Error" }], fromEmit: true, conflict: null, dynListener: false });
  table.set("newListener", { tuple: [STRING], fromEmit: true, conflict: null, dynListener: false });
  table.set("removeListener", { tuple: [STRING], fromEmit: true, conflict: null, dynListener: false });

  const fmt = (t: IrType): string => L.fmt(t);
  const mergeEmit = (name: string, args: (IrType | null)[]): void => {
    if (args.some((a) => a === null)) return; // its own site will diagnose
    const tuple = args as IrType[];
    const sig = sigOf(name);
    if (sig.conflict) return;
    if (!sig.fromEmit) {
      // Listener prefixes seen so far must fit under this tuple.
      if (sig.tuple.length > tuple.length) {
        sig.conflict = `a listener declares ${sig.tuple.length} parameters but an emit supplies ${tuple.length} arguments`;
        return;
      }
      for (let i = 0; i < sig.tuple.length; i++) {
        if (!typeEquals(sig.tuple[i]!, tuple[i]!)) {
          sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(tuple[i]!)}' at another`;
          return;
        }
      }
      sig.tuple = tuple;
      sig.fromEmit = true;
      return;
    }
    if (sig.tuple.length !== tuple.length) {
      sig.conflict = `emit sites supply ${sig.tuple.length} and ${tuple.length} arguments`;
      return;
    }
    for (let i = 0; i < tuple.length; i++) {
      if (!typeEquals(sig.tuple[i]!, tuple[i]!)) {
        sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(tuple[i]!)}' at another`;
        return;
      }
    }
  };
  const mergeListener = (name: string, params: (IrType | null)[]): void => {
    if (params.some((p) => p === null)) return;
    const prefix = params as IrType[];
    const sig = sigOf(name);
    if (sig.conflict) return;
    if (sig.fromEmit) {
      if (prefix.length > sig.tuple.length) {
        sig.conflict = `a listener declares ${prefix.length} parameters but emits supply ${sig.tuple.length} arguments`;
        return;
      }
    } else if (prefix.length > sig.tuple.length) {
      // The longest listener extends the provisional tuple.
      for (let i = 0; i < sig.tuple.length; i++) {
        if (!typeEquals(sig.tuple[i]!, prefix[i]!)) {
          sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(prefix[i]!)}' at another`;
          return;
        }
      }
      sig.tuple = prefix;
      return;
    }
    for (let i = 0; i < prefix.length; i++) {
      if (!typeEquals(sig.tuple[i]!, prefix[i]!)) {
        sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(prefix[i]!)}' at another`;
        return;
      }
    }
  };

  for (const sf of L.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const member = node.expression.name.text;
      const isEmit = member === "emit";
      if (!isEmit && !REGISTER_MEMBERS.has(member)) return;
      const arg0 = node.arguments[0];
      if (!arg0) return;
      let recvT: IrType | null = null;
      let nameT: ts.Type | null = null;
      try {
        recvT = L.mapTypeOf(L.typeOf(node.expression.expression));
        nameT = L.typeOf(arg0);
      } catch {
        return; // checker trouble is the lowering's business, not the scan's
      }
      if (recvT?.kind !== "object" || !emitterRooted(L, L.classes.get(recvT.className))) return;
      if (!nameT.isStringLiteralType()) return;
      const name = nameT.value;
      if (META_EVENTS.has(name) || name === "error") return; // forced tuples
      // Stream receivers' runtime-emitted events carry PER-BASE forced
      // tuples (lower-stream.ts) — their sites never join the program-
      // global table, so a stream's 'data' cannot collide with a user
      // event named 'data' on a plain emitter.
      if (streamForcedTuple(L, L.classes.get(recvT.className), name) !== null) return;
      try {
        if (isEmit) {
          mergeEmit(name, node.arguments.slice(1).map((a) => L.mapTypeOf(L.typeOf(a))));
        } else if (node.arguments[1]) {
          const cbCt = L.typeOf(node.arguments[1]);
          const cbT = L.mapTypeOf(cbCt) ?? dynFallbackType(L, node.arguments[1], cbCt);
          // Dyn-flavored listeners (a checked-dynamic value, or a func
          // with dyn parameters — the JS lane) register through the
          // adapter and constrain nothing: a dyn parameter accepts any
          // tuple position, and positions past the tuple read the boxed
          // undefined (exactly JS's extra-parameter semantics).
          if (cbT?.kind === "dyn" || (cbT?.kind === "func" && cbT.params.some((p) => p.kind === "dyn"))) {
            sigOf(name).dynListener = true;
          } else if (cbT?.kind === "func") {
            mergeListener(name, cbT.params);
          }
        }
      } catch {
        /* not a candidate */
      }
    };
    walk(sf);
  }
  holder.emitterEventTable = table;
  return table;
}

/** The compile-time event name of the first argument, or a pointed fence
 * (string-literal TYPE, so const bindings and literal unions of one
 * member count — the staticHeaderKeyOf stance). */
function eventNameOf(L: Lowerer, member: string, arg: ts.Expression): string {
  const t = L.typeOf(arg);
  if (t.isStringLiteralType()) return t.value;
  L.noLowering(
    `${member} with a non-literal event name`,
    arg,
    "event names must be compile-time string literals (each event's argument tuple is unified statically; symbol names have no lowering)",
  );
}

const strLit = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const boolLit = (value: boolean, loc: SrcLoc): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });

/** The event's unified tuple, with conflicts reported at this site. */
function tupleOf(L: Lowerer, table: Map<string, EventSig>, name: string, blame: ts.Node): IrType[] {
  const sig = table.get(name);
  if (!sig) return [];
  if (sig.conflict) {
    L.noLowering(
      `the event '${name}' with conflicting argument types`,
      blame,
      `every emit site and listener of one event name must agree on one argument tuple — ${sig.conflict}`,
    );
  }
  return sig.tuple;
}

/** How a listener argument is dyn-flavored: "dyn" for a checked-dynamic
 * VALUE (a mustCall wrapper, a listener that rode an untyped binding),
 * "func" for a function whose parameters include dyn (the JS lane's
 * unannotated listeners — their checker type is any). Null for everything
 * else (the static path, with its own diagnostics). */
function dynListenerFlavor(L: Lowerer, node: ts.Expression): "dyn" | "func" | null {
  let t: IrType | null;
  try {
    const ct = L.typeOf(node);
    // The JS declaration fallback is what the EXPRESSION lowering applies
    // to inference residue (an inline `(a) => {}` maps null as a checker
    // type but lowers as a dyn-parameter function) — classify by the same
    // rule, so the flavor always matches what lowerExpr will produce.
    t = L.mapTypeOf(ct) ?? dynFallbackType(L, node, ct);
  } catch {
    return null;
  }
  if (t?.kind === "dyn") return "dyn";
  if (t?.kind === "func") return t.params.some((p) => p.kind === "dyn") ? "func" : null;
  // A statically-known NON-function listener (a literal number, a record,
  // null): route it through the dyn path too — the registration helper's
  // checkListener throws Node's exact ERR_INVALID_ARG_TYPE TypeError
  // (the TS lane never reaches this: tsc rejects the argument first).
  if (t && t.kind !== "jsval" && (isUnitType(t) || canConvertToDyn(t, (id) => L.shapes.get(id), (id) => L.unions.get(id)))) {
    return "dyn";
  }
  return null;
}

/** A dyn-flavored listener registration/removal (the JS lane's unannotated
 * listeners, and mustCall-style wrapped ones): the listener registers as a
 * checked-dynamic value through an interned helper —
 *
 *   %emitter.onDyn.<n>(recv, name, cb, once, prepend) {
 *     emitter.checkListener(cb);          // Node's ERR_INVALID_ARG_TYPE
 *     const a: (tuple) => void = cb;      // dynCheck: the boxing adapter
 *     return emitter.onDyn(recv, name, cb, a, once, prepend);
 *   }
 *
 * The dynCheck adapter boxes each emitted tuple argument to dyn and calls
 * the original through the checked-dynamic call machinery — JS-exact
 * arity (parameters past the tuple read undefined, extra arguments are
 * ignored). The runtime entry registers the ADAPTER for dispatch but
 * keeps the ORIGINAL (the dyn box's underlying closure) as the entry's
 * identity, so off/removeListener and listenerCount(name, fn) match it.
 * The helper shape exists because cb must evaluate ONCE and feed both
 * roles. Fenced honestly: tuple positions that cannot box to dyn (class
 * payloads — 'error' events), and the meta events (Node passes the
 * listener FUNCTION second, which has no dyn conversion — a dyn listener
 * reading it would see undefined). */
function lowerDynListenerCall(
  L: Lowerer,
  member: string,
  name: string,
  tuple: IrType[],
  receiver: IrExpr,
  cbNode: ts.Expression,
  flavor: "dyn" | "func",
  registering: boolean,
  once: boolean,
  prepend: boolean,
  loc: SrcLoc,
  /** Stream 'data': the adapter registers through emitter.onDataDyn so
   * the backend emits the two-slot DATA thunk (box by runtime tag); the
   * tuple is [DYN] — the adapter passes the boxed chunk through. */
  streamData: boolean,
): IrExpr {
  if (META_EVENTS.has(name)) {
    L.noLowering(
      `'${member}' of '${name}' with a checked-dynamic listener`,
      cbNode,
      "Node passes the listener FUNCTION as the meta event's second argument, which has no dynamic conversion — annotate the listener's parameter as a string",
    );
  }
  const getRecord = (id: string) => L.shapes.get(id);
  const getUnion = (id: string) => L.unions.get(id);
  for (let i = 0; i < tuple.length; i++) {
    const p = tuple[i]!;
    if (p.kind !== "dyn" && !canConvertToDyn(p, getRecord, getUnion)) {
      L.noLowering(
        `'${member}' of '${name}' with a checked-dynamic listener`,
        cbNode,
        `the event's argument ${i} is '${L.fmt(p)}', which cannot box into a dynamic value — annotate the listener's parameters with the emitted types`,
      );
    }
  }
  let cbDyn: IrExpr;
  if (flavor === "dyn") {
    const v = L.lowerExpr(cbNode);
    if (v.type.kind === "dyn") {
      cbDyn = v;
    } else if (v.kind === "unitLit" || canConvertToDyn(v.type, getRecord, getUnion)) {
      // A non-dyn residue the classification saw as dynamic (a literal
      // null/undefined listener, a convertible scalar): box it — the
      // checkListener call answers with Node's exact TypeError.
      cbDyn = { kind: "dynFrom", value: v, type: DYN, loc };
    } else {
      L.noLowering(`'${member}' with a non-function listener`, cbNode);
    }
  } else {
    const cb = L.lowerExpr(cbNode);
    if (cb.type.kind !== "func" || !canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      L.noLowering(
        `'${member}' with a listener of this signature`,
        cbNode,
        "a checked-dynamic listener's own parameters and return must box across the dynamic boundary",
      );
    }
    cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
  }
  const recvT = receiver.type;
  const adapterT: IrType = { kind: "func", params: tuple, ret: VOID };
  const onFn = streamData ? "emitter.onDataDyn" as const : "emitter.onDyn" as const;
  const key = registering
    ? `${onFn}:${typeKey(recvT)}:${typeKey(adapterT)}`
    : `emitter.offDyn:${typeKey(recvT)}`;
  const existing = L.arrHofHelpers.get(key);
  let helper = existing;
  if (!helper) {
    helper = `%emitter.${registering ? "onDyn" : "offDyn"}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
    const check: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "emitter.checkListener", args: [ref("cb.0", DYN)], type: VOID, loc },
      loc,
    };
    const params = [
      { localId: "r.0", name: "r", type: recvT },
      { localId: "n.0", name: "n", type: STRING },
      { localId: "cb.0", name: "cb", type: DYN },
      ...(registering
        ? [
            { localId: "o.0", name: "o", type: BOOL },
            { localId: "p.0", name: "p", type: BOOL },
          ]
        : []),
    ];
    const locals = params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false }));
    let body: IrStmt[];
    if (registering) {
      locals.push({ id: "a.0", name: "a", type: adapterT, mutable: false });
      body = [
        check,
        { kind: "varDecl", localId: "a.0", init: { kind: "dynCheck", value: ref("cb.0", DYN), type: adapterT, loc }, loc },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: onFn,
            args: [ref("r.0", recvT), ref("n.0", STRING), ref("cb.0", DYN), ref("a.0", adapterT), ref("o.0", BOOL), ref("p.0", BOOL)],
            type: recvT,
            loc,
          },
          loc,
        },
      ];
    } else {
      body = [
        check,
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "emitter.offDyn",
            args: [ref("r.0", recvT), ref("n.0", STRING), ref("cb.0", DYN)],
            type: recvT,
            loc,
          },
          loc,
        },
      ];
    }
    L.liftedFns.push({ name: helper, params, returnType: recvT, locals, body, loc });
  }
  return {
    kind: "call",
    callee: helper,
    args: registering
      ? [receiver, strLit(name, loc), cbDyn, boolLit(once, loc), boolLit(prepend, loc)]
      : [receiver, strLit(name, loc), cbDyn],
    type: recvT,
    loc,
  };
}

/** A listener argument: lowered, checked void-returning, and its
 * parameters checked as a typeEquals PREFIX of the event tuple. */
function lowerListenerArg(
  L: Lowerer,
  member: string,
  name: string,
  node: ts.Expression,
  tuple: IrType[],
): IrExpr {
  // Unannotated non-empty parameter lists have no static types (checker
  // `any`; dyn in JS sources) — say so before the blanket type fence speaks.
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length > 0) {
    for (const p of node.parameters) {
      if (p.type === undefined && ts.isIdentifier(p.name)) {
        const mapped = (() => {
          try {
            return L.mapTypeOf(L.typeOf(p.name));
          } catch {
            return null;
          }
        })();
        if (mapped === null || mapped.kind === "dyn" || mapped.kind === "jsval") {
          L.noLowering(
            `'${member}' listeners with unannotated parameters`,
            p,
            "EventEmitter's declared listener type is (...args: any[]) — annotate each parameter with the emitted argument's type",
          );
        }
      }
    }
  }
  const cb = L.lowerExpr(node);
  if (cb.type.kind !== "func") {
    L.noLowering(`'${member}' with a non-function listener`, node);
  }
  const cbT = cb.type as IrType & { kind: "func" };
  // Node ignores listener return values, so value-returning listeners
  // (expression-body arrows, mustCall wrappers) register fine — the
  // emitted invoke adapter calls through the listener's true signature
  // and discards (releasing refcounted results). An async listener's
  // promise is abandoned unobserved (SEMANTICS.md).
  if (META_EVENTS.has(name) && cbT.params.length > 1) {
    L.noLowering(
      `'${name}' listeners taking the listener-function argument`,
      node,
      "meta-event listeners take at most the event name (the listener argument has no unified static type)",
    );
  }
  if (cbT.params.length > tuple.length) {
    L.noLowering(
      `a '${name}' listener declaring ${cbT.params.length} parameters where the event's tuple has ${tuple.length}`,
      node,
      "listeners may declare a prefix of the event's emitted arguments",
    );
  }
  for (let i = 0; i < cbT.params.length; i++) {
    if (!typeEquals(cbT.params[i]!, tuple[i]!)) {
      L.noLowering(
        `a '${name}' listener whose parameter ${i} is '${L.fmt(cbT.params[i]!)}' where the event's tuple has '${L.fmt(tuple[i]!)}'`,
        node,
        "every emit site and listener of one event name must agree on one argument tuple",
      );
    }
  }
  return cb;
}

/** `recv.<member>(...)` over an emitter-rooted receiver — the whole
 * EventEmitter method surface. Returns null only for members this spoke
 * does not own (the caller falls through to its own fences). */
export function lowerEmitterMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, info: ClassInfo): IrExpr | null {
  const member = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  // The class VALUE, not an instance (`EventEmitter.setMaxListeners(n)` —
  // the receiver's checker type carries construct signatures; mapType
  // answers the instance object for every EventEmitter-symbol type, so the
  // instance dispatch conflated the two and handed the instance libCalls a
  // receiver that lowers to the class value, the setMax ICE). The statics
  // are a DIFFERENT surface: setMaxListeners(n) writes the process-wide
  // defaultMaxListeners (validated at runtime — Node's ERR_OUT_OF_RANGE);
  // everything else fences by its static name.
  if (L.checker.getConstructSignatures(L.typeOf(access.expression)).length > 0) {
    if (member === "setMaxListeners" && args.length === 1) {
      if (L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "f64") {
        // Node's runtime ladder over the dyn value ("setMaxListeners" is
        // the message's slot for the static form).
        const raw = L.lowerExpr(args[0]!);
        if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
          const n: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
          return {
            kind: "libCall",
            fn: "emitter.setDefaultMaxChk",
            args: [n, { kind: "strLit", value: "setMaxListeners", type: STRING, loc }],
            type: VOID,
            loc,
          };
        }
      }
      const n = L.lowerExprExpecting(args[0]!, F64);
      if (n.type.kind !== "f64") {
        L.noLowering(
          `EventEmitter.setMaxListeners with a '${L.fmt(n.type)}' argument`,
          args[0]!,
          "the lowered form takes a number (Node throws ERR_INVALID_ARG_TYPE at runtime for other values)",
        );
      }
      return { kind: "libCall", fn: "emitter.setDefaultMax", args: [n], type: VOID, loc };
    }
    if (member === "setMaxListeners") {
      // The per-target form with a target that is provably NOT an
      // emitter/EventTarget (the invalid-input probes): Node validates n
      // first, then throws ERR_INVALID_ARG_TYPE on the target. Claimed
      // when n is a pure read (identifier/literal — nothing to evaluate)
      // and the target crosses into the checked-dynamic tree for the Received tail.
      if (args.length === 2 && !args.some(ts.isSpreadElement)) {
        const nT = L.mapTypeOf(L.typeOf(args[0]!));
        const tT = L.mapTypeOf(L.typeOf(args[1]!));
        const nPure = ts.isIdentifier(args[0]!) || ts.isLiteralExpression(args[0]!);
        const targetNotEmitter =
          tT !== null && tT.kind !== "dyn" && tT.kind !== "jsval" &&
          !(tT.kind === "object");
        if (nT?.kind === "f64" && nPure && targetNotEmitter) {
          const raw = L.lowerExpr(args[1]!);
          if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
            const got: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
            return {
              kind: "libCall",
              fn: "error.argTypeThrow",
              args: [
                { kind: "strLit", value: "eventTargets", type: STRING, loc },
                { kind: "strLit", value: "an instance of EventEmitter or EventTarget", type: STRING, loc },
                got,
              ],
              type: VOID,
              loc,
            };
          }
        }
      }
      L.noLowering(
        `EventEmitter.setMaxListeners with ${args.length} arguments`,
        call,
        "the lowered static form is EventEmitter.setMaxListeners(n) — per-target application (…, ...eventTargets) has no lowering; call target.setMaxListeners(n) instead",
      );
    }
    L.noLowering(
      `the static EventEmitter.${member} form`,
      call,
      "instance emitters lower this member; the class-value statics have no lowering yet",
    );
  }
  const table = emitterEvents(L);

  if (REGISTER_MEMBERS.has(member) || member === "off" || member === "removeListener") {
    if (args.length !== 2) {
      L.noLowering(`${member} with ${args.length} arguments`, call, "the supported form is (eventName, listener)");
    }
    const name = eventNameOf(L, member, args[0]!);
    const receiver = L.lowerExpr(access.expression);
    const registering = REGISTER_MEMBERS.has(member);
    const once = member === "once" || member === "prependOnceListener";
    const prepend = member === "prependListener" || member === "prependOnceListener";
    // Stream 'data' rides its own two-slot payload ABI (bytes + string —
    // encoded streams deliver strings; scr_stream_emit_data): listeners
    // on readable-sided receivers register through DATA thunks that
    // unwrap the declared side (typed) or box by tag (dyn).
    const sides = streamSidesOf(L, info);
    if (name === "data" && (sides === "r" || sides === "rw")) {
      const dynFlavor = dynListenerFlavor(L, args[1]!);
      if (dynFlavor !== null) {
        return lowerDynListenerCall(
          L, member, name, [DYN], receiver, args[1]!, dynFlavor, registering, once, prepend, loc, true,
        );
      }
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func") {
        L.noLowering(`'${member}' with a non-function listener`, args[1]!);
      }
      const cbT = cb.type as IrType & { kind: "func" };
      if (cbT.params.length > 1) {
        L.noLowering(
          `a 'data' listener declaring ${cbT.params.length} parameters where the event carries one chunk`,
          args[1]!,
        );
      }
      const p = cbT.params[0];
      if (p !== undefined && !(p.kind === "bytes" && p.elem === "u8") && p.kind !== "string") {
        L.noLowering(
          `a 'data' listener whose chunk parameter is '${L.fmt(p)}'`,
          args[1]!,
          "chunks are Buffers — or strings once setEncoding/the encoding option applies",
        );
      }
      if (!registering) {
        return {
          kind: "libCall",
          fn: "emitter.off",
          args: [receiver, strLit(name, loc), cb],
          type: receiver.type,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "emitter.onData",
        args: [receiver, strLit(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)],
        type: receiver.type,
        loc,
      };
    }
    // Stream-rooted receivers consult the per-base FORCED tuples first
    // (runtime-emitted 'end'/'pipe'/... payloads); the dyn-listener check
    // below then sees the forced tuple exactly like a table one.
    const tuple = streamForcedTuple(L, info, name) ?? tupleOf(L, table, name, call);
    const dynFlavor = dynListenerFlavor(L, args[1]!);
    if (dynFlavor !== null) {
      return lowerDynListenerCall(
        L, member, name, tuple, receiver, args[1]!, dynFlavor, registering, once, prepend, loc, false,
      );
    }
    const cb = lowerListenerArg(L, member, name, args[1]!, tuple);
    return {
      kind: "libCall",
      fn: registering ? "emitter.on" : "emitter.off",
      args: registering
        ? [receiver, strLit(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)]
        : [receiver, strLit(name, loc), cb],
      type: receiver.type,
      loc,
    };
  }

  if (member === "emit") {
    if (args.length === 0) {
      L.noLowering("emit without an event name", call);
    }
    const name = eventNameOf(L, member, args[0]!);
    const receiver = L.lowerExpr(access.expression);
    if (name === "error") {
      // The special event: exactly one %Error-rooted payload; no listener
      // means the runtime THROWS it (emitter.emitError, may-throw).
      if (args.length !== 2) {
        L.noLowering(
          `emit('error') with ${args.length - 1} payload arguments`,
          call,
          "the supported form is emit('error', err) with an Error-hierarchy payload (non-Error payloads would need Node's ERR_UNHANDLED_ERROR wrapping — no lowering yet)",
        );
      }
      const err = L.lowerExpr(args[1]!);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = L.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        L.noLowering(
          `emit('error') with a '${L.fmt(err.type)}' payload`,
          args[1]!,
          "the supported payload is an Error-hierarchy instance",
        );
      }
      return {
        kind: "libCall",
        fn: "emitter.emitError",
        args: [receiver, strLit(name, loc), L.upcastTo(err, "%Error")],
        type: BOOL,
        loc,
      };
    }
    // Stream 'data' rides the two-slot payload ABI: a user emit fills
    // the chunk's slot (bytes or string), NULLs the other.
    const emitSides = streamSidesOf(L, info);
    if (name === "data" && (emitSides === "r" || emitSides === "rw")) {
      if (args.length !== 2) {
        L.noLowering(`emit('data') with ${args.length - 1} payload arguments`, call, "the event carries one chunk (a Buffer or string)");
      }
      const chunk = L.lowerExpr(args[1]!);
      if (!(chunk.type.kind === "bytes" && chunk.type.elem === "u8") && chunk.type.kind !== "string") {
        L.noLowering(`emit('data') with a '${L.fmt(chunk.type)}' chunk`, args[1]!, "chunks are Buffers or strings");
      }
      return {
        kind: "libCall",
        fn: "emitter.emitData",
        args: [receiver, strLit(name, loc), chunk],
        type: BOOL,
        loc,
      };
    }
    const tuple = streamForcedTuple(L, info, name) ?? tupleOf(L, table, name, call);
    if (args.length - 1 !== tuple.length) {
      L.noLowering(
        `emit('${name}') with ${args.length - 1} arguments where the event's tuple has ${tuple.length}`,
        call,
        "every emit site of one event name must supply the same argument tuple (listeners may declare a prefix)",
      );
    }
    const payload = args.slice(1).map((a, i) => L.lowerExprExpecting(a, tuple[i]));
    return {
      kind: "libCall",
      fn: "emitter.emit",
      args: [receiver, strLit(name, loc), ...payload],
      type: BOOL,
      loc,
    };
  }

  // The pure-introspection members take ANY string-typed name — no tuple
  // is involved, so the literal rule has nothing to protect (a meta
  // listener naturally passes its name parameter along).
  if (member === "removeAllListeners") {
    if (args.length > 1) {
      L.noLowering(`removeAllListeners with ${args.length} arguments`, call);
    }
    const all = args.length === 0;
    const receiver = L.lowerExpr(access.expression);
    const name = all ? strLit("", loc) : L.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      L.noLowering(`removeAllListeners with a '${L.fmt(name.type)}' event name`, args[0] ?? call);
    }
    return {
      kind: "libCall",
      fn: "emitter.removeAll",
      args: [receiver, name, boolLit(all, loc)],
      type: receiver.type,
      loc,
    };
  }

  if (member === "listenerCount") {
    if (args.length !== 1 && args.length !== 2) {
      L.noLowering(`listenerCount with ${args.length} arguments`, call);
    }
    const receiver = L.lowerExpr(access.expression);
    const name = L.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      L.noLowering(`listenerCount with a '${L.fmt(name.type)}' event name`, args[0]!);
    }
    if (args.length === 2) {
      // The fn filter matches by identity — the listener's own type is
      // its word; no tuple check is needed to count.
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func") {
        L.noLowering(`listenerCount with a non-function filter`, args[1]!);
      }
      return { kind: "libCall", fn: "emitter.countFn", args: [receiver, name, cb], type: F64, loc };
    }
    return { kind: "libCall", fn: "emitter.count", args: [receiver, name], type: F64, loc };
  }

  if (member === "listeners" || member === "rawListeners") {
    // A fresh +1 closure array of the event's listeners in list order,
    // element-typed by the event's unified tuple: every registered
    // listener declared a typeEquals PREFIX of it, and calling one through
    // the full-tuple signature delivers exactly what emit would (extra
    // trailing arguments are ignored — JS's semantics, and the C calling
    // convention's). The event NAME must be a compile-time literal — the
    // element type depends on it. Both members answer the ORIGINALS: the
    // once wrapper is runtime-internal, so rawListeners' wrapper identity
    // is a documented divergence (SEMANTICS.md).
    if (args.length !== 1) {
      L.noLowering(`${member} with ${args.length} arguments`, call, "the supported form is (eventName)");
    }
    const name = eventNameOf(L, member, args[0]!);
    const sig = table.get(name);
    if (sig?.dynListener) {
      // A dyn-adapted registration means the runtime bucket can hold
      // originals of MIXED signatures — no one honest element type.
      L.noLowering(
        `${member} of the event '${name}'`,
        call,
        "a listener of this event is checked-dynamic (unannotated parameters), so the listener array has no one static element type — listenerCount(name) counts",
      );
    }
    const tuple = tupleOf(L, table, name, call);
    const receiver = L.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: "emitter.listeners",
      args: [receiver, strLit(name, loc)],
      type: arrayOf({ kind: "func", params: tuple, ret: { kind: "void" } }),
      loc,
    };
  }

  if (member === "eventNames") {
    if (args.length !== 0) L.noLowering(`eventNames with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "emitter.names", args: [receiver], type: arrayOf(STRING), loc };
  }

  if (member === "setMaxListeners") {
    if (args.length !== 1) L.noLowering(`setMaxListeners with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    if (L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "f64") {
      // The invalid-input probes (string n, dyn helpers): Node's ladder
      // runs at runtime — ERR_INVALID_ARG_TYPE for non-numbers,
      // ERR_OUT_OF_RANGE below zero, and a well-typed dyn still applies.
      const raw = L.lowerExpr(args[0]!);
      if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
        const n: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
        return { kind: "libCall", fn: "emitter.setMaxChk", args: [receiver, n], type: receiver.type, loc };
      }
    }
    const n = L.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: "emitter.setMax", args: [receiver, n], type: receiver.type, loc };
  }

  if (member === "getMaxListeners") {
    if (args.length !== 0) L.noLowering(`getMaxListeners with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "emitter.getMax", args: [receiver], type: F64, loc };
  }

  return null;
}
