import { expect, test } from "vitest";
import { validateModule } from "../src/ir/validate.js";
import { deserializeModule, serializeModule } from "../src/ir/serialize.js";
import { fibModule } from "./fixtures/fib-ir.js";
import { arrayOf, BOOL, canDynCheckTo, F64, funcOf, HTTP2SESSION_T, HTTP2STREAM_T, HTTPCLIENTREQ_T, HTTPREQ_T, HTTPRES_T, NETSERVER_T, NETSOCKET_T, NULL_T, RUNTIME_HANDLE_IDENTITY_KINDS, UNDEFINED_T, type IrModule, type IrRecordShape, type IrType, type IrUnionDef } from "../src/ir/nodes.js";
import { markDenseArrayReads } from "../src/ir/dense-arrays.js";

test("hand-built fib module validates", () => {
  expect(validateModule(fibModule)).toEqual([]);
});

test("fib module JSON round-trips", () => {
  const json = serializeModule(fibModule);
  expect(deserializeModule(json)).toEqual(fibModule);
});

test("runtime handle identity set covers every stable pointer handle", () => {
  expect([...RUNTIME_HANDLE_IDENTITY_KINDS].sort()).toEqual([
    "child", "childStream", "dgramSocket", "fsWatcher", "http2Session", "http2Stream",
    "httpClientReq", "httpReq", "httpRes", "netServer", "netSocket", "secureCtx", "testCtx",
  ]);
  expect(RUNTIME_HANDLE_IDENTITY_KINDS.has("procStream")).toBe(false);
  expect(RUNTIME_HANDLE_IDENTITY_KINDS.has("stats")).toBe(false);
  expect(RUNTIME_HANDLE_IDENTITY_KINDS.has("spawnRes")).toBe(false);
});

test("validator rejects runtime-handle identity for scalar and snapshot kinds", () => {
  const loc = { file: "identity.ts", start: 0, end: 0 };
  const kinds: IrType[] = [{ kind: "procStream" }, { kind: "stats" }, { kind: "spawnRes" }];
  const mod: IrModule = {
    irVersion: 3,
    sourceFile: "identity.ts",
    entry: "eq0",
    functions: kinds.map((type, i) => ({
      name: `eq${i}`,
      params: [
        { localId: "a.0", name: "a", type },
        { localId: "b.0", name: "b", type },
      ],
      returnType: BOOL,
      locals: [
        { id: "a.0", name: "a", type, mutable: false },
        { id: "b.0", name: "b", type, mutable: false },
      ],
      body: [{
        kind: "return" as const,
        value: {
          kind: "bin" as const,
          op: "===" as const,
          left: { kind: "varRef" as const, localId: "a.0", type, loc },
          right: { kind: "varRef" as const, localId: "b.0", type, loc },
          type: BOOL,
          loc,
        },
        loc,
      }],
      loc,
    })),
  };
  expect(validateModule(mod).map((e) => e.message)).toEqual([
    "in eq0: bin === left: expected f64, got procStream",
    "in eq0: bin === right: expected f64, got procStream",
    "in eq1: bin === left: expected f64, got stats",
    "in eq1: bin === right: expected f64, got stats",
    "in eq2: bin === left: expected f64, got spawnRes",
    "in eq2: bin === right: expected f64, got spawnRes",
  ]);
});

