import { expect, test } from "vitest";
import { emitModule } from "../src/backend/emission/emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { BOOL, F64, VOID, bytesOf, type IrBytesElem, type IrExpr, type IrLocal, type IrModule, type IrStmt } from "../src/ir/nodes.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "bytes-hot-loop.ts", start: 0, end: 0 };
const elems: IrBytesElem[] = ["u8", "u32", "i32", "f32"];

function fixture(): IrModule {
  const locals: IrLocal[] = [];
  const body: IrStmt[] = [];
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });

  for (const [n, elem] of elems.entries()) {
    const type = bytesOf(elem);
    const localId = `b.${n}`;
    const ref = (): IrExpr => ({ kind: "varRef", localId, type, loc });
    locals.push({ id: localId, name: `b${n}`, type, mutable: false });
    body.push(
      {
        kind: "varDecl",
        localId,
        init: { kind: "bytesNew", source: num(1), type, loc },
        loc,
      },
      { kind: "bytesSet", arr: ref(), index: num(0), value: num(n + 1), loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: ref(),
          args: [num(0)],
          type: F64,
          loc,
        },
        loc,
      },
    );
  }

  locals.push({ id: "index", name: "index", type: F64, mutable: true });
  body.push(
    { kind: "varDecl", localId: "index", init: num(1), loc },
    {
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: { kind: "varRef", localId: "b.0", type: bytesOf("u8"), loc },
        args: [
          {
            kind: "assignExpr",
            localId: "index",
            value: num(0),
            type: F64,
            loc,
          },
        ],
        type: F64,
        loc,
      },
      loc,
    },
  );

  return {
    irVersion: 3,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals, body, loc }],
  };
}

function receiverReassignmentFixture(): IrModule {
  const bytes = bytesOf("u8");
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: bytes, loc });
  const replacementCondition = (receiverId: string, replacementId: string): IrExpr => ({
    kind: "toBool",
    operand: {
      kind: "assignExpr",
      localId: receiverId,
      value: ref(replacementId),
      type: bytes,
      loc,
    },
    type: BOOL,
    loc,
  });
  const numericTernary = (cond: IrExpr, thenValue: number, elseValue: number): IrExpr => ({
    kind: "ternary",
    cond,
    then: num(thenValue),
    else_: num(elseValue),
    type: F64,
    loc,
  });
  const locals: IrLocal[] = [
    { id: "read", name: "read", type: bytes, mutable: true },
    { id: "readReplacement", name: "readReplacement", type: bytes, mutable: false },
    { id: "write", name: "write", type: bytes, mutable: true },
    { id: "writeReplacement", name: "writeReplacement", type: bytes, mutable: false },
  ];
  const declareBytes = (localId: string): IrStmt => ({
    kind: "varDecl",
    localId,
    init: { kind: "bytesNew", source: num(1), type: bytes, loc },
    loc,
  });
  const body: IrStmt[] = [
    declareBytes("read"),
    declareBytes("readReplacement"),
    {
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: ref("read"),
        args: [numericTernary(replacementCondition("read", "readReplacement"), 0, 0)],
        type: F64,
        loc,
      },
      loc,
    },
    declareBytes("write"),
    declareBytes("writeReplacement"),
    {
      kind: "bytesSet",
      arr: ref("write"),
      index: num(0),
      value: numericTernary(replacementCondition("write", "writeReplacement"), 55, 66),
      loc,
    },
  ];

  return {
    irVersion: 3,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals, body, loc }],
  };
}

function sideEffectFixture(): IrModule {
  const mod = fixture();
  mod.functions.unshift({
    name: "sideIndex",
    params: [],
    returnType: F64,
    locals: [],
    body: [{ kind: "return", value: { kind: "numLit", value: 0, type: F64, loc }, loc }],
    loc,
  });
  mod.functions.find((fn) => fn.name === "__main")!.body.push({
    kind: "exprStmt",
    expr: {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: { kind: "varRef", localId: "b.0", type: bytesOf("u8"), loc },
      args: [{ kind: "call", callee: "sideIndex", args: [], type: F64, loc }],
      type: F64,
      loc,
    },
    loc,
  });
  return mod;
}

test("C emission specializes typed-array element access by static element kind", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const c = emitModule(mod);
  for (const elem of elems) {
    expect(c).toContain(`sc_bytes_get_${elem}(`);
    expect(c).toContain(`sc_bytes_set_${elem}(`);
  }
  // The only generic calls are the shared cold invalid-index trap funnel.
  expect(c.match(/\bscr_bytes_get\(/g)).toHaveLength(2);
  expect(c).not.toMatch(/\bscr_bytes_set\(/);
  expect(c).not.toContain("scr_bytes_retain(");
});

test("LLVM emission performs typed-array element access directly on the valid path", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const ll = emitLlvmModule(mod);
  expect(ll).toContain("%ScrBytes = type { i64, i64, i32, ptr, ptr }");
  expect(ll).toContain("getelementptr inbounds i8");
  expect(ll).toContain("getelementptr inbounds i32");
  expect(ll).toContain("getelementptr inbounds float");
  expect(ll).toContain("bytes.index.invalid");
  // The generic getter is only the shared cold trap funnel for invalid indices.
  expect(ll).toContain("call double @scr_bytes_get");
  expect(ll).not.toContain("@scr_bytes_set(");
  expect(ll).not.toContain("@scr_bytes_retain_v");
});

test("side-effecting indices retain the receiver snapshot", () => {
  const mod = sideEffectFixture();
  expect(validateModule(mod)).toEqual([]);
  const c = emitModule(mod);
  const ll = emitLlvmModule(mod);
  expect(c).toContain("scr_bytes_retain(sc_l_b_0)");
  expect(ll).toContain("call ptr @scr_bytes_retain_v");
  expect(c.match(/\bscr_bytes_get\(/g)).toHaveLength(2);
  expect(ll).toContain("call double @scr_bytes_get");
});

test("receiver assignments nested in numeric operands retain the receiver snapshot", () => {
  const mod = receiverReassignmentFixture();
  expect(validateModule(mod)).toEqual([]);
  const c = emitModule(mod);
  const ll = emitLlvmModule(mod);
  expect(c).toContain("scr_bytes_retain(sc_l_read)");
  expect(c).toContain("scr_bytes_retain(sc_l_write)");
  // Two receiver snapshots plus two retains per yielded bytes assignment
  // (one for the RHS temp and one for the binding's stored reference).
  expect(ll.match(/call ptr @scr_bytes_retain_v/g)).toHaveLength(6);
});
