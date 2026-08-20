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
import { nativeCallIsThrowCheckpoint } from "../src/backend/native-call-plan.js";
import type { IrNativeBinding } from "../src/ir/nodes.js";

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