test("dynCheck eligibility matches recursive builders and union matchers", () => {
  const recursive: IrType = { kind: "union", unionId: "recursive" };
  const callable = funcOf([], recursive);
  const functionUnion: IrType = { kind: "union", unionId: "functionUnion" };
  const errorT: IrType = { kind: "object", className: "%Error" };
  const errorUnion: IrType = { kind: "union", unionId: "errorUnion" };
  const handleUnion: IrType = { kind: "union", unionId: "handleUnion" };
  const recordT: IrType = { kind: "record", shapeId: "functionRecord" };
  const wrappedErrorT: IrType = { kind: "record", shapeId: "errorRecord" };
  const wrappedHandleT: IrType = { kind: "record", shapeId: "handleRecord" };
  const wrappedErrorUnion: IrType = { kind: "union", unionId: "wrappedErrorUnion" };
  const wrappedHandleUnion: IrType = { kind: "union", unionId: "wrappedHandleUnion" };
  const records = new Map<string, IrRecordShape>([
    ["functionRecord", { id: "functionRecord", fields: [{ name: "item", type: functionUnion }] }],
    ["errorRecord", { id: "errorRecord", fields: [{ name: "error", type: errorT }] }],
    ["handleRecord", { id: "handleRecord", fields: [{ name: "request", type: HTTPREQ_T }] }],
  ]);
  const unions = new Map<string, IrUnionDef>([
    ["recursive", { id: "recursive", arms: [F64, callable] }],
    ["functionUnion", { id: "functionUnion", arms: [F64, funcOf([], F64)] }],
    ["errorUnion", { id: "errorUnion", arms: [F64, errorT] }],
    ["handleUnion", { id: "handleUnion", arms: [F64, HTTPREQ_T] }],
    ["wrappedErrorUnion", { id: "wrappedErrorUnion", arms: [F64, wrappedErrorT] }],
    ["wrappedHandleUnion", { id: "wrappedHandleUnion", arms: [F64, wrappedHandleT] }],
  ]);
  const can = (t: IrType): boolean => canDynCheckTo(t, (id) => records.get(id), (id) => unions.get(id));

  expect(can(recursive)).toBe(true);
  expect(can(recordT)).toBe(true);
  expect(can(errorT)).toBe(true);
  expect(can(HTTPREQ_T)).toBe(true);
  expect(can(HTTPRES_T)).toBe(true);
  expect(can(NETSOCKET_T)).toBe(true);
  expect(can(NETSERVER_T)).toBe(true);
  expect(can(HTTP2SESSION_T)).toBe(true);
  expect(can(HTTP2STREAM_T)).toBe(true);
  expect(can(HTTPCLIENTREQ_T)).toBe(true);
  expect(can(arrayOf(errorT))).toBe(true);
  expect(can(arrayOf(functionUnion))).toBe(true);
  expect(can(arrayOf({ kind: "bytes", elem: "u8" }))).toBe(true);
  expect(can(arrayOf(arrayOf(F64)))).toBe(true);
  expect(can(arrayOf(NETSERVER_T))).toBe(true);
  expect(can(arrayOf(HTTPREQ_T))).toBe(false);
  expect(can(arrayOf(HTTPRES_T))).toBe(false);
  expect(can(arrayOf(NETSOCKET_T))).toBe(false);
  expect(can(arrayOf(HTTP2SESSION_T))).toBe(false);
  expect(can(wrappedErrorT)).toBe(true);
  expect(can(wrappedHandleT)).toBe(true);
  expect(can(NULL_T)).toBe(false);
  expect(can(UNDEFINED_T)).toBe(false);
  expect(can(errorUnion)).toBe(false);
  expect(can(handleUnion)).toBe(false);
  expect(can(wrappedErrorUnion)).toBe(false);
  expect(can(wrappedHandleUnion)).toBe(false);
});

test("validator rejects type mismatches and bad references", () => {
  const loc = { file: "t.ts", start: 0, end: 0 };
  const bad: IrModule = {
    irVersion: 3,
    sourceFile: "t.ts",
    entry: "__main",
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [{ id: "x.0", name: "x", type: F64, mutable: false }],
        body: [
          // init type mismatch: bool into f64 local
          { kind: "varDecl", localId: "x.0", init: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
          // undeclared local
          { kind: "assign", localId: "y.0", value: { kind: "numLit", value: 1, type: F64, loc }, loc },
          // assign to immutable
          { kind: "assign", localId: "x.0", value: { kind: "numLit", value: 1, type: F64, loc }, loc },
          // call to unknown function
          { kind: "exprStmt", expr: { kind: "call", callee: "nope", args: [], type: F64, loc }, loc },
        ],
        loc,
      },
    ],
  };
  const errors = validateModule(bad).map((e) => e.message);
  expect(errors).toEqual([
    expect.stringContaining('init: expected f64, got bool'),
    expect.stringContaining('undeclared local/global "y.0"'),
    expect.stringContaining('immutable local "x"'),
    expect.stringContaining('undeclared function "nope"'),
  ]);
});

