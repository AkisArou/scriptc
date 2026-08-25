/* The decisions both backends must reach identically, asserted directly.
 *
 * `native-call-plan.ts` exists because a `nativeCall` lowering used to decide
 * the same things twice, and five defects came from the two answers drifting.
 * Until now nothing imported it from a test: the shared layer was covered only
 * end-to-end, through programs that exercise one arm each. That is enough to
 * catch a decision that is WRONG and useless against a decision that is merely
 * DIFFERENT on the two sides, because both backends produce a working program
 * either way — they simply produce different ones.
 *
 * `callbacksMayThrow` drifted exactly there and stayed drifted, three lines
 * above a comment promising the backends shared their decisions.
 */
import { expect, test } from "vitest";
import {
  nativeCallHandleBorrowSource,
  nativeCallIsThrowCheckpoint,
  nativeResultCopy,
} from "../src/backend/native-call-plan.js";
import type { NativeResultCopyForm } from "../src/backend/native-call-plan.js";
import type { IrExpr, IrNativeBinding } from "../src/ir/nodes.js";

type CallbackOwnerKind = "call" | "result" | "argument" | "process";

/** A binding with one argument, whose type and callback owner are the only
 * things under test. Everything else a binding carries is irrelevant to a
 * predicate over argument types, and spelling it out would only invite the
 * reader to think it mattered. */
function bindingWithCallback(owner: CallbackOwnerKind): IrNativeBinding {
  return {
    arguments: [{
      name: "handler",
      type: { kind: "func" },
      callback: { owner: { kind: owner } },
    }],
  } as unknown as IrNativeBinding;
}

function bindingWithoutCallback(): IrNativeBinding {
  return {
    arguments: [{ name: "value", type: { kind: "nativeScalar", scalar: "i32" } }],
  } as unknown as IrNativeBinding;
}

test("any callback argument makes the call a throw checkpoint", () => {
  for (const owner of ["call", "result", "argument", "process"] as const) {
    expect(nativeCallIsThrowCheckpoint(bindingWithCallback(owner), false)).toBe(true);
  }
});

test("the callback's owner scope does not change the answer", () => {
  /* The regression this file was added for. Scope says when a registration
   * ENDS; the checkpoint asks whether this call can re-enter managed code, and
   * a retained callback registered here may be invoked before the registering
   * call returns. Narrowing on scope made an owner-scoped retained callback —
   * a signal connected to a handle — a checkpoint in C and not in LLVM. */
  const answers = new Set(
    (["call", "result", "argument", "process"] as const).map((owner) =>
      nativeCallIsThrowCheckpoint(bindingWithCallback(owner), false)
    ),
  );
  expect(answers.size).toBe(1);
});

test("a call with no callback is not a checkpoint on its own", () => {
  expect(nativeCallIsThrowCheckpoint(bindingWithoutCallback(), false)).toBe(false);
});

test("a module holding a retained registration makes every call a checkpoint", () => {
  /* A retained profile callback defers its throw to whichever native call
   * checks next, so every call has to be willing to be that one. */
  expect(nativeCallIsThrowCheckpoint(bindingWithoutCallback(), true)).toBe(true);
});

/* The copy families, and specifically the axis that is easy to get wrong.
 *
 * Both backends laddered these eight arms out by hand, and the ladders agreed
 * — but agreeing is not the same as being stated. The non-null requirement
 * sits at a DIFFERENT POINT for two of the families, for a reason that is
 * invisible unless someone says it: a byte span must be checked before the
 * copy because the copy reads a length slot describing that pointer, while a
 * C string is checked after the release because the copy answers null for null
 * and the foreign pointer still has to be freed on the way out.
 *
 * A legalizer that picked one position would produce the other family's
 * semantics: either a length slot read for a pointer that is not there, or a
 * leak on the throwing path. Neither is visible in a passing suite until a
 * program meets it.
 */
test("a byte span is checked before the copy, a C string after it", () => {
  const bytes = nativeResultCopy({
    kind: "bytesResult", elem: "u8", release: "g_free", lengthParameter: 1,
  } as NativeResultCopyForm);
  expect(bytes?.requireNonNull).toBe("raw");

  const cstring = nativeResultCopy({
    kind: "utf8CString", release: "g_free",
  } as NativeResultCopyForm);
  expect(cstring?.requireNonNull).toBe("managed");

  const vector = nativeResultCopy({
    kind: "utf8CStringArray", release: "g_strfreev",
  } as NativeResultCopyForm);
  expect(vector?.requireNonNull).toBe("managed");
});

test("a projection admitting absence requires nothing and carries its arms", () => {
  const copy = nativeResultCopy({
    kind: "utf8CStringOrNull", release: null, unionId: "u", stringTag: 1, nullTag: 0,
  } as NativeResultCopyForm);
  expect(copy?.requireNonNull).toBeNull();
  expect(copy?.absent).toEqual({ unionId: "u", presentTag: 1, nullTag: 0 });
});

