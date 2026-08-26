import { describe, expect, test } from "vitest";
import { emitModule } from "../backend/emission/emitter.js";
import { emitLlvmModule } from "../backend/llvm/emitter.js";
import { IR_VERSION, type IrModule } from "./nodes.js";
import {
  specializeNativeFrameResources,
  validateNativeFrameResources,
} from "./native-frame-resources.js";

const loc = { file: "frame-callback.ts", start: 0, end: 0 } as const;
const f64 = { kind: "f64" } as const;
const voidType = { kind: "void" } as const;
const subscription = { kind: "nativeHandle", typeId: "subscription" } as const;
const callbackType = { kind: "func", params: [], ret: voidType } as const;

function fixture(): IrModule {
  const callback = {
    owner: { kind: "result" },
    cancellationBinding: "cancel",
    allowedInvocationExecutors: ["same-as-caller"],
    synchronousReturn: true,
    sourceArguments: [],
  } as const;
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "run",
    functions: [
      {
        name: "%handler",
        params: [],
        returnType: voidType,
        captures: [{ localId: "checksum.capture", name: "checksum", type: f64 }],
        locals: [
          {
            id: "checksum.capture",
            name: "checksum",
            type: f64,
            mutable: true,
            boxed: true,
          },
        ],
        body: [
          {
            kind: "assign",
            localId: "checksum.capture",
            value: { kind: "numLit", value: 42, type: f64, loc },
            loc,
          },
        ],
        loc,
      },
      {
        name: "run",
        params: [],
        returnType: voidType,
        locals: [
          {
            id: "checksum",
            name: "checksum",
            type: f64,
            mutable: true,
            boxed: true,
          },
          {
            id: "registration",
            name: "registration",
            type: subscription,
            mutable: false,
          },
        ],
        body: [
          {
            kind: "varDecl",
            localId: "checksum",
            init: { kind: "numLit", value: 0, type: f64, loc },
            loc,
          },
          {
            kind: "varDecl",
            localId: "registration",
            init: {
              kind: "nativeCall",
              binding: "listen",
              args: [
                {
                  kind: "closure",
                  fnName: "%handler",
                  captures: ["checksum"],
                  type: callbackType,
                  loc,
                },
              ],
              type: subscription,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "nativeCall",
              binding: "cancel",
              args: [
                { kind: "varRef", localId: "registration", type: subscription, loc },
              ],
              type: voidType,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
    nativeTypes: [
      {
        kind: "handle",
        id: "subscription",
        declaration: { module: "fixture", name: "Subscription" },
        nativeName: "FixtureSubscription",
        threadSafety: "confined",
        identity: "none",
        cycleCollection: "none",
        upcasts: [],
      },
    ],
    nativeBindings: [
      {
        id: "listen",
        declaration: { module: "fixture", name: "listen" },
        entry: { symbol: "listen_stable" },
        sourceAccess: "call",
        error: {
          detect: { kind: "never" },
          message: { kind: "none" },
          release: { kind: "none" },
        },
        arguments: [{ name: "callback", type: callbackType, callback }],
        parameters: [
          {
            name: "callback",
            type: {
              kind: "nativeCallback",
              signature: {
                parameters: [{ kind: "nativeContext", addressSpace: 0 }],
                result: voidType,
              },
            },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackFunction", argument: 0 },
          },
          {
            name: "context",
            type: { kind: "nativeContext", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackContext", argument: 0 },
          },
          {
            name: "release_context",
            type: {
              kind: "nativeCallback",
              signature: {
                parameters: [{ kind: "nativeContext", addressSpace: 0 }],
                result: voidType,
              },
            },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackContextRelease", argument: 0 },
          },
        ],
        result: {
          type: subscription,
          passMode: "pointer",
          ownership: {
            kind: "owned",
            transfer: "to-runtime",
            destructor: "cancel",
          },
          projection: { kind: "direct" },
          frameBounded: {
            entry: { symbol: "listen_frame" },
            release: { symbol: "release_frame" },
          },
        },
      },
      {
        id: "cancel",
        declaration: { module: "fixture", name: "cancel" },
        entry: { symbol: "cancel" },
        sourceAccess: "call",
        error: {
          detect: { kind: "never" },
          message: { kind: "none" },
          release: { kind: "none" },
        },
        arguments: [{ name: "registration", type: subscription }],
        parameters: [
          {
            name: "registration",
            type: subscription,
            passMode: "pointer",
            ownership: { kind: "borrowed", scope: "call" },
            projection: { kind: "argument", argument: 0 },
          },
        ],
        result: {
          type: voidType,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "direct" },
        },
      },
    ],
  } as unknown as IrModule;
}

function selectedParts(mod: IrModule) {
  const run = mod.functions.find(({ name }) => name === "run")!;
  const declaration = run.body[1] as Extract<(typeof run.body)[number], { kind: "varDecl" }>;
  const call = declaration.init as Extract<NonNullable<typeof declaration.init>, { kind: "nativeCall" }>;
  const closure = call.args[0] as Extract<(typeof call.args)[number], { kind: "closure" }>;
  const capture = run.locals.find(({ id }) => id === "checksum")!;
  return { run, call, closure, capture };
}

describe("frame-bounded native callback contexts", () => {
  test("selects an immortal stack closure and scalar capture box", () => {
    const mod = fixture();
    specializeNativeFrameResources(mod);
    const { call, closure, capture } = selectedParts(mod);
    expect(call.resultMode).toBe("frameBounded");
    expect(closure.nativeFrameContext).toBe(true);
    expect(capture.nativeFrameCapture).toBe(true);
    expect(validateNativeFrameResources(
      mod,
      new Map(mod.nativeBindings!.map((binding) => [binding.id, binding])),
    )).toEqual([]);
  });

  test("C and LLVM reserve one reusable closure slot at function entry", () => {
    const mod = fixture();
    specializeNativeFrameResources(mod);

    const c = emitModule(mod);
    expect(c).toMatch(
      /void \*sc_frame_closure_storage_0 = SCR_STACK_ALLOC\(SCR_CLOSURE_FRAME_BYTES\(1\)\);/u,
    );
    expect(c).toMatch(/scr_closure_init_frame\(sc_frame_closure_storage_0,/u);
    expect(c).not.toMatch(/scr_closure_init_frame\(SCR_STACK_ALLOC/u);
    const cFrameTrampoline = c.match(
      /static void sc_native_cb_\d+_frame\([^)]*\) \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(cFrameTrampoline).toBeDefined();
    expect(cFrameTrampoline).not.toContain("scr_closure_retain");
    expect(cFrameTrampoline).not.toContain("scr_closure_release");

    const llvm = emitLlvmModule(mod);
    expect(llvm).toMatch(/alloca \[5 x ptr\]/u);
    expect(llvm).toMatch(/call ptr @scr_closure_init_frame/u);
    const llvmFrameTrampoline = llvm.match(
      /define internal void @sc_native_cb_\d+_frame\([^)]*\)[^{]*\{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(llvmFrameTrampoline).toBeDefined();
    expect(llvmFrameTrampoline).not.toContain("scr_closure_retain");
    expect(llvmFrameTrampoline).not.toContain("scr_closure_release");
  });

  test.each([
    ["a foreign executor", (mod: IrModule) => {
      mod.nativeBindings![0]!.arguments[0]!.callback!.allowedInvocationExecutors =
        ["same-as-caller", "any-attached-thread"];
    }],
    ["another closure using the capture", (mod: IrModule) => {
      const { run } = selectedParts(mod);
      run.body.push({
        kind: "exprStmt",
        expr: {
          kind: "closure",
          fnName: "%handler",
          captures: ["checksum"],
          type: callbackType,
          loc,
        },
        loc,
      });
    }],
    ["self-reference from the handler", (mod: IrModule) => {
      mod.functions[0]!.body.push({
        kind: "exprStmt",
        expr: { kind: "selfRef", type: callbackType, loc },
        loc,
      });
    }],
  ] as const)("keeps the heap fallback for %s", (_name, makeUnsafe) => {
    const mod = fixture();
    makeUnsafe(mod);
    specializeNativeFrameResources(mod);
    const { call, closure, capture } = selectedParts(mod);
    expect(call.resultMode).toBe("frameBounded");
    expect(closure.nativeFrameContext).toBeUndefined();
    expect(capture.nativeFrameCapture).toBeUndefined();
  });

  test("validation rejects a context whose stack-capture marker is missing", () => {
    const mod = fixture();
    specializeNativeFrameResources(mod);
    delete selectedParts(mod).capture.nativeFrameCapture;
    expect(validateNativeFrameResources(
      mod,
      new Map(mod.nativeBindings!.map((binding) => [binding.id, binding])),
    ).map(({ message }) => message)).toContain(
      'closure %handler uses a frame-bounded context without a frame capture for "checksum"',
    );
  });
});