test("serializer round-trips ±Infinity and refuses NaN", () => {
  const mod = structuredClone(fibModule);
  const fn = mod.functions[0]!;
  const stmt = fn.body[0]!;
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = Infinity;
  }
  const back = deserializeModule(serializeModule(mod));
  const stmt2 = back.functions[0]!.body[0]!;
  if (stmt2.kind === "if" && stmt2.cond.kind === "bin" && stmt2.cond.right.kind === "numLit") {
    expect(stmt2.cond.right.value).toBe(Infinity);
  } else {
    throw new Error("round-trip lost the statement shape");
  }
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = -Infinity;
  }
  const back2 = deserializeModule(serializeModule(mod));
  const stmt3 = back2.functions[0]!.body[0]!;
  if (stmt3.kind === "if" && stmt3.cond.kind === "bin" && stmt3.cond.right.kind === "numLit") {
    expect(stmt3.cond.right.value).toBe(-Infinity);
  }
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = NaN;
  }
  expect(() => serializeModule(mod)).toThrow(/NaN/);
});

test("deserializer enforces IR version", () => {
  const json = serializeModule(fibModule).replace('"irVersion": 3', '"irVersion": 99');
  expect(() => deserializeModule(json)).toThrow(/version mismatch/);
});

test("dense-array pass bypasses hole checks only for untouched packed locals", () => {
  const loc = { file: "t.ts", start: 0, end: 0 };
  const arr = arrayOf(F64);
  const get = (id: string) => ({ kind: "arrayGet" as const, arr: { kind: "varRef" as const, localId: id, type: arr, loc }, index: { kind: "numLit" as const, value: 0, type: F64, loc }, type: F64, loc });
  const mod: IrModule = {
    irVersion: 3,
    sourceFile: "t.ts",
    entry: "dense",
    functions: [
      {
        name: "dense", params: [], returnType: F64, locals: [{ id: "a.0", name: "a", type: arr, mutable: false }], loc,
        body: [{ kind: "varDecl", localId: "a.0", init: { kind: "arrayLit", elems: [{ kind: "numLit", value: 1, type: F64, loc }], type: arr, loc }, loc }, { kind: "return", value: get("a.0"), loc }],
      },
      {
        name: "holey", params: [], returnType: F64, locals: [{ id: "a.0", name: "a", type: arr, mutable: false }], loc,
        body: [{ kind: "varDecl", localId: "a.0", init: { kind: "arrayLit", elems: [{ kind: "numLit", value: 1, type: F64, loc }], type: arr, loc }, loc }, { kind: "arrayDelete", arr: { kind: "varRef", localId: "a.0", type: arr, loc }, index: { kind: "numLit", value: 0, type: F64, loc }, loc }, { kind: "return", value: get("a.0"), loc }],
      },
      {
        name: "written", params: [], returnType: F64, locals: [{ id: "a.0", name: "a", type: arr, mutable: false }], loc,
        body: [{ kind: "varDecl", localId: "a.0", init: { kind: "arrayLit", elems: [{ kind: "numLit", value: 1, type: F64, loc }], type: arr, loc }, loc }, { kind: "arraySet", arr: { kind: "varRef", localId: "a.0", type: arr, loc }, index: { kind: "numLit", value: 4, type: F64, loc }, value: { kind: "numLit", value: 5, type: F64, loc }, loc }, { kind: "return", value: get("a.0"), loc }],
      },
    ],
  };
  markDenseArrayReads(mod);
  const dense = mod.functions[0]!.body[1]!;
  const holey = mod.functions[1]!.body[2]!;
  const written = mod.functions[2]!.body[2]!;
  expect(dense.kind === "return" && dense.value?.kind === "arrayGet" && dense.value.dense).toBe(true);
  expect(holey.kind === "return" && holey.value?.kind === "arrayGet" && holey.value.dense).toBeFalsy();
  expect(written.kind === "return" && written.value?.kind === "arrayGet" && written.value.dense).toBeFalsy();
});
