import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { emitModule } from "../backend/emission/emitter.js";
import { emitLlvmModule } from "../backend/llvm/emitter.js";
import { IR_VERSION, type IrExpr, type IrFunction, type IrLibSection, type IrModule } from "./nodes.js";
import {
  functionHasHostedSuspension,
  hostedAsyncEntryOf,
  hostedAsyncStepOf,
  lowerHostedAsyncModule,
  planHostedAsyncFunction,
} from "./hosted-async.js";

const loc = { file: "hosted.ts", start: 0, end: 0 };
const F64 = { kind: "f64" } as const;
const VOID = { kind: "void" } as const;
const promise = (inner = F64) => ({ kind: "promise", inner } as const);
const ref = (localId: string, type: IrExpr["type"]): IrExpr => ({ kind: "varRef", localId, type, loc });

const hostedLib: IrLibSection = {
  profileName: "hosted-test",
  prefix: "ht_",
  initSymbol: "ht_init",
  sinkRegisterSymbol: "ht_sink",
  collectSymbol: null,
  resultResetSymbol: null,
  threadInstances: false,
  hostedSchedulerConfigureSymbol: "ht_hosted_configure",
  hostedSchedulerStopSymbol: "ht_hosted_stop",
  exports: [],
  nativeExports: [],
  trapOverlays: [],
};

function moduleOf(fn: IrFunction): IrModule {
  const entry: IrFunction = {
    name: "%entry",
    params: [],
    returnType: VOID,
    locals: [],
    body: [{ kind: "return", value: null, loc }],
    loc,
  };
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    functions: [fn, entry],
    entry: entry.name,
    lib: hostedLib,
  };
}

describe("hosted async planning", () => {
  test("numbers nested suspension sites in operand evaluation order", () => {
    const p = promise();
    const fn: IrFunction = {
      name: "nested",
      params: [],
      returnType: F64,
      async: true,
      locals: [
        { id: "a.0", name: "a", type: p, mutable: false },
        { id: "b.0", name: "b", type: p, mutable: false },
      ],
      body: [{
        kind: "return",
        value: {
          kind: "bin",
          op: "+",
          left: { kind: "awaitExpr", value: ref("a.0", p), type: F64, loc },
          right: {
            kind: "awaitExpr",
            value: ref("b.0", p),
            type: F64,
            loc: { ...loc, start: 10, end: 20 },
          },
          type: F64,
          loc,
        },
        loc,
      }],
      loc,
    };
    const plan = planHostedAsyncFunction(fn);
    expect(plan.sites.map(({ id, kind, loc: siteLoc }) => [id, kind, siteLoc.start])).toEqual([
      [0, "promise", 0],
      [1, "promise", 10],
    ]);
    expect(plan.sites.map((site) => site.path)).toEqual([
      "body[0].value.left",
      "body[0].value.right",
    ]);
    expect(plan.frameSlots.map((slot) => slot.localId)).toEqual(["a.0", "b.0"]);
    expect(functionHasHostedSuspension(fn)).toBe(true);
  });

  test("classifies union awaits, host hops, and dynamic awaits once", () => {
    const union = { kind: "union", unionId: "maybe" } as const;
    const fn: IrFunction = {
      name: "kinds",
      params: [],
      returnType: VOID,
      async: true,
      locals: [{ id: "u.0", name: "u", type: union, mutable: false }],
      body: [
        { kind: "exprStmt", expr: { kind: "awaitUnionExpr", value: ref("u.0", union), promiseTag: 1, type: F64, loc }, loc },
        { kind: "exprStmt", expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc }, loc },
        { kind: "exprStmt", expr: { kind: "libCall", fn: "async.awaitDyn", args: [], type: { kind: "dyn" }, loc }, loc },
      ],
      loc,
    };
    expect(planHostedAsyncFunction(fn).sites.map((site) => site.kind)).toEqual([
      "promise-or-unit",
      "hop",
      "dynamic",
    ]);
  });
});

