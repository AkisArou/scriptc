import type { IrExpr } from "../ir/nodes.js";

/**
 * Whether every value an expression can produce is backed by static storage
 * whose refcount is permanently immortal.
 *
 * Keep this deliberately narrower than "does not allocate": the result may
 * cross an ownership boundary without a retain or release only when its
 * storage outlives every possible owner.  String literals have that property,
 * and a conditional preserves it exactly when both arms do.  The shared fact
 * keeps the C and LLVM ownership frames in lockstep.
 */
export function expressionResultIsImmortal(expr: IrExpr): boolean {
  switch (expr.kind) {
    case "strLit":
      return true;
    case "ternary":
      return expressionResultIsImmortal(expr.then) &&
        expressionResultIsImmortal(expr.else_);
    default:
      return false;
  }
}