test("only the UTF-8 decoder is skipped for a null pointer", () => {
  /* The C-string copies answer null for null; the decoder would be handed a
   * pointer that is not there, and its nullable arm is exactly where that
   * happens. */
  const span = nativeResultCopy({
    kind: "utf8SpanResultOrNull", release: null, lengthParameter: 1,
    unionId: "u", stringTag: 1, nullTag: 0,
  } as NativeResultCopyForm);
  expect(span?.adoptSkipsNull).toBe(true);
  const cstring = nativeResultCopy({ kind: "utf8CString", release: null } as NativeResultCopyForm);
  expect(cstring?.adoptSkipsNull).toBe(false);
});

test("every copying form is described, none throws", () => {
  /* The driver's default arm binds `never`, so a form named by
   * `NativeResultCopyForm` and not described stops the build. This asserts the
   * runtime half of the same claim: each of the seven answers a description
   * rather than the diagnostic that arm would raise. */
  const forms: NativeResultCopyForm[] = [
    { kind: "bytesResult", elem: "u8", release: null, lengthParameter: 1 },
    { kind: "utf8SpanResult", release: null, lengthParameter: 1 },
    { kind: "utf8SpanResultOrNull", release: null, lengthParameter: 1, unionId: "u", stringTag: 1, nullTag: 0 },
    { kind: "utf8CString", release: null },
    { kind: "utf8CStringOrNull", release: null, unionId: "u", stringTag: 1, nullTag: 0 },
    { kind: "utf8CStringArray", release: null },
    { kind: "utf8CStringArrayOrNull", release: null, unionId: "u", arrayTag: 1, nullTag: 0 },
  ];
  for (const form of forms) expect(nativeResultCopy(form).adopt).toBeDefined();
});

const loc = { file: "borrow.ts", start: 0, end: 0 };
const HANDLE = { kind: "nativeHandle", typeId: "type:handle" } as const;
const I32 = { kind: "nativeScalar", scalar: "i32" } as const;

function handleCallBinding(ownership: "borrowed" | "owned" = "borrowed"): IrNativeBinding {
  return {
    parameters: [
      {
        type: HANDLE,
        projection: { kind: "argument", argument: 0 },
        ownership: ownership === "borrowed"
          ? { kind: "borrowed", scope: "call" }
          : { kind: "owned", transfer: "to-native" },
      },
      {
        type: I32,
        projection: { kind: "argument", argument: 1 },
        ownership: { kind: "value" },
      },
    ],
  } as unknown as IrNativeBinding;
}

function handleRef(localId = "handle"): IrExpr {
  return { kind: "varRef", localId, type: HANDLE, loc };
}

test("a non-owning handle local with stable following arguments is call-borrowable", () => {
  const zero: IrExpr = { kind: "numLit", value: 0, type: { kind: "f64" }, loc };
  const value: IrExpr = {
    kind: "ternary",
    cond: { kind: "boolLit", value: true, type: { kind: "bool" }, loc },
    then: { kind: "nativeScalarLit", value: "1", type: I32, loc },
    else_: { kind: "nativeScalarLit", value: "2", type: I32, loc },
    type: I32,
    loc,
  };
  expect(nativeCallHandleBorrowSource(handleCallBinding(), [handleRef(), value], 0))
    .toEqual({ localId: "handle", unionTag: null });
  /* The scalar literal above is the Chromium setter shape; keep a plain
   * scalar alongside it so a future narrowing of the whitelist stays clear. */
  expect(nativeCallHandleBorrowSource(handleCallBinding(), [handleRef(), zero], 0))
    .toEqual({ localId: "handle", unionTag: null });
});

test("a narrowed nullable-handle local borrows its proven arm", () => {
  const nullable = {
    kind: "unionNarrow",
    unionId: "handle-or-null",
    tag: 1,
    value: {
      kind: "varRef",
      localId: "optional",
      type: { kind: "union", unionId: "handle-or-null" },
      loc,
    },
    type: HANDLE,
    loc,
  } as const satisfies IrExpr;
  expect(nativeCallHandleBorrowSource(handleCallBinding(), [nullable, {
    kind: "nativeScalarLit", value: "0", type: I32, loc,
  }], 0)).toEqual({ localId: "optional", unionTag: 1 });

  const derived = { kind: "nativeHandle", typeId: "type:derived" } as const;
  const upcast = {
    kind: "upcast",
    value: { ...nullable, type: derived },
    type: HANDLE,
    loc,
  } as const satisfies IrExpr;
  expect(nativeCallHandleBorrowSource(handleCallBinding(), [upcast, {
    kind: "nativeScalarLit", value: "0", type: I32, loc,
  }], 0)).toEqual({ localId: "optional", unionTag: 1 });
});

test("ownership transfer and effectful following evaluation keep owned snapshots", () => {
  const mutation = {
    kind: "assignExpr",
    localId: "handle",
    value: handleRef("replacement"),
    type: HANDLE,
    loc,
  } as const satisfies IrExpr;
  expect(nativeCallHandleBorrowSource(handleCallBinding("owned"), [handleRef(), {
    kind: "nativeScalarLit", value: "1", type: I32, loc,
  }], 0)).toBeNull();
  expect(nativeCallHandleBorrowSource(handleCallBinding(), [handleRef(), mutation], 0))
    .toBeNull();
});
