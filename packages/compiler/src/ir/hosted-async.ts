/* Backend-neutral facts for a host-scheduled async runtime personality.
 *
 * Native executables implement `await` by parking the active ScriptC fiber.
 * A renderer cannot do that: Chromium owns the event loop, and a suspended
 * native stack is neither an Oilpan root nor an acceptable per-operation
 * allocation.  The renderer path therefore needs an explicit continuation
 * plan shared by the C and LLVM backends.
 *
 * This module is deliberately IR-only.  It identifies every operation that
 * suspends the current async activation in deterministic evaluation order and
 * publishes the conservative frame slots needed by the first stackless
 * lowering.  Backends may optimize the slots later, but they may not discover
 * a different set of suspension points independently. */

import {
  VOID,
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrParam,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "./nodes.js";

export type HostedSuspensionKind = "promise" | "promise-or-unit" | "hop" | "dynamic";

export interface HostedSuspensionSite {
  /** Dense, source/evaluation-order state id. State zero is the eager prefix;
   * the continuation after this suspension is `id + 1`. */
  id: number;
  kind: HostedSuspensionKind;
  loc: SrcLoc;
  /** Fulfillment type written into the continuation frame. */
  resultType: IrType;
  /** Present only for Promise<T> | unit awaits. */
  promiseTag?: number;
  /** Stable structural route used in diagnostics and deterministic tests. */
  path: string;
}

export interface HostedAsyncFrameSlot {
  localId: string;
  name: string;
  type: IrType;
  boxed: boolean;
  nativeFrame: boolean;
}

export interface HostedAsyncPlan {
  functionName: string;
  sites: HostedSuspensionSite[];
  /** The first lowering deliberately frames every lexical local.  That is
   * conservative but correct across loops, catches, and re-entrant callbacks;
   * a later liveness pass may remove slots only after proving C/LLVM parity. */
  frameSlots: HostedAsyncFrameSlot[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

/** True when `value` is an IR expression node rather than a type or metadata
 * object. Every expression has both a source location and a computed type. */
function isExpr(value: unknown): value is IrExpr {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  const loc = value.loc;
  return isObject(loc) && typeof loc.file === "string" && isObject(value.type);
}

/** Walk plain JSON-safe IR in its declared field order. IR constructors spell
 * operand fields in JavaScript evaluation order; arrays retain source order.
 * Conditional nodes do not cause a problem here because this is an inventory,
 * not the eventual control-flow transform: both possible suspension sites need
 * distinct state ids even though one branch executes at runtime. */
function walkValue(
  value: unknown,
  path: string,
  visitExpr: (expr: IrExpr, path: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValue(item, `${path}[${index}]`, visitExpr));
    return;
  }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (key === "type" || key === "loc") continue;
    walkValue(value[key], path.length === 0 ? key : `${path}.${key}`, visitExpr);
  }
  // Post-order is evaluation order for a suspending expression: its operand
  // (which may itself suspend) completes before this await creates its own
  // continuation state.
  if (isExpr(value)) visitExpr(value, path);
}

function suspensionOf(expr: IrExpr): Omit<HostedSuspensionSite, "id" | "path"> | null {
  switch (expr.kind) {
    case "awaitExpr":
      return { kind: "promise", loc: expr.loc, resultType: expr.type };
    case "awaitUnionExpr":
      return {
        kind: "promise-or-unit",
        loc: expr.loc,
        resultType: expr.type,
        promiseTag: expr.promiseTag,
      };
    case "libCall":
      if (expr.fn === "async.hop") {
        return { kind: "hop", loc: expr.loc, resultType: expr.type };
      }
      if (expr.fn === "async.awaitDyn") {
        return { kind: "dynamic", loc: expr.loc, resultType: expr.type };
      }
      return null;
    default:
      return null;
  }
}

/** Build the one authoritative hosted-async inventory for a function. */
export function planHostedAsyncFunction(fn: IrFunction): HostedAsyncPlan {
  const sites: HostedSuspensionSite[] = [];
  walkValue(fn.body satisfies IrStmt[], "body", (expr, path) => {
    const site = suspensionOf(expr);
    if (site === null) return;
    sites.push({ id: sites.length, path, ...site });
  });
  return {
    functionName: fn.name,
    sites,
    frameSlots: fn.locals.map((local: IrLocal) => ({
      localId: local.id,
      name: local.name,
      type: local.type,
      boxed: local.boxed === true,
      nativeFrame: local.nativeFrame !== undefined,
    })),
  };
}

export function functionHasHostedSuspension(fn: IrFunction): boolean {
  return planHostedAsyncFunction(fn).sites.length !== 0;
}

/** Raw frame-bounded foreign pointers are synchronous borrows. A conservative
 * all-local first frame must therefore reject them whenever an activation can
 * suspend; a later liveness pass may prove a particular borrow dead earlier. */
export function hostedAsyncFrameBoundedLocals(fn: IrFunction): HostedAsyncFrameSlot[] {
  const plan = planHostedAsyncFunction(fn);
  return plan.sites.length === 0 ? [] : plan.frameSlots.filter((slot) => slot.nativeFrame);
}

/* ------------------------------------------------------------------------- *
 * Hosted stackless lowering
 * ------------------------------------------------------------------------- *
 *
 * The lowering below deliberately produces ordinary, non-async IR functions.
 * A suspension site ends one such function and records the next function plus
 * its owned arguments in a synthetic record shape.  Record shapes already
 * have the exact cycle-header, tracing, retain/release, C, and LLVM machinery
 * a Promise -> continuation edge requires, so the two machine-code backends
 * share one ownership model instead of independently inventing coroutine
 * frames.
 *
 * The small amount of backend-only information (which step is an entry and
 * which terminal attaches/completes) lives in WeakMaps.  It is intentionally
 * not serialized Native IR: source IR remains a target-independent input and
 * --emit-ir does not become dependent on a library profile's host scheduler.
 */

export interface HostedAsyncCapture {
  field: string;
  /** Null names the lifted closure environment (`sc_env`), whose boxes stay
   * borrowed by every continuation function. */
  localId: string | null;
  type: IrType;
}

export interface HostedAsyncSuspendTerminal {
  kind: "suspend";
  mode: "promise" | "hop";
  /** Owned expression moved into the frame. Present only for promise mode. */
  promise: IrExpr | null;
  awaitedType: IrType;
  continuation: string;
  frameShapeId: string;
  captures: HostedAsyncCapture[];
  /** Extra frame-only root which keeps the awaited promise alive. */
  awaitedField: string | null;
  resultPromiseLocalId: string;
  loc: SrcLoc;
}

export interface HostedAsyncCompleteTerminal {
  kind: "complete";
  resultPromiseLocalId: string;
  value: IrExpr | null;
  resultType: IrType;
  loc: SrcLoc;
}

export interface HostedAsyncPropagateTerminal {
  /** The body has raised into ScriptC's pending-exception cell. */
  kind: "propagate";
  resultPromiseLocalId: string;
  loc: SrcLoc;
}

export interface HostedAsyncDirectCapture {
  localId: string;
  type: IrType;
}

export interface HostedAsyncJumpTerminal {
  kind: "jump";
  continuation: string;
  captures: HostedAsyncDirectCapture[];
  loc: SrcLoc;
}

export interface HostedAsyncBranchTerminal {
  kind: "branch";
  condition: IrExpr;
  whenTrue: string;
  whenFalse: string;
  captures: HostedAsyncDirectCapture[];
  loc: SrcLoc;
}

export type HostedAsyncTerminal =
  | HostedAsyncSuspendTerminal
  | HostedAsyncCompleteTerminal
  | HostedAsyncPropagateTerminal
  | HostedAsyncJumpTerminal
  | HostedAsyncBranchTerminal;

export interface HostedAsyncEntry {
  owner: string;
  entryStep: string;
  resultPromiseLocalId: string;
}

export interface HostedAsyncStep {
  owner: string;
  terminal: HostedAsyncTerminal;
  /** A promise continuation receives this final owned parameter. Void/hop
   * continuations have no extra parameter. */
  resumeParam: IrParam | null;
}

const hostedEntries = new WeakMap<IrFunction, HostedAsyncEntry>();
const hostedSteps = new WeakMap<IrFunction, HostedAsyncStep>();
const loweredModules = new WeakSet<IrModule>();

export function hostedAsyncEntryOf(fn: IrFunction): HostedAsyncEntry | undefined {
  return hostedEntries.get(fn);
}

export function hostedAsyncStepOf(fn: IrFunction): HostedAsyncStep | undefined {
  return hostedSteps.get(fn);
}

export class HostedAsyncLoweringError extends Error {
  constructor(
    readonly functionName: string,
    readonly surface: string,
    readonly loc: SrcLoc,
  ) {
    super(`hosted stackless async cannot lower ${surface} in '${functionName.replace(/^%/, "")}'`);
    this.name = "HostedAsyncLoweringError";
  }
}

interface LoweredValue {
  /** Null is the value of a void expression. */
  expr: IrExpr | null;
  /** Synthetic locals whose last use is the consumer of this value. */
  temporaries: string[];
}

interface StepBuilder {
  name: string;
  params: IrParam[];
  locals: Map<string, IrLocal>;
  /** Values that must be copied into a continuation if it suspends now. */
  active: Map<string, IrLocal>;
  body: IrStmt[];
  terminal: HostedAsyncTerminal | null;
  resumeParam: IrParam | null;
}

interface FunctionLowering {
  source: IrFunction;
  resultPromiseLocalId: string;
  resultPromiseType: IrType;
  records: IrRecordShape[];
  steps: StepBuilder[];
  stepCounter: number;
  tempCounter: number;
  frameCounter: number;
}

type ExprContinuation = (step: StepBuilder, value: LoweredValue) => void;
type StepContinuation = (step: StepBuilder) => void;

function cloneLoc(loc: SrcLoc): SrcLoc {
  return { file: loc.file, start: loc.start, end: loc.end };
}

function exprHasSuspension(expr: IrExpr): boolean {
  let found = false;
  walkValue(expr, "expr", (candidate) => {
    if (suspensionOf(candidate) !== null) found = true;
  });
  return found;
}

function stmtHasSuspension(stmt: IrStmt): boolean {
  let found = false;
  walkValue(stmt, "stmt", (candidate) => {
    if (suspensionOf(candidate) !== null) found = true;
  });
  return found;
}

function childBodies(stmt: IrStmt): IrStmt[][] {
  switch (stmt.kind) {
    case "if":
      return stmt.else_ === null ? [stmt.then] : [stmt.then, stmt.else_];
    case "while":
    case "doWhile":
    case "forOf":
    case "block":
      return [stmt.body];
    case "for":
      return [stmt.body];
    case "switch":
      return stmt.cases.map((candidate) => candidate.body);
    case "tryCatch":
      return [
        stmt.tryBody,
        ...(stmt.catchBody === null ? [] : [stmt.catchBody]),
        ...(stmt.finallyBody === null ? [] : [stmt.finallyBody]),
      ];
    default:
      return [];
  }
}

function stmtContainsFunctionExit(stmt: IrStmt): boolean {
  if (
    stmt.kind === "return" || stmt.kind === "throw" || stmt.kind === "rethrow" ||
    stmt.kind === "runtimeFence"
  ) return true;
  return childBodies(stmt).some((body) => body.some(stmtContainsFunctionExit));
}

function loweringError(F: FunctionLowering, surface: string, loc: SrcLoc): never {
  throw new HostedAsyncLoweringError(F.source.name, surface, loc);
}

function newStep(
  F: FunctionLowering,
  active: ReadonlyMap<string, IrLocal>,
  resumeType: IrType | null,
  loc: SrcLoc,
): StepBuilder {
  const index = F.stepCounter++;
  const name = `%hosted.async.${F.source.name}.${index}`;
  const params: IrParam[] = [...active.values()].map((local) => ({
    localId: local.id,
    name: local.name,
    type: local.type,
  }));
  const locals = new Map<string, IrLocal>([...active].map(([id, local]) => [id, { ...local }]));
  // Captured bindings are reached through the retained closure environment,
  // never duplicated as ordinary continuation parameters/frame fields.
  const nextActive = new Map<string, IrLocal>(active);
  for (const capture of F.source.captures ?? []) {
    const local = F.source.locals.find((candidate) => candidate.id === capture.localId);
    if (local === undefined) {
      loweringError(F, `an unknown capture '${capture.localId}'`, loc);
    }
    locals.set(local.id, { ...local });
  }
  let resumeParam: IrParam | null = null;
  if (resumeType !== null && resumeType.kind !== "void") {
    const id = `%hosted.await.${index}.${F.tempCounter++}`;
    const local: IrLocal = {
      id,
      name: "%awaited",
      type: resumeType,
      mutable: false,
    };
    resumeParam = { localId: id, name: local.name, type: resumeType };
    params.push(resumeParam);
    locals.set(id, local);
    nextActive.set(id, local);
  }
  const step: StepBuilder = {
    name,
    params,
    locals,
    active: nextActive,
    body: [],
    terminal: null,
    resumeParam,
  };
  F.steps.push(step);
  void loc; // retained in terminal/source nodes; step functions use source loc.
  return step;
}

function addLocal(step: StepBuilder, local: IrLocal): void {
  step.locals.set(local.id, { ...local });
  step.active.set(local.id, { ...local });
}

function consumeTemporaries(step: StepBuilder, value: LoweredValue): void {
  for (const id of value.temporaries) step.active.delete(id);
}

function bindValue(
  F: FunctionLowering,
  step: StepBuilder,
  value: LoweredValue,
  done: ExprContinuation,
): void {
  if (value.expr === null || value.expr.type.kind === "void") {
    loweringError(F, "a void value used as an eager operand", F.source.loc);
  }
  const id = `%hosted.temp.${F.tempCounter++}`;
  const local: IrLocal = {
    id,
    name: "%await-temp",
    type: value.expr.type,
    mutable: false,
  };
  step.body.push({ kind: "varDecl", localId: id, init: value.expr, loc: cloneLoc(value.expr.loc) });
  consumeTemporaries(step, value);
  addLocal(step, local);
  done(step, {
    expr: { kind: "varRef", localId: id, type: local.type, loc: cloneLoc(value.expr.loc) },
    temporaries: [id],
  });
}

function lowerArrayValue(
  F: FunctionLowering,
  step: StepBuilder,
  values: unknown[],
  index: number,
  out: unknown[],
  temporaries: string[],
  done: (step: StepBuilder, value: unknown[], temporaries: string[]) => void,
): void {
  if (index >= values.length) {
    done(step, out, temporaries);
    return;
  }
  lowerNestedValue(F, step, values[index], (next, value, temps) => {
    out.push(value);
    lowerArrayValue(F, next, values, index + 1, out, [...temporaries, ...temps], done);
  });
}

function lowerObjectValue(
  F: FunctionLowering,
  step: StepBuilder,
  value: Record<string, unknown>,
  keys: string[],
  index: number,
  out: Record<string, unknown>,
  temporaries: string[],
  done: (step: StepBuilder, value: Record<string, unknown>, temporaries: string[]) => void,
): void {
  if (index >= keys.length) {
    done(step, out, temporaries);
    return;
  }
  const key = keys[index]!;
  if (key === "type" || key === "loc") {
    out[key] = value[key];
    lowerObjectValue(F, step, value, keys, index + 1, out, temporaries, done);
    return;
  }
  lowerNestedValue(F, step, value[key], (next, child, temps) => {
    out[key] = child;
    lowerObjectValue(F, next, value, keys, index + 1, out, [...temporaries, ...temps], done);
  });
}

/** Recursively rewrites one eager operand container. Every expression child
 * is bound once before the following child starts, preserving evaluation
 * order when that following child suspends. */
function lowerNestedValue(
  F: FunctionLowering,
  step: StepBuilder,
  value: unknown,
  done: (step: StepBuilder, value: unknown, temporaries: string[]) => void,
): void {
  if (Array.isArray(value)) {
    lowerArrayValue(F, step, value, 0, [], [], done);
    return;
  }
  if (isExpr(value)) {
    lowerExpr(F, step, value, (next, lowered) => {
      if (lowered.expr === null) {
        done(next, null, lowered.temporaries);
        return;
      }
      bindValue(F, next, lowered, (boundStep, bound) => {
        done(boundStep, bound.expr, bound.temporaries);
      });
    });
    return;
  }
  if (isObject(value)) {
    lowerObjectValue(F, step, value, Object.keys(value), 0, {}, [], done);
    return;
  }
  done(step, value, []);
}

function lazySuspensionSurface(expr: IrExpr): string | null {
  switch (expr.kind) {
    case "logical":
      return `an await inside '${expr.op}' short-circuit evaluation`;
    case "ternary":
      return "an await inside a conditional expression";
    case "nullish":
      return "an await inside nullish coalescing";
    case "orDefault":
      return "an await inside a narrowed default expression";
    case "optChain":
      return "an await inside optional chaining";
    default:
      return null;
  }
}

function makeFrameShape(
  F: FunctionLowering,
  captures: IrLocal[],
  awaitedPromise: IrType | null,
): { shape: IrRecordShape; captureMeta: HostedAsyncCapture[]; awaitedField: string | null } {
  const id = `%hosted.frame.${F.source.name}.${F.frameCounter++}`;
  const environmentType: IrType | null = F.source.captures === undefined
    ? null
    : {
        kind: "func",
        params: F.source.params.map((param) => param.type),
        ret: { kind: "promise", inner: F.source.returnType },
      };
  const captureMeta: HostedAsyncCapture[] = [
    ...(environmentType === null
      ? []
      : [{ field: "a0000", localId: null, type: environmentType }]),
    ...captures.map((local, index) => ({
      field: `a${(index + (environmentType === null ? 0 : 1)).toString().padStart(4, "0")}`,
      localId: local.id,
      type: local.type,
    })),
  ];
  const awaitedField = awaitedPromise === null ? null : "zawaited";
  const fields = [
    ...captureMeta.map((capture) => ({ name: capture.field, type: capture.type })),
    ...(awaitedPromise === null ? [] : [{ name: awaitedField!, type: awaitedPromise }]),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const shape: IrRecordShape = { id, fields };
  F.records.push(shape);
  return { shape, captureMeta, awaitedField };
}

function lowerAwait(
  F: FunctionLowering,
  step: StepBuilder,
  expr: Extract<IrExpr, { kind: "awaitExpr" }>,
  done: ExprContinuation,
): void {
  lowerExpr(F, step, expr.value, (current, promise) => {
    if (promise.expr === null || promise.expr.type.kind !== "promise") {
      loweringError(F, "an await whose operand is not a typed Promise", expr.loc);
    }
    const ephemeral = new Set(promise.temporaries);
    const captures = [...current.active.values()].filter((local) => !ephemeral.has(local.id));
    for (const id of ephemeral) current.active.delete(id);
    const continuation = newStep(
      F,
      new Map(captures.map((local) => [local.id, local])),
      expr.type,
      expr.loc,
    );
    const frame = makeFrameShape(F, captures, promise.expr.type);
    current.terminal = {
      kind: "suspend",
      mode: "promise",
      promise: promise.expr,
      awaitedType: expr.type,
      continuation: continuation.name,
      frameShapeId: frame.shape.id,
      captures: frame.captureMeta,
      awaitedField: frame.awaitedField,
      resultPromiseLocalId: F.resultPromiseLocalId,
      loc: cloneLoc(expr.loc),
    };
    if (expr.type.kind === "void") {
      done(continuation, { expr: null, temporaries: [] });
      return;
    }
    const resume = continuation.resumeParam!;
    done(continuation, {
      expr: {
        kind: "varRef",
        localId: resume.localId,
        type: resume.type,
        loc: cloneLoc(expr.loc),
      },
      temporaries: [resume.localId],
    });
  });
}

function lowerHop(
  F: FunctionLowering,
  step: StepBuilder,
  expr: Extract<IrExpr, { kind: "libCall" }>,
  done: ExprContinuation,
): void {
  const captures = [...step.active.values()];
  const continuation = newStep(
    F,
    new Map(captures.map((local) => [local.id, local])),
    null,
    expr.loc,
  );
  const frame = makeFrameShape(F, captures, null);
  step.terminal = {
    kind: "suspend",
    mode: "hop",
    promise: null,
    awaitedType: VOID,
    continuation: continuation.name,
    frameShapeId: frame.shape.id,
    captures: frame.captureMeta,
    awaitedField: null,
    resultPromiseLocalId: F.resultPromiseLocalId,
    loc: cloneLoc(expr.loc),
  };
  done(continuation, { expr: null, temporaries: [] });
}

function lowerInlineStatements(
  F: FunctionLowering,
  step: StepBuilder,
  stmts: IrStmt[],
  index: number,
  done: StepContinuation,
): void {
  if (index >= stmts.length) {
    done(step);
    return;
  }
  const stmt = stmts[index]!;
  switch (stmt.kind) {
    case "varDecl": {
      const local = F.source.locals.find((candidate) => candidate.id === stmt.localId);
      if (local === undefined) loweringError(F, `an unknown sequence local '${stmt.localId}'`, stmt.loc);
      if (stmt.init === null) {
        step.body.push(stmt);
        addLocal(step, local);
        lowerInlineStatements(F, step, stmts, index + 1, done);
        return;
      }
      lowerExpr(F, step, stmt.init, (next, value) => {
        if (value.expr === null) loweringError(F, "a void sequence initializer", stmt.loc);
        next.body.push({ ...stmt, init: value.expr });
        consumeTemporaries(next, value);
        addLocal(next, local);
        lowerInlineStatements(F, next, stmts, index + 1, done);
      });
      return;
    }
    case "assign":
      lowerExpr(F, step, stmt.value, (next, value) => {
        if (value.expr === null) loweringError(F, "a void sequence assignment", stmt.loc);
        next.body.push({ ...stmt, value: value.expr });
        consumeTemporaries(next, value);
        lowerInlineStatements(F, next, stmts, index + 1, done);
      });
      return;
    case "exprStmt":
      lowerExpr(F, step, stmt.expr, (next, value) => {
        if (value.expr !== null) next.body.push({ ...stmt, expr: value.expr });
        consumeTemporaries(next, value);
        lowerInlineStatements(F, next, stmts, index + 1, done);
      });
      return;
    default:
      loweringError(F, `a '${stmt.kind}' statement inside a suspending sequence expression`, stmt.loc);
  }
}

function lowerSeqExpr(
  F: FunctionLowering,
  step: StepBuilder,
  expr: Extract<IrExpr, { kind: "seqExpr" }>,
  done: ExprContinuation,
): void {
  const before = new Set(step.active.keys());
  lowerInlineStatements(F, step, expr.stmts, 0, (next) => {
    lowerExpr(F, next, expr.result, (last, result) => {
      const sequenceLocals = [...last.active.keys()].filter((id) => !before.has(id));
      done(last, {
        expr: result.expr,
        temporaries: [...new Set([...result.temporaries, ...sequenceLocals])],
      });
    });
  });
}

function lowerExpr(
  F: FunctionLowering,
  step: StepBuilder,
  expr: IrExpr,
  done: ExprContinuation,
): void {
  if (!exprHasSuspension(expr)) {
    done(step, { expr, temporaries: [] });
    return;
  }
  if (expr.kind === "awaitExpr") {
    lowerAwait(F, step, expr, done);
    return;
  }
  if (expr.kind === "awaitUnionExpr") {
    loweringError(F, "Promise-or-unit await (its branch must become two hosted states)", expr.loc);
  }
  if (expr.kind === "libCall" && expr.fn === "async.hop") {
    lowerHop(F, step, expr, done);
    return;
  }
  if (expr.kind === "libCall" && expr.fn === "async.awaitDyn") {
    loweringError(F, "checked-dynamic await (adoption must select promise versus hop)", expr.loc);
  }
  if (expr.kind === "seqExpr") {
    lowerSeqExpr(F, step, expr, done);
    return;
  }
  const lazy = lazySuspensionSurface(expr);
  if (lazy !== null) loweringError(F, lazy, expr.loc);
  if (expr.kind === "nativeCall" && expr.resultMode === "frameBounded") {
    loweringError(F, "a frame-bounded native result crossing await", expr.loc);
  }
  lowerObjectValue(
    F,
    step,
    expr as unknown as Record<string, unknown>,
    Object.keys(expr),
    0,
    {},
    [],
    (next, rebuilt, temporaries) => {
      done(next, { expr: rebuilt as unknown as IrExpr, temporaries });
    },
  );
}

function resultRef(step: StepBuilder, F: FunctionLowering, loc: SrcLoc): IrExpr {
  const local = step.locals.get(F.resultPromiseLocalId);
  if (local === undefined) loweringError(F, "a continuation without its result promise", loc);
  return {
    kind: "varRef",
    localId: local.id,
    type: local.type,
    loc: cloneLoc(loc),
  };
}

function lowerStatements(
  F: FunctionLowering,
  step: StepBuilder,
  stmts: IrStmt[],
  index: number,
  done: StepContinuation,
): void {
  if (index >= stmts.length) {
    done(step);
    return;
  }
  const stmt = stmts[index]!;
  switch (stmt.kind) {
    case "varDecl": {
      const local = F.source.locals.find((candidate) => candidate.id === stmt.localId);
      if (local === undefined) loweringError(F, `an unknown local '${stmt.localId}'`, stmt.loc);
      if (stmt.init === null) {
        step.body.push(stmt);
        addLocal(step, local);
        lowerStatements(F, step, stmts, index + 1, done);
        return;
      }
      lowerExpr(F, step, stmt.init, (next, value) => {
        if (value.expr === null) loweringError(F, "a void variable initializer", stmt.loc);
        next.body.push({ ...stmt, init: value.expr });
        consumeTemporaries(next, value);
        addLocal(next, local);
        lowerStatements(F, next, stmts, index + 1, done);
      });
      return;
    }
    case "assign":
      lowerExpr(F, step, stmt.value, (next, value) => {
        if (value.expr === null) loweringError(F, "a void assignment", stmt.loc);
        next.body.push({ ...stmt, value: value.expr });
        consumeTemporaries(next, value);
        lowerStatements(F, next, stmts, index + 1, done);
      });
      return;
    case "exprStmt":
      lowerExpr(F, step, stmt.expr, (next, value) => {
        if (value.expr !== null) next.body.push({ ...stmt, expr: value.expr });
        consumeTemporaries(next, value);
        lowerStatements(F, next, stmts, index + 1, done);
      });
      return;
    case "if":
      lowerExpr(F, step, stmt.cond, (current, condition) => {
        if (condition.expr === null || condition.expr.type.kind !== "bool") {
          loweringError(F, "a void or non-boolean if condition", stmt.loc);
        }
        consumeTemporaries(current, condition);
        const active = new Map(current.active);
        const thenStep = newStep(F, active, null, stmt.loc);
        const elseStep = newStep(F, active, null, stmt.loc);
        const joinStep = newStep(F, active, null, stmt.loc);
        const captures = [...active.values()].map((local) => ({
          localId: local.id,
          type: local.type,
        }));
        current.terminal = {
          kind: "branch",
          condition: condition.expr,
          whenTrue: thenStep.name,
          whenFalse: elseStep.name,
          captures,
          loc: cloneLoc(stmt.loc),
        };
        const jumpToJoin = (last: StepBuilder): void => {
          last.terminal = {
            kind: "jump",
            continuation: joinStep.name,
            captures,
            loc: cloneLoc(stmt.loc),
          };
        };
        lowerStatements(F, thenStep, stmt.then, 0, jumpToJoin);
        lowerStatements(F, elseStep, stmt.else_ ?? [], 0, jumpToJoin);
        lowerStatements(F, joinStep, stmts, index + 1, done);
      });
      return;
    case "return":
      if (stmt.value === null) {
        step.terminal = {
          kind: "complete",
          resultPromiseLocalId: F.resultPromiseLocalId,
          value: null,
          resultType: F.source.returnType,
          loc: cloneLoc(stmt.loc),
        };
        return;
      }
      lowerExpr(F, step, stmt.value, (next, value) => {
        if (value.expr === null) loweringError(F, "a void return value", stmt.loc);
        consumeTemporaries(next, value);
        // resultRef is intentionally evaluated by the terminal emitter; it
        // is kept here as an invariant check that every continuation owns it.
        void resultRef(next, F, stmt.loc);
        next.terminal = {
          kind: "complete",
          resultPromiseLocalId: F.resultPromiseLocalId,
          value: value.expr,
          resultType: F.source.returnType,
          loc: cloneLoc(stmt.loc),
        };
      });
      return;
    case "throw":
      lowerExpr(F, step, stmt.value, (next, value) => {
        if (value.expr === null) loweringError(F, "a void thrown value", stmt.loc);
        next.body.push({ ...stmt, value: value.expr });
        consumeTemporaries(next, value);
        next.terminal = {
          kind: "propagate",
          resultPromiseLocalId: F.resultPromiseLocalId,
          loc: cloneLoc(stmt.loc),
        };
      });
      return;
    case "rethrow":
    case "runtimeFence":
      step.body.push(stmt);
      step.terminal = {
        kind: "propagate",
        resultPromiseLocalId: F.resultPromiseLocalId,
        loc: cloneLoc(stmt.loc),
      };
      return;
    default:
      if (stmtHasSuspension(stmt)) {
        loweringError(F, `a suspending '${stmt.kind}' control-flow statement`, stmt.loc);
      }
      if (stmtContainsFunctionExit(stmt)) {
        loweringError(F, `a '${stmt.kind}' statement containing return/throw`, stmt.loc);
      }
      step.body.push(stmt);
      lowerStatements(F, step, stmts, index + 1, done);
  }
}

function transformFunction(fn: IrFunction): {
  entry: IrFunction;
  steps: IrFunction[];
  records: IrRecordShape[];
} {
  const bounded = hostedAsyncFrameBoundedLocals(fn);
  if (bounded.length > 0) {
    throw new HostedAsyncLoweringError(
      fn.name,
      `frame-bounded native local '${bounded[0]!.name}' crossing await`,
      fn.loc,
    );
  }
  const captureIds = new Set((fn.captures ?? []).map((capture) => capture.localId));
  const boxed = fn.locals.find(
    (local) => local.boxed === true && !captureIds.has(local.id),
  );
  if (boxed !== undefined) {
    throw new HostedAsyncLoweringError(
      fn.name,
      `boxed local '${boxed.name}' crossing await`,
      fn.loc,
    );
  }

  const resultPromiseLocalId = `%hosted.result.${fn.name}`;
  const resultPromiseType: IrType = { kind: "promise", inner: fn.returnType };
  const resultLocal: IrLocal = {
    id: resultPromiseLocalId,
    name: "%result-promise",
    type: resultPromiseType,
    mutable: false,
  };
  const paramLocals = fn.params.map((param) => {
    const local = fn.locals.find((candidate) => candidate.id === param.localId);
    if (local === undefined) {
      throw new HostedAsyncLoweringError(fn.name, `unknown parameter '${param.localId}'`, fn.loc);
    }
    return local;
  });
  const initialActive = new Map<string, IrLocal>([
    ...paramLocals.map((local) => [local.id, { ...local }] as const),
    [resultLocal.id, resultLocal],
  ]);
  const F: FunctionLowering = {
    source: fn,
    resultPromiseLocalId,
    resultPromiseType,
    records: [],
    steps: [],
    stepCounter: 0,
    tempCounter: 0,
    frameCounter: 0,
  };
  const first = newStep(F, initialActive, null, fn.loc);
  lowerStatements(F, first, fn.body, 0, (last) => {
    if (F.source.returnType.kind !== "void") {
      loweringError(F, "fallthrough from a non-void async function", F.source.loc);
    }
    last.terminal = {
      kind: "complete",
      resultPromiseLocalId: F.resultPromiseLocalId,
      value: null,
      resultType: F.source.returnType,
      loc: cloneLoc(F.source.loc),
    };
  });

  const functions: IrFunction[] = F.steps.map((builder) => {
    if (builder.terminal === null) {
      throw new Error(`hosted async lowering bug: step '${builder.name}' has no terminal`);
    }
    const lowered: IrFunction = {
      name: builder.name,
      params: builder.params,
      returnType: VOID,
      locals: [...builder.locals.values()],
      ...(fn.captures === undefined ? {} : { captures: fn.captures }),
      body: builder.body,
      loc: cloneLoc(fn.loc),
    };
    hostedSteps.set(lowered, {
      owner: fn.name,
      terminal: builder.terminal,
      resumeParam: builder.resumeParam,
    });
    return lowered;
  });

  const entry: IrFunction = { ...fn, body: [] };
  hostedEntries.set(entry, {
    owner: fn.name,
    entryStep: first.name,
    resultPromiseLocalId,
  });
  return { entry, steps: functions, records: F.records };
}

/** Return an emission-only module whose suspending async functions are
 * stackless ordinary steps. Non-hosted modules and hosted modules without a
 * suspension preserve object identity and byte-for-byte behavior. */
export function lowerHostedAsyncModule(mod: IrModule): IrModule {
  if (
    mod.lib?.hostedSchedulerConfigureSymbol === undefined ||
    loweredModules.has(mod) ||
    !mod.functions.some((fn) => fn.async === true && functionHasHostedSuspension(fn))
  ) return mod;

  const functions: IrFunction[] = [];
  const records: IrRecordShape[] = [...(mod.records ?? [])];
  for (const fn of mod.functions) {
    if (fn.async !== true || !functionHasHostedSuspension(fn)) {
      functions.push(fn);
      continue;
    }
    const transformed = transformFunction(fn);
    functions.push(transformed.entry, ...transformed.steps);
    records.push(...transformed.records);
  }
  const lowered: IrModule = {
    ...mod,
    functions,
    ...(records.length === 0 ? {} : { records }),
  };
  loweredModules.add(lowered);
  return lowered;
}

/** Capability check used by the library diagnostic gate. It runs the same
 * lowering the emitters use, so admission cannot drift from codegen. */
export function checkHostedAsyncLowering(mod: IrModule): HostedAsyncLoweringError | null {
  try {
    void lowerHostedAsyncModule(mod);
    return null;
  } catch (error) {
    if (error instanceof HostedAsyncLoweringError) return error;
    throw error;
  }
}

/** The emitter can move a field out of a continuation record only for values
 * whose representation owns a reference. Scalars are copied. */
export function hostedCaptureOwnsReference(capture: HostedAsyncCapture): boolean {
  return isRefCounted(capture.type);
}