describe("hosted eager async emission", () => {
  const eager: IrFunction = {
    name: "eager",
    params: [{ localId: "x.0", name: "x", type: F64 }],
    returnType: F64,
    async: true,
    locals: [{ id: "x.0", name: "x", type: F64, mutable: false }],
    body: [{
      kind: "return",
      value: {
        kind: "bin",
        op: "+",
        left: ref("x.0", F64),
        right: { kind: "numLit", value: 1, type: F64, loc },
        type: F64,
        loc,
      },
      loc,
    }],
    loc,
  };

  test("C settles PromiseCore inline and emits no fiber spawn", () => {
    const source = emitModule(moduleOf(eager));
    expect(source).toContain("ScrPromise *sc_as_eager");
    expect(source).toContain("ScrPromise *sc_p = scr_promise_new();");
    expect(source).toContain("scr_promise_fulfill_f64(sc_p, sc_r);");
    expect(source).toContain("scr_promise_reject_pending(sc_p);");
    expect(source).not.toContain("scr_async_spawn(");
  });

  test("LLVM settles PromiseCore inline and emits no fiber spawn", () => {
    const source = emitLlvmModule(moduleOf(eager));
    expect(source).toContain("; hosted eager async eager");
    expect(source).toContain("%p = call ptr @scr_promise_new()");
    expect(source).toContain("call void @scr_promise_fulfill_f64(ptr %p, double %r)");
    expect(source).toContain("call void @scr_promise_reject_pending(ptr %p)");
    expect(source).not.toContain("call ptr @scr_async_spawn");
  });
});

describe("hosted stackless async lowering", () => {
  const p = promise();
  const suspended: IrFunction = {
    name: "suspended",
    params: [
      { localId: "p.0", name: "p", type: p },
      { localId: "x.0", name: "x", type: F64 },
    ],
    returnType: F64,
    async: true,
    locals: [
      { id: "p.0", name: "p", type: p, mutable: false },
      { id: "x.0", name: "x", type: F64, mutable: false },
      { id: "y.0", name: "y", type: F64, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "y.0",
        init: { kind: "awaitExpr", value: ref("p.0", p), type: F64, loc },
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "bin",
          op: "+",
          left: ref("x.0", F64),
          right: ref("y.0", F64),
          type: F64,
          loc,
        },
        loc,
      },
    ],
    loc,
  };

  test("splits a typed await into ordinary IR steps and a traced frame shape", () => {
    const lowered = lowerHostedAsyncModule(moduleOf(suspended));
    const entry = lowered.functions.find((fn) => fn.name === suspended.name)!;
    const steps = lowered.functions.filter((fn) => hostedAsyncStepOf(fn) !== undefined);
    expect(hostedAsyncEntryOf(entry)?.entryStep).toBe(steps[0]!.name);
    expect(steps).toHaveLength(2);
    expect(steps.every((fn) => fn.async !== true && fn.returnType.kind === "void")).toBe(true);
    expect(hostedAsyncStepOf(steps[0]!)?.terminal.kind).toBe("suspend");
    expect(hostedAsyncStepOf(steps[1]!)?.terminal.kind).toBe("complete");
    expect(lowered.records?.some((shape) => shape.id.startsWith("%hosted.frame."))).toBe(true);
  });

  test("C emits PromiseCore continuation attachment without fibers", () => {
    const source = emitModule(moduleOf(suspended));
    expect(source).toContain("scr_promise_await_hosted(");
    expect(source).toContain("scr_hosted_await_f64(sc_settled)");
    expect(source).toContain("hosted_resume");
    expect(source).toContain("scr_promise_reject_pending(sc_result)");
    expect(source).not.toContain("scr_async_spawn(");
    execFileSync(process.env["CC"] ?? "clang", [
      "-std=c11",
      "-x",
      "c",
      "-fsyntax-only",
      "-DSCR_LIB",
      "-Ipackages/runtime/src",
      "-",
    ], { input: source });
  });

  test("LLVM emits the same stackless continuation contract", () => {
    const source = emitLlvmModule(moduleOf(suspended));
    expect(source).toContain("call zeroext i1 @scr_promise_await_hosted(");
    expect(source).toContain("call double @scr_hosted_await_f64(ptr %settled)");
    expect(source).toContain("hosted_resume");
    expect(source).toContain("call void @scr_promise_reject_pending(ptr %result)");
    expect(source).not.toContain("call ptr @scr_async_spawn");
    execFileSync(process.env["CC"] ?? "clang", [
      "-x",
      "ir",
      "-c",
      "-o",
      "/dev/null",
      "-",
    ], { input: source });
  });
});
