/* The number facts: a flow-sensitive forward abstract interpretation over
 * the lowered IR that PROVES wholeness and range for every value reaching
 * a boundary slot, or REFUSES with the failed obligation, the observed
 * evidence, and the author's fix.
 *
 * It has three consumers, and they ask the same question of the same domain.
 * The library lane asks it of a profile-declared i64/u64 slot, where a
 * failed proof is an error because the slot has no run-time check. The
 * native lane asks it of a checked-number parameter projection, where a
 * failed proof is merely the ordinary answer — the check stays — and a
 * successful one deletes the check. The JVM tier asks whether a local and
 * the expressions feeding it can use a Java int without changing number
 * semantics. The domain lives here, in the IR layer, because no consumer
 * owns the proof.
 *
 * The rest of this header describes the library obligation, which is the
 * older and stricter of the two; the native boundary is documented at the
 * bottom of the file.
 *
 * The two-layer model (the ask-4 reference package): Layer 1 represents
 * provably-integer local values as machine integers inside compiled code;
 * this module now publishes the conservative facts used by the JVM tier.
 * Layer 2 is the boundary: a profile declares
 * specific ABI slots i64/u64 (export/helper parameters and returns,
 * message-arm payloads, record fields), and every value that can reach a
 * declared slot must discharge, at compile time:
 *
 *   1. representability — an integer literal whose SOURCE SPELLING does
 *      not round-trip f64 refuses when it flows to an integer slot (the
 *      author wrote a number the program never held); numLit.spelling is
 *      the frontend's witness, carried only for non-round-tripping
 *      decimal integer spellings and dropped by any arithmetic.
 *   2. wholeness — the value is a mathematical integer on every path
 *      (never NaN, never fractional).
 *   3. range — the proven interval fits ±(2^53 − 1), the f64
 *      exact-integer bound (integrality beyond it is unprovable because
 *      adjacent integers stop being distinguishable); u64 additionally
 *      requires a non-negative lower bound.
 *
 * Never reinterpretation, never silent truncation, never a coercion the
 * author didn't write: a proven crossing is the mathematically exact
 * integer the f64 held. One consequence decided here: -0 is a whole
 * number (the f64 spelling of integer zero) — it crosses as 0, a PROVE.
 *
 * The abstract domain is an interval over the extended reals joined with
 * a wholeness flag, a may-be-NaN flag (NaN lives OUTSIDE the interval),
 * a may-be-negative-zero flag, and the literal spelling. Transfer functions implement JS semantics,
 * never idealized math: the bitwise operators' ToInt32/ToUint32 coercion
 * contract makes `x | 0` a PROOF (whole, int32 range, whatever x was —
 * NaN included); JS remainder's sign follows the dividend; the
 * Math.trunc/floor/ceil/round family discharges wholeness (not range,
 * not NaN). Branches refine BOTH compared values on BOTH edges — every
 * ordered comparison excludes NaN on its true edge, and wholeness
 * sharpens strict bounds (whole x < b ⇒ x ≤ ⌈b⌉ − 1, what lets an
 * ordinary counter loop prove a precise bound). Loop joins widen to a
 * short threshold list ONLY at loop headers, after a few plain joins;
 * precision lost to widening is recovered by the body-edge refinement,
 * so `for (let n = 0; n < 10; n = n + 1) send(n)` proves exactly [0, 9].
 * Static numeric field reads rooted at one binding carry the same guard
 * facts as locals through a straight-line dominated region, whether or
 * not the field is itself a declared integer slot. Those facts are proof
 * state only (the emitted program still performs every source read), and
 * are discarded at calls/suspensions, heap writes, receiver rebindings,
 * and control-flow joins. This is deliberately not alias analysis.
 *
 * INTERPROCEDURAL STRATEGY (v1, deliberate): intraprocedural with
 * declared-slot summaries at the boundaries. Every declared slot is both
 * an obligation and an assumption — a call ARGUMENT flowing into a
 * declared integer parameter is checked at the call site, and inside the
 * callee that parameter is SEEDED with its class's proven shape (whole,
 * class range: i64 ⇒ ±(2^53−1), u64 ⇒ [0, 2^53−1], the u8/u32/i32
 * plumbing classes their C ranges); a call RESULT of a declared integer
 * return is likewise assumed whole-in-range (its own function's returns
 * are checked). A declared RECORD FIELD works the same way: every write
 * into the field (construction or assignment, in any function) is
 * checked, and a read of the field is assumed whole-in-class-range —
 * which is what makes `count: model.count + 1` a RANGE refusal (the
 * unbounded counter may leave ±(2^53 − 1)) rather than a spurious
 * NaN complaint. External calls of the same slots are the wrapper's
 * business (inbound integer parameters range-check at the marshalled
 * edge — index.ts assembles the host-contract trap). Undeclared function
 * boundaries stay TOP — the obligations are the contract; the strategy
 * is free.
 *
 * The library obligation runs only for library builds whose profile
 * declares at least one integer slot. The native boundary runs only for
 * modules that declare a number parameter projection. A program with
 * neither pays for neither. */
import type {
  IrExpr,
  IrFunction,
  IrModule,
  IrNativeBinding,
  IrNativeStructDef,
  IrNumBinOp,
  IrStmt,
  IrType,
  SrcLoc,
} from "./nodes.js";
import { isFfiCallbackParam, moduleUsesRetainedCallbacks } from "./nodes.js";

/* ── the abstract domain ────────────────────────────────────────────────── */

export const SAFE_MAX = 2 ** 53 - 1; // Number.MAX_SAFE_INTEGER
export const SAFE_MIN = -SAFE_MAX;

/** The set of f64 values a binding may hold at a program point: a closed
 * interval over the extended reals (`-0` normalized to 0 because the
 * interval tracks mathematical value; its observable sign is carried
 * separately), `whole` when every member is a finite
 * integer-valued f64, `maybeNaN` when NaN may be in the set (NaN lives
 * outside the interval, which describes only the numeric members),
 * `maybeNegativeZero` when the set may contain the observably distinct
 * IEEE-754 value -0, and
 * the integer literal's source `spelling` for the representability check
 * (propagates through copies and agreeing joins only; any arithmetic
 * drops it — a computed value is a new number, not the author's
 * literal). */
export interface AbsVal {
  lo: number;
  hi: number;
  whole: boolean;
  maybeNaN: boolean;
  maybeNegativeZero: boolean;
  spelling?: string;
}

const normZero = (x: number): number => (Object.is(x, -0) ? 0 : x);

export function absVal(
  lo: number,
  hi: number,
  whole: boolean,
  maybeNaN: boolean,
  spelling?: string,
  maybeNegativeZero = false,
): AbsVal {
  lo = normZero(lo);
  hi = normZero(hi);
  // Infinities are not integers: a set with a non-finite bound may
  // contain them, so the wholeness claim drops.
  if (whole && !(Number.isFinite(lo) && Number.isFinite(hi))) whole = false;
  if (!(lo <= 0 && hi >= 0)) maybeNegativeZero = false;
  const v: AbsVal = { lo, hi, whole, maybeNaN, maybeNegativeZero };
  if (spelling !== undefined) v.spelling = spelling;
  return v;
}

/** Any f64 a caller could pass — unbounded, not whole, NaN included. */
export const TOP: AbsVal = {
  lo: -Infinity,
  hi: Infinity,
  whole: false,
  maybeNaN: true,
  maybeNegativeZero: true,
};
/** The empty set (unreachable): lo > hi and no NaN. */
export const BOTTOM: AbsVal = {
  lo: Infinity,
  hi: -Infinity,
  whole: true,
  maybeNaN: false,
  maybeNegativeZero: false,
};

export const isBottom = (v: AbsVal): boolean => v.lo > v.hi && !v.maybeNaN;
export const isSingleton = (v: AbsVal): boolean => v.lo === v.hi && !v.maybeNaN;
const hasNumeric = (v: AbsVal): boolean => v.lo <= v.hi;

export function constVal(value: number, spelling?: string): AbsVal {
  if (Number.isNaN(value)) {
    return {
      lo: Infinity,
      hi: -Infinity,
      whole: false,
      maybeNaN: true,
      maybeNegativeZero: false,
    };
  }
  return absVal(
    value,
    value,
    Number.isInteger(value),
    false,
    spelling,
    Object.is(value, -0),
  );
}

/** Least upper bound: interval hull, wholeness/NaN pessimism, spelling
 * kept only when both sides carry the same one. */
export function join(a: AbsVal, b: AbsVal): AbsVal {
  if (isBottom(a)) return b;
  if (isBottom(b)) return a;
  const numA = hasNumeric(a);
  const numB = hasNumeric(b);
  const lo = numA && numB ? Math.min(a.lo, b.lo) : numA ? a.lo : b.lo;
  const hi = numA && numB ? Math.max(a.hi, b.hi) : numA ? a.hi : b.hi;
  const whole = (numA ? a.whole : true) && (numB ? b.whole : true);
  const spelling = a.spelling !== undefined && a.spelling === b.spelling ? a.spelling : undefined;
  return absVal(
    lo,
    hi,
    whole,
    a.maybeNaN || b.maybeNaN,
    spelling,
    a.maybeNegativeZero || b.maybeNegativeZero,
  );
}

export function sameVal(a: AbsVal, b: AbsVal): boolean {
  return a.lo === b.lo && a.hi === b.hi && a.whole === b.whole &&
    a.maybeNaN === b.maybeNaN &&
    a.maybeNegativeZero === b.maybeNegativeZero &&
    a.spelling === b.spelling;
}

/* Threshold widening: when a loop-header join keeps growing, jump each
 * still-moving bound to the next threshold instead of crawling one
 * iteration at a time. The thresholds are the ranges the boundary check
 * cares about, so precision is lost only past the points where the
 * verdict would change anyway. */
const WIDEN_THRESHOLDS = [0, 2 ** 31 - 1, 2 ** 32 - 1, SAFE_MAX, Infinity];
const WIDEN_THRESHOLDS_NEG = [0, -(2 ** 31), SAFE_MIN, -Infinity];

export function widen(prev: AbsVal, next: AbsVal): AbsVal {
  if (isBottom(prev)) return next;
  let lo = next.lo;
  let hi = next.hi;
  if (next.lo < prev.lo) lo = WIDEN_THRESHOLDS_NEG.find((t) => t <= next.lo) ?? -Infinity;
  if (next.hi > prev.hi) hi = WIDEN_THRESHOLDS.find((t) => t >= next.hi) ?? Infinity;
  return absVal(
    lo,
    hi,
    next.whole,
    next.maybeNaN,
    next.spelling,
    next.maybeNegativeZero,
  );
}

/* ── transfer functions (JS semantics, never idealized math) ───────────── */

/* Endpoint product with the JS wrinkle 0 * Infinity = NaN handled for
 * BOUND purposes: as an interval bound the correct limit is 0 (the NaN is
 * the maybeNaN flag's business). */
function boundMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return a * b;
}

function transferAdd(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // Infinity + -Infinity = NaN: possible when opposite infinities meet.
  if ((a.hi === Infinity && b.lo === -Infinity) || (a.lo === -Infinity && b.hi === Infinity)) maybeNaN = true;
  return absVal(
    a.lo + b.lo,
    a.hi + b.hi,
    a.whole && b.whole,
    maybeNaN,
    undefined,
    a.maybeNegativeZero && b.maybeNegativeZero,
  );
}

function transferSub(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  if ((a.hi === Infinity && b.hi === Infinity) || (a.lo === -Infinity && b.lo === -Infinity)) maybeNaN = true;
  return absVal(
    a.lo - b.hi,
    a.hi - b.lo,
    a.whole && b.whole,
    maybeNaN,
    undefined,
    a.maybeNegativeZero && b.lo <= 0 && b.hi >= 0,
  );
}

function transferMul(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // 0 * Infinity = NaN: possible when one side may be 0 and the other infinite.
  const aHasZero = a.lo <= 0 && a.hi >= 0;
  const bHasZero = b.lo <= 0 && b.hi >= 0;
  const aInf = a.lo === -Infinity || a.hi === Infinity;
  const bInf = b.lo === -Infinity || b.hi === Infinity;
  if ((aHasZero && bInf) || (bHasZero && aInf)) maybeNaN = true;
  const p = [boundMul(a.lo, b.lo), boundMul(a.lo, b.hi), boundMul(a.hi, b.lo), boundMul(a.hi, b.hi)];
  const maybeNegativeZero =
    (aHasZero && b.lo < 0) ||
    (bHasZero && a.lo < 0) ||
    (a.maybeNegativeZero && b.hi > 0) ||
    (b.maybeNegativeZero && a.hi > 0);
  return absVal(
    Math.min(...p),
    Math.max(...p),
    a.whole && b.whole,
    maybeNaN,
    undefined,
    maybeNegativeZero,
  );
}

function transferDiv(a: AbsVal, b: AbsVal): AbsVal {
  const maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // Divisor exactly 0: x/0 is ±Infinity (sign by the dividend), 0/0 NaN.
  if (isSingleton(b) && b.lo === 0) {
    const nanPossible = maybeNaN || (a.lo <= 0 && a.hi >= 0);
    const lo = a.lo < 0 ? -Infinity : Infinity; // -Infinity reachable iff some dividend < 0
    const hi = a.hi > 0 ? Infinity : -Infinity; // +Infinity reachable iff some dividend > 0
    if (lo > hi) return { ...BOTTOM, maybeNaN: nanPossible }; // only 0/0: no numeric members
    return absVal(lo, hi, false, nanPossible);
  }
  // Divisor may be 0 among other values: give up on precision.
  if (b.lo <= 0 && b.hi >= 0) return { ...TOP };
  const q = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi];
  const lo = Math.min(...q);
  const hi = Math.max(...q);
  // Division does not preserve wholeness (7 / 2 = 3.5); the one provable
  // case is a singleton landing on an integer.
  return absVal(
    lo,
    hi,
    lo === hi && Number.isInteger(lo),
    maybeNaN,
    undefined,
    lo <= 0 && hi >= 0,
  );
}

function transferMod(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // x % 0 = NaN; Infinity % y = NaN.
  if (b.lo <= 0 && b.hi >= 0) maybeNaN = true;
  if (a.lo === -Infinity || a.hi === Infinity) maybeNaN = true;
  if (isSingleton(a) && isSingleton(b) && !maybeNaN) return constVal(a.lo % b.lo);
  // JS remainder: the sign follows the DIVIDEND; |r| < |divisor|.
  const dMax = Math.max(Math.abs(b.lo), Math.abs(b.hi));
  const bound = a.whole && b.whole && Number.isFinite(dMax) ? dMax - 1 : dMax;
  const lo = a.lo < 0 ? -bound : 0;
  const hi = a.hi > 0 ? bound : 0;
  return absVal(
    lo,
    hi,
    a.whole && b.whole,
    maybeNaN,
    undefined,
    a.maybeNegativeZero || a.lo < 0,
  );
}

function transferPow(a: AbsVal, b: AbsVal): AbsVal {
  const maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  if (isSingleton(a) && isSingleton(b) && !maybeNaN) return constVal(a.lo ** b.lo);
  // Provable without folding: whole base ≥ 1 with whole non-negative
  // exponent (pow is monotone in both arguments on that region).
  if (a.whole && b.whole && b.lo >= 0 && a.lo >= 1) {
    return absVal(a.lo ** b.lo, a.hi ** b.hi, true, maybeNaN);
  }
  // Anything else (negative bases, fractional exponents): NaN is
  // reachable ((-1) ** 0.5), so give up rather than enumerate corners.
  return { ...TOP };
}

/* The bitwise coercion contract, exactly: each operand passes through
 * ToInt32 (ToUint32 for >>>), which maps NaN and the infinities to 0 and
 * truncates-and-wraps everything else; shift counts mask to 5 bits. The
 * RESULT is therefore always whole and in int32 (uint32 for >>>) range
 * no matter what the inputs were — `x | 0` is a proof, not a hint. */
function transferBitwise(op: IrNumBinOp, a: AbsVal, b: AbsVal): AbsVal {
  if (isSingleton(a) && isSingleton(b)) {
    const x = a.lo;
    const y = b.lo;
    const r =
      op === "&" ? x & y :
      op === "|" ? x | y :
      op === "^" ? x ^ y :
      op === "<<" ? x << y :
      op === ">>" ? x >> y :
      x >>> y;
    return constVal(r);
  }
  /* AND with a known non-negative int32 mask cannot set a bit outside
   * that mask. This is a materially stronger range than the generic
   * ToInt32 result and is the ordinary source spelling for bounded hash,
   * table, and ring-buffer state (`value & 1023`). Bit-subset ordering is
   * numeric ordering for a non-negative mask, so every result is in
   * [0, mask] regardless of the other operand. */
  if (op === "&") {
    const mask = isSingleton(a) ? a.lo : isSingleton(b) ? b.lo : null;
    if (
      mask !== null &&
      Number.isInteger(mask) &&
      mask >= 0 &&
      mask <= MACHINE_I32_MAX
    ) {
      return absVal(0, mask, true, false);
    }
  }
  if (op === ">>>") return absVal(0, 2 ** 32 - 1, true, false);
  return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
}

/** JS `~`: ToInt32, complement — whole, int32 range, whatever the input. */
export function transferBitNot(a: AbsVal): AbsVal {
  if (isSingleton(a)) return constVal(~a.lo);
  return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
}

export function transferNeg(a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  return absVal(
    -a.hi,
    -a.lo,
    a.whole,
    a.maybeNaN,
    undefined,
    a.lo <= 0 && a.hi >= 0,
  );
}

export function transferBin(op: IrNumBinOp, a: AbsVal, b: AbsVal): AbsVal {
  switch (op) {
    case "+": return transferAdd(a, b);
    case "-": return transferSub(a, b);
    case "*": return transferMul(a, b);
    case "/": return transferDiv(a, b);
    case "%": return transferMod(a, b);
    case "**": return transferPow(a, b);
    case "&": case "|": case "^": case "<<": case ">>": case ">>>":
      return transferBitwise(op, a, b);
    default:
      // Comparisons produce bool, not a numeric abstract value.
      return { ...TOP };
  }
}

/** The Math rounding family is the author's stated intent: every finite
 * input maps to a whole output, so these discharge the WHOLENESS
 * obligation. They do not discharge range (an unbounded input stays
 * unbounded) or NaN (Math.trunc(NaN) is NaN — maybeNaN propagates). */
export function transferMathRound(fn: "trunc" | "floor" | "ceil" | "round", a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  const f = fn === "trunc" ? Math.trunc : fn === "floor" ? Math.floor : fn === "ceil" ? Math.ceil : Math.round;
  const lo = f(a.lo);
  const hi = f(a.hi);
  return absVal(
    lo,
    hi,
    true,
    a.maybeNaN,
    undefined,
    lo <= 0 && hi >= 0 && (a.lo < 0 || a.maybeNegativeZero),
  );
}

export function transferAbs(a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  const lo = a.lo <= 0 && a.hi >= 0 ? 0 : Math.min(Math.abs(a.lo), Math.abs(a.hi));
  return absVal(lo, Math.max(Math.abs(a.lo), Math.abs(a.hi)), a.whole, a.maybeNaN);
}

/** Math.min/max propagate NaN from ANY argument, exactly as JS does. */
export function transferMinMax(fn: "min" | "max", args: AbsVal[]): AbsVal {
  const maybeNaN = args.some((v) => v.maybeNaN);
  if (args.some((v) => !hasNumeric(v))) return { ...BOTTOM, maybeNaN };
  const lo = fn === "min" ? Math.min(...args.map((v) => v.lo)) : Math.max(...args.map((v) => v.lo));
  const hi = fn === "min" ? Math.min(...args.map((v) => v.hi)) : Math.max(...args.map((v) => v.hi));
  return absVal(
    lo,
    hi,
    args.every((v) => v.whole),
    maybeNaN,
    undefined,
    args.some((v) => v.maybeNegativeZero),
  );
}

/* ── the boundary check: PROVE or REFUSE ───────────────────────────────── */

export type IntClass = "i64" | "u64";
export type IntObligation = "representability" | "wholeness" | "range";

export interface IntVerdict {
  /** The sidecar slot path (`Msg.count`, `Point.x`,
   * `helpers.clamp.params[0]`, `exports.send.params[0]`). */
  path: string;
  cls: IntClass;
  loc: SrcLoc;
  outcome: "prove" | "refuse";
  /** PROVE: the proven crossing range (the exact crossing value when the
   * interval is a singleton); NaN/NaN for a vacuous (unreachable) proof. */
  provenLo?: number;
  provenHi?: number;
  /** REFUSE: the failed obligation (the FIRST failure in the §2.4 order),
   * the observed evidence, and the author's concrete fix. */
  obligation?: IntObligation;
  detail?: string;
  fix?: string;
}

/** Does an integer literal's source spelling survive the trip through
 * f64? Parse, convert, format back, compare (numeric separators were
 * stripped by the frontend — they are spelling sugar, not value). */
export function spellingRoundTrips(spelling: string): boolean {
  return String(Number(spelling)) === spelling;
}

/** Check a converged abstract value against a slot's obligations, in the
 * teaching-quality order: representability, then NaN, then range, then
 * fractional wholeness — the FIRST failure names the refusal (a value
 * both fractional and out of range hears about the more fundamental
 * problem). */
export function checkBoundary(v: AbsVal, path: string, cls: IntClass, loc: SrcLoc): IntVerdict {
  // Representability first: the author wrote a number the program never held.
  if (v.spelling !== undefined && !spellingRoundTrips(v.spelling)) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "representability",
      detail: `the literal ${v.spelling} is not representable as f64 — it reads back as ${Number(v.spelling)}`,
      fix: "write the nearest representable integer explicitly, or restructure so the value stays within ±(2^53 − 1)",
    };
  }
  if (isBottom(v)) {
    // The slot is unreachable on every path; vacuously proven.
    return { path, cls, loc, outcome: "prove", provenLo: NaN, provenHi: NaN };
  }
  if (v.maybeNaN) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "wholeness",
      detail: "the value may be NaN, which is not a whole number",
      fix: "guard the value with a comparison before the boundary (any ordered comparison excludes NaN), then state intent with Math.trunc/Math.floor/Math.ceil/Math.round if it may be fractional",
    };
  }
  const min = cls === "u64" ? 0 : SAFE_MIN;
  if (!(v.lo >= min && v.hi <= SAFE_MAX)) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "range",
      detail:
        `the proven range [${v.lo}, ${v.hi}] does not fit ${cls === "u64" ? `[0, ${SAFE_MAX}]` : `[${SAFE_MIN}, ${SAFE_MAX}]`} — integrality is provable only within ±(2^53 − 1)` +
        (cls === "u64" ? ", and a u64 slot additionally requires a non-negative proven range" : ""),
      fix: "bound the value before the boundary (clamp, compare, or restructure the computation to stay in range)",
    };
  }
  if (!v.whole) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "wholeness",
      detail: `the value is not provably whole — the proven range [${v.lo}, ${v.hi}] may contain non-integers`,
      fix: "state intent at the boundary with Math.trunc, Math.floor, Math.ceil, or Math.round",
    };
  }
  return { path, cls, loc, outcome: "prove", provenLo: v.lo, provenHi: v.hi };
}

/* ── slot configuration (what the profile declared, resolved to IR) ────── */

/** One function's declared integer slots: `params[i]` is the class of the
 * i-th parameter (null = not integer-declared), `ret` the return's.
 * `paramPaths`/`retPath` are the sidecar slot paths refusals carry. */
export interface FnIntSlots {
  fnName: string;
  params: (IntClass | null)[];
  paramPaths: (string | null)[];
  ret: IntClass | null;
  retPath: string | null;
  /** The plumbing classes of the NON-integer params (u8/u32/i32/f64/...):
   * used to seed the callee's parameter environment precisely. */
  paramSeeds: (AbsVal | null)[];
}

/** One lowered record-field obligation. Every program-side construction
 * (recordLit) or write (recordSet) of the field must discharge `cls` for
 * EVERY source contract path in `paths`. Shapes are interned STRUCTURALLY,
 * so same-shaped source slots with the same declared class coalesce here:
 * one proof fact, all attestation/diagnostic identities retained. */
export interface RecordIntSlot {
  cls: IntClass;
  paths: string[];
}

export interface IntSlotConfig {
  /** Keyed by IR function name. */
  fns: Map<string, FnIntSlots>;
  /** shapeId → field → slot. */
  records: Map<string, Map<string, RecordIntSlot>>;
}

/** The IR representations whose PRESENT values can carry one number slot.
 * A bare f64 is plain; a union of exactly one f64 arm and one or more
 * null/undefined arms is optional. The abstract interpreter tracks the
 * possible f64 arm values and treats unit arms as the empty numeric set. */
export function numberCarrierKind(t: IrType, mod: IrModule): "plain" | "optional" | null {
  if (t.kind === "f64") return "plain";
  if (t.kind !== "union") return null;
  const def = mod.unions?.find((u) => u.id === t.unionId);
  if (def === undefined) return null;
  let numbers = 0;
  let units = 0;
  for (const arm of def.arms) {
    if (arm.kind === "f64") numbers++;
    else if (arm.kind === "nullT" || arm.kind === "undefinedT") units++;
    else return null;
  }
  return numbers === 1 && units > 0 ? "optional" : null;
}

export function hasIntSlots(cfg: IntSlotConfig): boolean {
  if (cfg.records.size > 0) return true;
  for (const f of cfg.fns.values()) {
    if (f.ret !== null || f.params.some((p) => p !== null)) return true;
  }
  return false;
}

/** The class seed for a declared parameter: what the slot's own contract
 * proves about every value that ever arrives through it (internal calls
 * are checked at their call sites; external calls range-check in the
 * marshalling wrapper). */
export function classSeed(cls: string): AbsVal {
  switch (cls) {
    case "i64": return absVal(SAFE_MIN, SAFE_MAX, true, false);
    case "u64": return absVal(0, SAFE_MAX, true, false);
    case "u8": return absVal(0, 255, true, false);
    case "u32": return absVal(0, 2 ** 32 - 1, true, false);
    case "i32": return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
    default: return { ...TOP };
  }
}

/* ── the environment ───────────────────────────────────────────────────────
 * Abstract state per program point: binding/access key → AbsVal. Binding
 * keys cover f64-typed locals and module globals ("%g." ids); reserved path
 * keys carry temporary facts for static numeric fields. A missing LOCAL is
 * bottom (not yet bound on this path — tsc's definite-assignment analysis
 * guarantees no read precedes a binding); a missing GLOBAL or ordinary
 * field path is TOP (any value, including NaN). `null` in place of an Env
 * is unreachable. */

type Env = Map<string, AbsVal>;

/** Static-access facts share Env's join/clone machinery but have their own
 * missing-key value: TOP for an ordinary numeric field, or the declared
 * slot seed for a declared integer field. A killed declared-field fact
 * therefore falls back to the same whole-in-class-range assumption its read
 * had before access-path refinement, preserving SC4023 rather than
 * degrading to a spurious SC4022. */
const PATH_TOP_PREFIX = "%path.top:";
const PATH_I64_PREFIX = "%path.i64:";
const PATH_U64_PREFIX = "%path.u64:";

type PathSeed = IntClass | "top";

function pathSeedOfKey(id: string): PathSeed | null {
  if (id.startsWith(PATH_TOP_PREFIX)) return "top";
  if (id.startsWith(PATH_I64_PREFIX)) return "i64";
  if (id.startsWith(PATH_U64_PREFIX)) return "u64";
  return null;
}

function clearPathFacts(env: Env): void {
  for (const k of [...env.keys()]) {
    if (pathSeedOfKey(k) !== null) env.delete(k);
  }
}

const isGlobalId = (id: string): boolean => id.startsWith("%g.");
const defaultVal = (id: string): AbsVal => {
  const pathSeed = pathSeedOfKey(id);
  if (pathSeed !== null) return pathSeed === "top" ? { ...TOP } : classSeed(pathSeed);
  return isGlobalId(id) ? TOP : BOTTOM;
};

function envGet(env: Env, id: string): AbsVal {
  return env.get(id) ?? defaultVal(id);
}

function joinEnv(a: Env | null, b: Env | null): Env | null {
  if (a === null) return b === null ? null : new Map(b);
  if (b === null) return new Map(a);
  const out: Env = new Map();
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    out.set(k, join(a.get(k) ?? defaultVal(k), b.get(k) ?? defaultVal(k)));
  }
  // A real flow join ends the cheap straight-line access-path proof even
  // when both incoming facts happen to agree. A sole reachable edge
  // (early return/throw on the other edge) retains its dominated fact.
  clearPathFacts(out);
  return out;
}

function envEquals(a: Env, b: Env): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if (!sameVal(a.get(k) ?? defaultVal(k), b.get(k) ?? defaultVal(k))) return false;
  }
  return true;
}

function widenEnv(prev: Env, next: Env): Env {
  const out: Env = new Map();
  const keys = new Set([...prev.keys(), ...next.keys()]);
  for (const k of keys) {
    out.set(k, widen(prev.get(k) ?? defaultVal(k), next.get(k) ?? defaultVal(k)));
  }
  clearPathFacts(out);
  return out;
}

/* ── which globals may a call mutate? ──────────────────────────────────────
 * A per-function transitive summary of written global ids, so a direct
 * call havocs exactly what its callee (and everything IT calls) can
 * write. Indirect calls — through function values, class methods,
 * dynamic machinery, or a libCall that receives a function argument (the
 * runtime may invoke it) — havoc everything. */

interface GlobalEffects {
  perFn: Map<string, Set<string>>;
  havocAll: Set<string>;
}

function globalEffectsOf(mod: IrModule): GlobalEffects {
  const writes = new Map<string, Set<string>>();
  const calls = new Map<string, Set<string>>();
  const unknown = new Set<string>();

  const typeHasFunc = (t: { kind: string }): boolean => JSON.stringify(t).includes('"func"');

  for (const fn of mod.functions) {
    const w = new Set<string>();
    const c = new Set<string>();
    let u = false;
    const visitExpr = (e: IrExpr): void => {
      switch (e.kind) {
        case "assignExpr":
          if (isGlobalId(e.localId)) w.add(e.localId);
          visitExpr(e.value);
          return;
        case "incDec":
          if (isGlobalId(e.localId)) w.add(e.localId);
          return;
        case "call":
          c.add(e.callee);
          e.args.forEach(visitExpr);
          return;
        case "callValue":
        case "newValue":
        case "dynCall":
        case "dynInvoke":
        case "virtualCall":
        case "new":
        case "intrinsic":
          u = true;
          break;
        case "libCall":
          if (e.args.some((a) => typeHasFunc(a.type))) u = true;
          break;
        case "seqExpr":
          e.stmts.forEach(visitStmt);
          visitExpr(e.result);
          return;
        default:
          break;
      }
      for (const key of Object.keys(e) as (keyof typeof e)[]) {
        const v = e[key] as unknown;
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && "kind" in (item as object)) {
              const it = item as { kind: unknown };
              if (typeof it.kind === "string") visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              // field-shaped entries ({ name, value } etc.)
              for (const sub of Object.values(item as object)) {
                if (sub !== null && typeof sub === "object" && typeof (sub as { kind?: unknown }).kind === "string") {
                  visitExpr(sub as IrExpr);
                }
              }
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && key !== "type") {
          visitExpr(v as IrExpr);
        }
      }
    };
    const visitStmt = (s: IrStmt): void => {
      switch (s.kind) {
        case "assign":
          if (isGlobalId(s.localId)) w.add(s.localId);
          visitExpr(s.value);
          return;
        case "varDecl":
          if (s.init !== null) visitExpr(s.init);
          return;
        default:
          break;
      }
      for (const v of Object.values(s) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              const node = item as { kind: string };
              if (isStmtKind(node.kind)) visitStmt(item as IrStmt);
              else visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              // switch cases: { test, body }
              const cs = item as { test?: IrExpr | null; body?: IrStmt[] };
              if (cs.test !== undefined && cs.test !== null) visitExpr(cs.test);
              if (Array.isArray(cs.body)) cs.body.forEach(visitStmt);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          const node = v as { kind: string };
          if (isStmtKind(node.kind)) visitStmt(v as IrStmt);
          else visitExpr(v as IrExpr);
        }
      }
    };
    fn.body.forEach(visitStmt);
    writes.set(fn.name, w);
    calls.set(fn.name, c);
    if (u) unknown.add(fn.name);
  }

  // Transitive closure over the direct-call graph.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, callees] of calls) {
      const w = writes.get(name)!;
      for (const callee of callees) {
        if (unknown.has(callee) && !unknown.has(name)) {
          unknown.add(name);
          changed = true;
        }
        for (const g of writes.get(callee) ?? []) {
          if (!w.has(g)) {
            w.add(g);
            changed = true;
          }
        }
      }
    }
  }
  return { perFn: writes, havocAll: unknown };
}

const STMT_KINDS = new Set([
  "varDecl", "assign", "exprStmt", "if", "while", "doWhile", "switch", "for",
  "arraySet", "bytesSet", "forOf", "return", "fieldSet", "recordSet",
  "recordKeySet", "recordKeyDelete", "break", "continue", "block", "throw",
  "runtimeFence", "rethrow", "tryCatch",
]);
const isStmtKind = (k: string): boolean => STMT_KINDS.has(k);

/* ── the analyzer ──────────────────────────────────────────────────────── */

const WIDEN_AFTER = 3; // plain joins at a loop header before widening
const LOOP_CAP = 64; // hard bound; thresholds converge far earlier

interface LoopFrame {
  kind: "loop" | "switch" | "block";
  labels: string[];
  breaks: (Env | null)[];
  continues: (Env | null)[];
}

const NEGATE: Record<string, string> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===" };
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" };
const CMP_OPS = new Set(["<", "<=", ">", ">=", "===", "!=="]);
const ORDERED_CMP_OPS = new Set(["<", "<=", ">", ">="]);

const MACHINE_I32_MIN = -(2 ** 31);
const MACHINE_I32_MAX = 2 ** 31 - 1;

function isMachineI32(v: AbsVal): boolean {
  return isBottom(v) || (
    v.whole &&
    !v.maybeNaN &&
    !v.maybeNegativeZero &&
    v.lo >= MACHINE_I32_MIN &&
    v.hi <= MACHINE_I32_MAX
  );
}

interface MachineIntegerObserver {
  recordExpression(expr: IrExpr, value: AbsVal): void;
  recordReturn(value: AbsVal): void;
  recordWrite(localId: string, value: AbsVal): void;
}

class FunctionMachineIntegerObserver implements MachineIntegerObserver {
  readonly #eligible: ReadonlySet<string>;
  readonly #returnEligible: boolean;
  readonly #seen = new Set<string>();
  readonly #unsafe = new Set<string>();
  readonly #expressions = new Map<IrExpr, AbsVal>();
  #returnSeen = false;
  #returnValue: AbsVal = BOTTOM;

  constructor(fn: IrFunction) {
    this.#returnEligible = fn.returnType.kind === "f64";
    const parameters = new Set(fn.params.map((parameter) => parameter.localId));
    this.#eligible = new Set(
      fn.locals
        .filter((local) =>
          local.type.kind === "f64" &&
          local.boxed !== true &&
          local.nativeFrame === undefined &&
          !parameters.has(local.id)
        )
        .map((local) => local.id),
    );
  }

  recordExpression(expr: IrExpr, value: AbsVal): void {
    if (expr.type.kind !== "f64") return;
    this.#expressions.set(
      expr,
      join(this.#expressions.get(expr) ?? BOTTOM, value),
    );
  }

  recordReturn(value: AbsVal): void {
    if (!this.#returnEligible) return;
    this.#returnSeen = true;
    this.#returnValue = join(this.#returnValue, value);
  }

  recordWrite(localId: string, value: AbsVal): void {
    if (!this.#eligible.has(localId)) return;
    this.#seen.add(localId);
    if (!isMachineI32(value)) this.#unsafe.add(localId);
  }

  locals(): ReadonlySet<string> {
    return new Set(
      [...this.#eligible].filter((localId) =>
        this.#seen.has(localId) && !this.#unsafe.has(localId)
      ),
    );
  }

  expressions(): readonly IrExpr[] {
    return [...this.#expressions]
      .filter(([, value]) => isMachineI32(value))
      .map(([expr]) => expr);
  }

  expressionValues(): ReadonlyMap<IrExpr, AbsVal> {
    return new Map(this.#expressions);
  }

  returnsMachineInteger(): boolean {
    return this.#returnEligible && this.#returnSeen && isMachineI32(this.#returnValue);
  }

  returnValue(): AbsVal {
    return this.#returnSeen ? this.#returnValue : { ...TOP };
  }
}

interface MachineIntegerAssumptions {
  readonly fields: ReadonlyMap<string, AbsVal>;
  readonly parameters: ReadonlyMap<string, AbsVal>;
  readonly methods: ReadonlySet<string>;
  readonly methodValues: ReadonlyMap<string, AbsVal>;
  readonly returns: ReadonlySet<string>;
  readonly returnValues: ReadonlyMap<string, AbsVal>;
  readonly representation: MachineIntegerRepresentation;
}

/** Target representation facts that are stronger than the language-level
 * container contract. They are opt-in because a generic ScriptC array may
 * grow beyond signed int32 even when a target's physical array cannot. */
export interface MachineIntegerRepresentation {
  readonly arrayLength?: "int32";
}

const GENERIC_MACHINE_INTEGER_REPRESENTATION: MachineIntegerRepresentation =
  Object.freeze({});

const EMPTY_MACHINE_INTEGER_ASSUMPTIONS: MachineIntegerAssumptions = {
  fields: new Map(),
  parameters: new Map(),
  methods: new Set(),
  methodValues: new Map(),
  returns: new Set(),
  returnValues: new Map(),
  representation: GENERIC_MACHINE_INTEGER_REPRESENTATION,
};

/** Meet a value with an interval; `clearNaN` when the comparison's truth
 * on this edge excludes NaN operands. */
function meetInterval(v: AbsVal, lo: number, hi: number, clearNaN: boolean): AbsVal {
  const newLo = Math.max(v.lo, lo);
  const newHi = Math.min(v.hi, hi);
  if (newLo > newHi) {
    // No numeric member survives this edge; NaN may still flow through.
    return { ...BOTTOM, maybeNaN: clearNaN ? false : v.maybeNaN };
  }
  return absVal(
    newLo,
    newHi,
    v.whole,
    clearNaN ? false : v.maybeNaN,
    v.spelling,
    v.maybeNegativeZero,
  );
}

/** Refine `a` under the assumption `a OP b` held. Wholeness sharpens the
 * strict bounds: whole x < b ⇒ x ≤ ⌈b.hi⌉ − 1 — the rule that lets the
 * ordinary counter loop prove a precise bound. */
function refineLhs(op: string, a: AbsVal, b: AbsVal, clearNaN: boolean): AbsVal {
  if (!hasNumeric(b) || !hasNumeric(a)) return clearNaN ? { ...a, maybeNaN: false } : a;
  // On a failed ordered comparison, a NaN in `b` satisfies the failed edge
  // regardless of `a`'s numeric value. Preserve every numeric member of `a`
  // in that case; the caller applies the same rule in the other direction.
  if (!clearNaN && b.maybeNaN && ORDERED_CMP_OPS.has(op)) return a;
  switch (op) {
    case "<":
      return meetInterval(a, -Infinity, a.whole ? Math.ceil(b.hi) - 1 : b.hi, clearNaN);
    case "<=":
      return meetInterval(a, -Infinity, a.whole ? Math.floor(b.hi) : b.hi, clearNaN);
    case ">":
      return meetInterval(a, a.whole ? Math.floor(b.lo) + 1 : b.lo, Infinity, clearNaN);
    case ">=":
      return meetInterval(a, a.whole ? Math.ceil(b.lo) : b.lo, Infinity, clearNaN);
    case "===":
      return meetInterval(a, b.lo, b.hi, clearNaN);
    case "!==": {
      // Only endpoint exclusion is useful: whole x !== integer singleton k
      // sitting on an endpoint of x's interval.
      if (isSingleton(b) && a.whole && Number.isInteger(b.lo)) {
        if (a.lo === b.lo) return meetInterval(a, a.lo + 1, a.hi, clearNaN);
        if (a.hi === b.lo) return meetInterval(a, a.lo, a.hi - 1, clearNaN);
      }
      return clearNaN ? { ...a, maybeNaN: false } : a;
    }
    default:
      return a;
  }
}

class FnAnalyzer {
  private frames: LoopFrame[] = [];
  private collect = false;
  /** Return-site abstract values (for the declared-return check). */
  constructor(
    private readonly mod: IrModule,
    private readonly cfg: IntSlotConfig,
    private readonly effects: GlobalEffects,
    private readonly verdicts: IntVerdict[],
    private readonly native: NativeBoundaryContext | null = null,
    private readonly globalSeeds: ReadonlyMap<string, AbsVal> = new Map(),
    private readonly machine: MachineIntegerObserver | null = null,
    private readonly machineAssumptions: MachineIntegerAssumptions =
      EMPTY_MACHINE_INTEGER_ASSUMPTIONS,
  ) {}

  analyze(fn: IrFunction): void {
    const env: Env = new Map();
    for (const [globalId, value] of this.globalSeeds) {
      env.set(globalId, { ...value });
    }
    const slots = this.cfg.fns.get(fn.name);
    const nativeSeeds = this.native?.callbackSeeds.get(fn.name);
    fn.params.forEach((p, i) => {
      if (!this.bindingCarriesNumber(p.localId)) return;
      const declared = slots?.params[i] ?? null;
      const seed = slots?.paramSeeds[i] ?? null;
      const nativeSeed = nativeSeeds?.[i] ?? null;
      const machineSeed = this.machineAssumptions.parameters.get(
        machineIntegerParameterKey(fn.name, i),
      );
      if (declared !== null) env.set(p.localId, classSeed(declared));
      else if (seed !== null) env.set(p.localId, { ...seed });
      else if (nativeSeed !== null) env.set(p.localId, { ...nativeSeed });
      else if (machineSeed !== undefined) env.set(p.localId, { ...machineSeed });
      else env.set(p.localId, { ...TOP });
    });
    this.collect = true;
    this.retSlot = slots !== undefined && slots.ret !== null ? { cls: slots.ret, path: slots.retPath! } : null;
    this.execStmts(fn.body, env);
  }

  private retSlot: { cls: IntClass; path: string } | null = null;

  private emit(v: AbsVal, path: string, cls: IntClass, loc: SrcLoc): void {
    if (!this.collect) return;
    this.verdicts.push(checkBoundary(v, path, cls, loc));
  }

  /** One lowered write can conservatively cover several same-class source
   * contract slots. Check once per path so every attestation identity
   * survives into a refusal instead of inheriting the first declarer's
   * label. */
  private emitRecordSlot(v: AbsVal, slot: RecordIntSlot, loc: SrcLoc): void {
    for (const path of slot.paths) this.emit(v, path, slot.cls, loc);
  }

  /* ── statements ─────────────────────────────────────────────────────── */

  private execStmts(stmts: IrStmt[], env: Env | null): Env | null {
    for (const s of stmts) {
      if (env === null) return null; // unreachable remainder
      env = this.execStmt(s, env);
    }
    return env;
  }

  private execStmt(s: IrStmt, env: Env): Env | null {
    switch (s.kind) {
      case "varDecl": {
        if (s.init === null) return env;
        const v = this.evalExpr(s.init, env);
        if (this.collect) this.machine?.recordWrite(s.localId, v);
        this.clearPathsRootedAt(env, s.localId);
        if (this.bindingCarriesNumber(s.localId)) env.set(s.localId, v);
        return env;
      }
      case "assign": {
        const v = this.evalExpr(s.value, env);
        if (this.collect) this.machine?.recordWrite(s.localId, v);
        this.clearPathsRootedAt(env, s.localId);
        if (this.bindingCarriesNumber(s.localId)) env.set(s.localId, v);
        return env;
      }
      case "exprStmt":
        this.evalExpr(s.expr, env);
        return env;
      case "if": {
        this.evalExpr(s.cond, env);
        const allowPaths = this.stablePathGuard(s.cond);
        const thenEnv = this.refine(cloneEnv(env), s.cond, true, allowPaths);
        const elseEnv = this.refine(cloneEnv(env), s.cond, false, allowPaths);
        const a = thenEnv === null ? null : this.execStmts(s.then, thenEnv);
        const b = s.else_ === null ? elseEnv : elseEnv === null ? null : this.execStmts(s.else_, elseEnv);
        return joinEnv(a, b);
      }
      case "while":
        return this.execLoop(env, { cond: s.cond, body: s.body, labels: s.labels ?? [] });
      case "for": {
        let e: Env | null = env;
        if (s.init !== null) e = this.execStmt(s.init, e);
        if (e === null) return null;
        return this.execLoop(e, {
          ...(s.cond !== null ? { cond: s.cond } : {}),
          body: s.body,
          ...(s.update !== null ? { update: s.update } : {}),
          labels: s.labels ?? [],
        });
      }
      case "doWhile":
        return this.execLoop(env, { cond: s.cond, body: s.body, labels: s.labels ?? [], doWhile: true });
      case "forOf": {
        this.evalExpr(s.iterable, env);
        if (this.collect) this.machine?.recordWrite(s.localId, TOP);
        const elemF64 = this.bindingCarriesNumber(s.localId);
        return this.execLoop(env, {
          body: s.body,
          labels: s.labels ?? [],
          alwaysExits: true, // the iteration ends when the array runs out
          ...(elemF64 ? { seedEachIteration: s.localId } : {}),
        });
      }
      case "switch": {
        this.evalExpr(s.disc, env);
        const frame: LoopFrame = { kind: "switch", labels: s.labels ?? [], breaks: [], continues: [] };
        this.frames.push(frame);
        let running: Env | null = null; // the fallthrough path
        let hasDefault = false;
        try {
          for (const c of s.cases) {
            if (c.test === null) hasDefault = true;
            else this.evalExpr(c.test, env);
            running = this.execStmts(c.body, joinEnv(running, cloneEnv(env)));
          }
        } finally {
          this.frames.pop();
        }
        let out = running;
        for (const b of frame.breaks) out = joinEnv(out, b);
        // Without a default (or with tests that all miss) control skips past.
        if (!hasDefault) out = joinEnv(out, env);
        return out;
      }
      case "arraySet":
      case "bytesSet":
        this.evalExpr(s.arr, env);
        this.evalExpr(s.index, env);
        this.evalExpr(s.value, env);
        clearPathFacts(env);
        return env;
      case "fieldSet":
        this.evalExpr(s.obj, env);
        this.evalExpr(s.value, env);
        clearPathFacts(env);
        return env;
      case "nativePeerDetach":
        this.evalExpr(s.handle, env);
        this.havocAllGlobals(env);
        clearPathFacts(env);
        return env;
      case "recordSet": {
        this.evalExpr(s.obj, env);
        const v = this.evalExpr(s.value, env);
        const slot = this.cfg.records.get(s.shapeId)?.get(s.field);
        if (slot !== undefined) this.emitRecordSlot(v, slot, s.loc);
        // The RHS and its boundary obligation observe the pre-write value;
        // only the completed heap write invalidates paths (JS evaluation
        // order, and what lets `m.count = m.count + 1` prove).
        clearPathFacts(env);
        return env;
      }
      case "recordKeySet": {
        this.evalExpr(s.obj, env);
        this.evalExpr(s.key, env);
        const v = this.evalExpr(s.value, env);
        // A runtime key can dispatch to any declared field of the shape.
        // overflowOnly proves a literal key names no declared field; every
        // other keyed write must therefore discharge every integer slot it
        // could select. Multiple classified fields intentionally emit
        // independent obligations (their classes and paths may differ).
        if (s.overflowOnly !== true) {
          for (const slot of this.cfg.records.get(s.shapeId)?.values() ?? []) {
            this.emitRecordSlot(v, slot, s.loc);
          }
        }
        clearPathFacts(env);
        return env;
      }
      case "recordKeyDelete":
        this.evalExpr(s.obj, env);
        this.evalExpr(s.key, env);
        clearPathFacts(env);
        return env;
      case "return": {
        if (s.value !== null) {
          const v = this.evalExpr(s.value, env);
          if (this.collect) this.machine?.recordReturn(v);
          if (this.retSlot !== null) this.emit(v, this.retSlot.path, this.retSlot.cls, s.loc);
        }
        return null;
      }
      case "throw":
        this.evalExpr(s.value, env);
        return null;
      case "rethrow":
      case "runtimeFence":
        return null;
      case "break": {
        const frame = this.jumpTarget(s.label, "break");
        if (frame !== null) frame.breaks.push(cloneEnv(env));
        return null;
      }
      case "continue": {
        const frame = this.jumpTarget(s.label, "continue");
        if (frame !== null) frame.continues.push(cloneEnv(env));
        return null;
      }
      case "block": {
        if ((s.labels ?? []).length === 0) return this.execStmts(s.body, env);
        const frame: LoopFrame = { kind: "block", labels: s.labels!, breaks: [], continues: [] };
        this.frames.push(frame);
        let out: Env | null;
        try {
          out = this.execStmts(s.body, env);
        } finally {
          this.frames.pop();
        }
        for (const b of frame.breaks) out = joinEnv(out, b);
        return out;
      }
      case "tryCatch": {
        const entry = cloneEnv(env);
        const afterTry = this.execStmts(s.tryBody, env);
        let afterCatch: Env | null = null;
        if (s.catchBody !== null) {
          // The exception may have unwound from ANY point of the try
          // body: every binding the try can write (and every global —
          // a callee may have mutated some before throwing) is unknown.
          afterCatch = this.execStmts(s.catchBody, this.havocForCatch(entry, s.tryBody));
        }
        let out = joinEnv(afterTry, afterCatch);
        if (s.finallyBody !== null) {
          // The finally also runs on the pending-exception and
          // pending-return paths; obligations inside it must hold there
          // too, so it executes over the havoc-joined state.
          out = this.execStmts(s.finallyBody, joinEnv(out, this.havocForCatch(entry, s.tryBody)) ?? this.havocForCatch(entry, s.tryBody));
        }
        return out;
      }
    }
  }

  private jumpTarget(label: string | undefined, kind: "break" | "continue"): LoopFrame | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (label !== undefined) {
        if (f.labels.includes(label) && (kind === "break" || f.kind === "loop")) return f;
        continue;
      }
      if (kind === "break" && (f.kind === "loop" || f.kind === "switch")) return f;
      if (kind === "continue" && f.kind === "loop") return f;
    }
    return null;
  }

  private havocForCatch(entry: Env, tryBody: IrStmt[]): Env {
    const out = cloneEnv(entry);
    const assigned = new Set<string>();
    const visitStmt = (s: IrStmt): void => {
      if (s.kind === "assign" || s.kind === "varDecl") assigned.add(s.localId);
      for (const v of Object.values(s) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              const node = item as { kind: string };
              if (isStmtKind(node.kind)) visitStmt(item as IrStmt);
              else visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              const cs = item as { body?: IrStmt[] };
              if (Array.isArray(cs.body)) cs.body.forEach(visitStmt);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          const node = v as { kind: string };
          if (isStmtKind(node.kind)) visitStmt(v as IrStmt);
          else visitExpr(v as IrExpr);
        }
      }
    };
    const visitExpr = (e: IrExpr): void => {
      if (e.kind === "assignExpr" || e.kind === "incDec") assigned.add(e.localId);
      if (e.kind === "seqExpr") e.stmts.forEach(visitStmt);
      for (const v of Object.values(e) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              visitExpr(item as IrExpr);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          visitExpr(v as IrExpr);
        }
      }
    };
    tryBody.forEach(visitStmt);
    for (const id of assigned) {
      if (this.bindingCarriesNumber(id)) out.set(id, { ...TOP });
    }
    // Globals: any callee may have written before the throw.
    for (const k of [...out.keys()]) {
      if (isGlobalId(k)) out.delete(k); // absent global = TOP
    }
    clearPathFacts(out);
    return out;
  }

  /* ── loops: header widening + body-edge refinement ──────────────────── */

  private execLoop(
    env: Env,
    opts: {
      cond?: IrExpr;
      body: IrStmt[];
      update?: IrStmt;
      labels: string[];
      doWhile?: boolean;
      seedEachIteration?: string;
      alwaysExits?: boolean;
    },
  ): Env | null {
    // Loop headers/backedges are outside the deliberately straight-line
    // access-path scope. Guards inside the body can establish fresh facts.
    clearPathFacts(env);
    const savedCollect = this.collect;
    this.collect = false;
    let head = cloneEnv(env);
    let joins = 0;
    // Phase 1: fixpoint (collect off). `head` is the state at the loop
    // header (the condition's evaluation point; for do-while, the body's
    // entry). Widening applies ONLY here — an acyclic join converges by
    // itself and keeps its precision; precision the header loses is
    // recovered by the body-edge refinement below.
    for (let iter = 0; iter < LOOP_CAP; iter++) {
      const trip = this.runLoopBodyOnce(head, opts);
      let next = joinEnv(head, trip.back)!;
      joins++;
      if (joins > WIDEN_AFTER) next = widenEnv(head, next);
      if (envEquals(head, next)) break;
      head = next;
      if (iter === LOOP_CAP - 1) {
        // Safety net (the thresholds converge long before this): give up
        // on precision rather than loop.
        for (const k of [...head.keys()]) head.set(k, { ...TOP });
      }
    }
    // Phase 2: one collect pass over the stabilized header state — the
    // pass that emits verdicts sees the loop-body edge's refined values
    // (the header may have widened to [0, 2^31−1]; the body sees n < 10
    // and proves [0, 9]).
    this.collect = savedCollect;
    const frame: LoopFrame = { kind: "loop", labels: opts.labels, breaks: [], continues: [] };
    const final = this.runLoopBodyOnce(head, opts, frame);
    // The exit state: the condition's false edge (evaluated at the
    // header for while/for, after the body for do-while), joined with
    // every break's state. A condition-free, non-iterating loop
    // (`for (;;)`) exits only through breaks.
    let exit: Env | null = null;
    if (opts.doWhile ?? false) {
      exit = opts.cond !== undefined && final.postBody !== null ? this.refine(final.postBody, opts.cond, false, false) : null;
    } else if (opts.cond !== undefined) {
      exit = this.refine(cloneEnv(head), opts.cond, false, false);
    } else if (opts.alwaysExits ?? false) {
      exit = cloneEnv(head); // for-of ends when the array runs out
    }
    for (const b of frame.breaks) exit = joinEnv(exit, b);
    return exit;
  }

  /** One trip around the loop from the header state: refine by the
   * condition's true edge (unless do-while, whose condition sits after
   * the body), execute the body, fold continues, run the update, and for
   * do-while apply the condition's true edge to form the back edge.
   * `back` is the back-edge environment (null when the body never reaches
   * it); `postBody` is the do-while exit candidate — the state at the
   * condition, before its verdict. */
  private runLoopBodyOnce(
    head: Env,
    opts: { cond?: IrExpr; body: IrStmt[]; update?: IrStmt; labels: string[]; doWhile?: boolean; seedEachIteration?: string; alwaysExits?: boolean },
    frame?: LoopFrame,
  ): { back: Env | null; postBody: Env | null } {
    const f: LoopFrame = frame ?? { kind: "loop", labels: opts.labels, breaks: [], continues: [] };
    let bodyIn: Env | null = cloneEnv(head);
    if (opts.cond !== undefined && !(opts.doWhile ?? false)) {
      this.evalExpr(opts.cond, bodyIn);
      bodyIn = this.refine(bodyIn, opts.cond, true, false);
    }
    if (bodyIn !== null && opts.seedEachIteration !== undefined) {
      bodyIn.set(opts.seedEachIteration, { ...TOP });
    }
    this.frames.push(f);
    let out: Env | null;
    try {
      out = bodyIn === null ? null : this.execStmts(opts.body, bodyIn);
    } finally {
      this.frames.pop();
    }
    for (const c of f.continues) out = joinEnv(out, c);
    if (opts.update !== undefined && out !== null) out = this.execStmt(opts.update, out);
    let postBody: Env | null = null;
    if ((opts.doWhile ?? false) && opts.cond !== undefined && out !== null) {
      this.evalExpr(opts.cond, out);
      postBody = cloneEnv(out);
      out = this.refine(out, opts.cond, true, false);
    }
    return { back: out, postBody };
  }

  /* ── branch refinement ──────────────────────────────────────────────── */

  /** Refine an environment under `cond === branch`. Returns null when the
   * edge is impossible. Every ordered comparison (and ===) evaluates
   * false when either side is NaN, so the edge where one HELD proves both
   * operands NaN-free; on the failed edge NaN survives while the negated
   * comparison still refines the numeric members. */
  private refine(env: Env | null, cond: IrExpr, branch: boolean, allowPaths = false): Env | null {
    if (env === null) return null;
    switch (cond.kind) {
      case "boolLit":
        return cond.value === branch ? env : null;
      case "unary":
        if (cond.op === "!") return this.refine(env, cond.operand, !branch, allowPaths);
        return env;
      case "logical": {
        const isAnd = cond.op === "&&";
        if (isAnd === branch) {
          // (a && b) true  — both held; (a || b) false — both failed.
          return this.refine(this.refine(env, cond.left, branch, allowPaths), cond.right, branch, allowPaths);
        }
        // (a && b) false — a failed, or a held and b failed; dually for ||.
        const viaLeft = this.refine(cloneEnv(env), cond.left, branch, allowPaths);
        const viaRight = this.refine(
          this.refine(cloneEnv(env), cond.left, !branch, allowPaths),
          cond.right,
          branch,
          allowPaths,
        );
        return joinEnv(viaLeft, viaRight);
      }
      case "unionIsTag": {
        const unionType: IrType = { kind: "union", unionId: cond.unionId };
        if (numberCarrierKind(unionType, this.mod) !== "optional") return env;
        const def = this.mod.unions?.find((u) => u.id === cond.unionId);
        const arm = def?.arms[cond.tag];
        const key = this.refinementKey(cond.value, allowPaths);
        if (arm === undefined || key === null) return env;
        const tagMatches = cond.negated ? !branch : branch;
        // The abstract value describes only PRESENT f64 inhabitants. A
        // branch selecting a unit arm has no numeric inhabitants; likewise
        // a branch excluding the optional carrier's sole f64 arm.
        if ((tagMatches && arm.kind !== "f64") || (!tagMatches && arm.kind === "f64")) {
          const out = cloneEnv(env);
          out.set(key, { ...BOTTOM });
          return out;
        }
        return env;
      }
      case "bin": {
        if (!CMP_OPS.has(cond.op)) return env;
        if (cond.left.type.kind !== "f64" || cond.right.type.kind !== "f64") return env;
        if (!this.isPure(cond.left) || !this.isPure(cond.right)) return env;
        const op = branch ? cond.op : NEGATE[cond.op]!;
        // NaN makes < <= > >= === evaluate false, so the edge where one of
        // those was TRUE proves both operands NaN-free (!== held excludes
        // nothing — NaN !== x is true).
        const clearNaN = branch ? cond.op !== "!==" : cond.op === "!==";
        const a = this.evalPure(cond.left, env);
        const b = this.evalPure(cond.right, env);
        const out = cloneEnv(env);
        const leftKey = this.refinementKey(cond.left, allowPaths);
        const rightKey = this.refinementKey(cond.right, allowPaths);
        if (leftKey !== null) out.set(leftKey, refineLhs(op, a, b, clearNaN));
        if (rightKey !== null) out.set(rightKey, refineLhs(FLIP[op]!, b, a, clearNaN));
        return out;
      }
      case "toBool": {
        const inner = cond.operand;
        if (inner.type.kind !== "f64" || !this.isPure(inner)) return env;
        const key = this.refinementKey(inner, allowPaths);
        if (key === null) return env;
        const v = this.evalPure(inner, env);
        const out = cloneEnv(env);
        if (branch) {
          // Truthy: not NaN, not zero — endpoint exclusion when whole.
          let r: AbsVal = { ...v, maybeNaN: false };
          if (r.whole && r.lo === 0 && r.hi >= 1) r = absVal(1, r.hi, r.whole, false, r.spelling);
          else if (r.whole && r.hi === 0 && r.lo <= -1) r = absVal(r.lo, -1, r.whole, false, r.spelling);
          out.set(key, r);
        } else {
          // Falsy: 0, -0, or NaN.
          out.set(key, meetInterval(v, 0, 0, false));
        }
        return out;
      }
      default:
        return env;
    }
  }

  /** No side effects anywhere in the tree: safe to (re-)evaluate during
   * refinement. */
  private isPure(e: IrExpr): boolean {
    switch (e.kind) {
      case "incDec":
      case "assignExpr":
      case "seqExpr":
      case "call":
      case "ffiCall":
      case "nativeCall":
      case "nativePeerAttach":
      case "callValue":
      case "new":
      case "newValue":
      case "virtualCall":
      case "dynCall":
      case "dynInvoke":
      case "intrinsic":
      case "yieldExpr":
      case "awaitExpr":
      case "awaitUnionExpr":
        return false;
      case "libCall":
        return e.fn.startsWith("math.") && e.args.every((a) => this.isPure(a));
      case "numLit":
      case "nativeScalarLit":
      case "nativeIntegerBin":
      case "strLit":
      case "boolLit":
      case "varRef":
      case "unitLit":
      case "selfRef":
        return true;
      case "recordGet":
      case "fieldGet":
        return this.staticAccessPath(e) !== null;
      case "unionNarrow":
        return this.isPure(e.value);
      case "strIntrinsic":
        return this.isPure(e.receiver) && e.args.every((argument) => this.isPure(argument));
      case "arrIntrinsic":
        return e.method === "length" &&
          this.isPure(e.receiver) &&
          e.args.every((argument) => this.isPure(argument));
      case "bytesIntrinsic":
        return (e.method === "length" || e.method === "byteLength") &&
          this.isPure(e.receiver) &&
          e.args.every((argument) => this.isPure(argument));
      case "bin":
      case "strEq":
      case "strCmp":
        return this.isPure(e.left) && this.isPure(e.right);
      case "unary":
        return this.isPure(e.operand);
      case "logical":
        return this.isPure(e.left) && this.isPure(e.right);
      case "toBool":
        return this.isPure(e.operand);
      default:
        return false;
    }
  }

  /** The abstract value of a PURE f64 expression, no env writes. */
  private evalPure(e: IrExpr, env: Env): AbsVal {
    switch (e.kind) {
      case "numLit":
        return constVal(e.value, e.spelling);
      case "nativeScalarLit":
      case "nativeIntegerBin":
        return { ...TOP };
      case "varRef":
        return this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
      case "recordGet": {
        const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const key = this.pathKey(e, slot?.cls ?? null);
        return key === null ? (slot === undefined ? { ...TOP } : classSeed(slot.cls)) : envGet(env, key);
      }
      case "fieldGet": {
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const fieldValue = this.machineAssumptions.fields.get(
          machineIntegerFieldKey(e.className, e.field),
        );
        if (fieldValue !== undefined) return fieldValue;
        const key = this.pathKey(e, null);
        return key === null ? { ...TOP } : envGet(env, key);
      }
      case "unionNarrow":
        return e.type.kind === "f64" && numberCarrierKind(e.value.type, this.mod) === "optional"
          ? this.evalPure(e.value, env)
          : { ...TOP };
      case "strIntrinsic":
        return e.method === "length" && e.type.kind === "f64"
          ? absVal(0, SAFE_MAX, true, false)
          : { ...TOP };
      case "arrIntrinsic":
        return e.method === "length" &&
            e.type.kind === "f64" &&
            this.machineAssumptions.representation.arrayLength === "int32"
          ? absVal(0, MACHINE_I32_MAX, true, false)
          : { ...TOP };
      case "unary":
        if (e.op === "-") return transferNeg(this.evalPure(e.operand, env));
        if (e.op === "~") return transferBitNot(this.evalPure(e.operand, env));
        return { ...TOP };
      case "bin":
        return transferBin(e.op, this.evalPure(e.left, env), this.evalPure(e.right, env));
      case "libCall":
        return this.evalMath(e, env, false) ?? { ...TOP };
      default:
        return { ...TOP };
    }
  }

  /** A canonical static data path. Source spellings that lower to the same
   * IR access (`m.total`, `m["total"]`) intentionally share a key; distinct
   * receiver bindings never do. Accessors/dynamic keys/computed receivers
   * have different IR nodes and are excluded. */
  private staticAccessPath(
    e: IrExpr,
  ): { rootId: string | null; steps: string[][] } | null {
    switch (e.kind) {
      case "varRef":
        return { rootId: e.localId, steps: [["var", e.localId]] };
      case "selfRef":
        return { rootId: null, steps: [["self"]] };
      case "recordGet": {
        const base = this.staticAccessPath(e.obj);
        if (base === null) return null;
        return { rootId: base.rootId, steps: [...base.steps, ["record", e.shapeId, e.field]] };
      }
      case "unionNarrow":
        return this.staticAccessPath(e.value);
      case "fieldGet": {
        const base = this.staticAccessPath(e.obj);
        if (base === null) return null;
        return { rootId: base.rootId, steps: [...base.steps, ["field", e.className, e.field]] };
      }
      default:
        return null;
    }
  }

  private readonly pathRoots = new Map<string, string | null>();

  private pathKey(e: IrExpr, cls: IntClass | null): string | null {
    const path = this.staticAccessPath(e);
    if (path === null) return null;
    const prefix = cls === null ? PATH_TOP_PREFIX : cls === "i64" ? PATH_I64_PREFIX : PATH_U64_PREFIX;
    const key = `${prefix}${JSON.stringify(path.steps)}`;
    this.pathRoots.set(key, path.rootId);
    return key;
  }

  private refinementKey(e: IrExpr, allowPaths: boolean): string | null {
    if (e.kind === "varRef") return e.localId;
    if (e.kind === "unionNarrow" && e.type.kind === "f64") {
      return this.refinementKey(e.value, allowPaths);
    }
    if (!allowPaths || numberCarrierKind(e.type, this.mod) === null) return null;
    if (e.kind === "recordGet") {
      const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
      return this.pathKey(e, slot?.cls ?? null);
    }
    return e.kind === "fieldGet" ? this.pathKey(e, null) : null;
  }

  /** Path facts are admitted only when the entire guard is synchronous,
   * call-free, assignment-free static data access. This prevents a later
   * subexpression from mutating a field and `refine` subsequently
   * reconstructing a stale fact from the guard syntax. */
  private stablePathGuard(e: IrExpr): boolean {
    switch (e.kind) {
      case "numLit":
      case "nativeScalarLit":
      case "nativeIntegerBin":
      case "strLit":
      case "boolLit":
      case "unitLit":
      case "varRef":
      case "selfRef":
        return true;
      case "recordGet":
      case "fieldGet":
        return this.staticAccessPath(e) !== null;
      case "unionIsTag":
      case "unionDisc":
        return this.stablePathGuard(e.value);
      case "unionNarrow":
        return this.stablePathGuard(e.value);
      case "bin":
      case "strEq":
      case "strCmp":
      case "logical":
        return this.stablePathGuard(e.left) && this.stablePathGuard(e.right);
      case "unary":
      case "toBool":
        return this.stablePathGuard(e.operand);
      default:
        return false;
    }
  }

  private clearPathsRootedAt(env: Env, localId: string): void {
    for (const k of [...env.keys()]) {
      if (pathSeedOfKey(k) !== null && this.pathRoots.get(k) === localId) env.delete(k);
    }
  }

  /* ── expression evaluation (side effects applied to env) ────────────── */

  private evalMath(e: IrExpr & { kind: "libCall" }, env: Env, mutate: boolean): AbsVal | null {
    const arg = (i: number): AbsVal => (mutate ? this.evalExpr(e.args[i]!, env) : this.evalPure(e.args[i]!, env));
    switch (e.fn) {
      case "math.trunc": return transferMathRound("trunc", arg(0));
      case "math.floor": return transferMathRound("floor", arg(0));
      case "math.ceil": return transferMathRound("ceil", arg(0));
      case "math.round": return transferMathRound("round", arg(0));
      case "math.abs": return transferAbs(arg(0));
      case "math.min": return transferMinMax("min", [arg(0), arg(1)]);
      case "math.max": return transferMinMax("max", [arg(0), arg(1)]);
      case "math.random": return absVal(0, 1, false, false); // [0, 1): never NaN, never whole beyond 0
      default: return null;
    }
  }

  private bindingCarriesNumber(id: string): boolean {
    return this.numberBindings.has(id);
  }
  private numberBindings = new Set<string>();

  seedBindings(fn: IrFunction, mod: IrModule): void {
    this.numberBindings = new Set();
    for (const l of fn.locals) {
      if (numberCarrierKind(l.type, mod) !== null && l.boxed !== true) this.numberBindings.add(l.id);
    }
    for (const g of mod.globals ?? []) {
      if (numberCarrierKind(g.type, mod) !== null) this.numberBindings.add(g.id);
    }
  }

  /** Evaluate an expression over the environment, applying the side
   * effects of nested writes and calls (a call havocs the globals its
   * transitive callee set can write; an indirect call havocs them all).
   * The returned value is meaningful for f64-typed expressions; anything
   * without a modeled transfer is TOP. */
  private evalExpr(e: IrExpr, env: Env): AbsVal {
    const value = this.evalExprInner(e, env);
    if (this.collect) this.machine?.recordExpression(e, value);
    return value;
  }

  private evalExprInner(e: IrExpr, env: Env): AbsVal {
    switch (e.kind) {
      case "numLit":
        return constVal(e.value, e.spelling);
      case "nativeScalarLit":
      case "nativeIntegerBin":
      case "strLit":
      case "boolLit":
      case "unitLit":
      case "regexLit":
      case "templateStrings":
      case "classRef":
      case "selfRef":
      case "chainRecv":
        return { ...TOP };
      case "varRef":
        return this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
      case "bin": {
        const a = this.evalExpr(e.left, env);
        const b = this.evalExpr(e.right, env);
        if (CMP_OPS.has(e.op)) return { ...TOP };
        if (e.left.type.kind !== "f64" || e.right.type.kind !== "f64") return { ...TOP };
        return transferBin(e.op, a, b);
      }
      case "strEq":
      case "strCmp":
        this.evalExpr(e.left, env);
        this.evalExpr(e.right, env);
        return { ...TOP };
      case "toBool":
        /* Numeric truthiness is a pure projection. Treating this ordinary
         * lowered coercion as an unknown expression used to havoc immutable
         * global facts inside ternaries, which in turn hid bounded loop
         * inductions from every number-facts consumer. */
        this.evalExpr(e.operand, env);
        return { ...TOP };
      case "unionIsTag":
      case "unionDisc":
        this.evalExpr(e.value, env);
        return { ...TOP };
      case "upcast":
        /* Upcasts change only the static view of an already-evaluated
         * value. They cannot run user or foreign code, so numeric facts in
         * the surrounding environment survive the identity conversion. */
        this.evalExpr(e.value, env);
        return { ...TOP };
      case "unary": {
        const v = this.evalExpr(e.operand, env);
        if (e.op === "-") return transferNeg(v);
        if (e.op === "~") return transferBitNot(v);
        return { ...TOP };
      }
      case "incDec": {
        const old = this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
        const next = transferAdd(old, constVal(e.op === "+" ? 1 : -1));
        if (this.collect) this.machine?.recordWrite(e.localId, next);
        if (this.bindingCarriesNumber(e.localId)) env.set(e.localId, next);
        return e.prefix ? next : old;
      }
      case "assignExpr": {
        const v = this.evalExpr(e.value, env);
        if (this.collect) this.machine?.recordWrite(e.localId, v);
        this.clearPathsRootedAt(env, e.localId);
        if (this.bindingCarriesNumber(e.localId)) env.set(e.localId, v);
        return v;
      }
      case "ternary": {
        this.evalExpr(e.cond, env);
        const allowPaths = this.stablePathGuard(e.cond);
        const thenEnv = this.refine(cloneEnv(env), e.cond, true, allowPaths);
        const elseEnv = this.refine(cloneEnv(env), e.cond, false, allowPaths);
        const a = thenEnv === null ? BOTTOM : this.evalExpr(e.then, thenEnv);
        const b = elseEnv === null ? BOTTOM : this.evalExpr(e.else_, elseEnv);
        mergeInto(env, joinEnv(thenEnv, elseEnv));
        return join(a, b);
      }
      case "logical":
      case "nullish":
      case "orDefault": {
        const left = this.evalExpr(e.left, env);
        const rightEnv = cloneEnv(env);
        const right = this.evalExpr(e.right, rightEnv);
        // A stable logical tree cannot change the environment, so its
        // short-circuit join must not discard an access-path fact merely
        // because the RHS may not execute.
        if (!this.stablePathGuard(e)) mergeInto(env, joinEnv(env, rightEnv));
        return numberCarrierKind(e.type, this.mod) !== null ? join(left, right) : { ...TOP };
      }
      case "optChain": {
        this.evalExpr(e.receiver, env);
        const bodyEnv = cloneEnv(env);
        const body = this.evalExpr(e.body, bodyEnv);
        mergeInto(env, joinEnv(env, bodyEnv));
        return numberCarrierKind(e.type, this.mod) !== null ? body : { ...TOP };
      }
      case "seqExpr": {
        // Expression-position statements: no jumps can escape them.
        let running: Env | null = env;
        for (const s of e.stmts) {
          if (running === null) break;
          running = this.execStmt(s, running);
        }
        if (running === null) return BOTTOM;
        if (running !== env) mergeInto(env, running);
        return this.evalExpr(e.result, env);
      }
      case "call": {
        // Arguments evaluate left to right and the VALUES captured here
        // are exactly what the call passes (a later argument's side
        // effect cannot reach an earlier argument's already-read value).
        const vals = e.args.map((a) => this.evalExpr(a, env));
        const slots = this.cfg.fns.get(e.callee);
        if (slots !== undefined) {
          e.args.forEach((arg, i) => {
            const cls = slots.params[i] ?? null;
            if (cls === null) return;
            this.emit(vals[i]!, slots.paramPaths[i]!, cls, arg.loc);
          });
        }
        this.havocCall(e.callee, env);
        if (slots?.ret != null) return classSeed(slots.ret);
        if (this.machineAssumptions.returns.has(e.callee)) {
          return this.machineAssumptions.returnValues.get(e.callee) ??
            classSeed("i32");
        }
        return { ...TOP };
      }
      case "unionWrap": {
        const value = this.evalExpr(e.value, env);
        if (numberCarrierKind(e.type, this.mod) !== "optional") return { ...TOP };
        // Unit arms are absence, not an integer crossing. The one f64 arm
        // contributes its abstract value unchanged.
        return e.value.type.kind === "f64" ? value : BOTTOM;
      }
      case "unionNarrow": {
        const value = this.evalExpr(e.value, env);
        return e.type.kind === "f64" && numberCarrierKind(e.value.type, this.mod) === "optional"
          ? value
          : { ...TOP };
      }
      case "strIntrinsic": {
        this.evalExpr(e.receiver, env);
        for (const argument of e.args) this.evalExpr(argument, env);
        /* Every ScriptC string has an integral UTF-16 length in the
         * language's safe-integer range. String intrinsics cannot invoke
         * user code, so observing one must not erase immutable-global or
         * induction facts around it. */
        return e.method === "length" && e.type.kind === "f64"
          ? absVal(0, SAFE_MAX, true, false)
          : { ...TOP };
      }
      case "arrIntrinsic": {
        this.evalExpr(e.receiver, env);
        for (const argument of e.args) this.evalExpr(argument, env);
        if (e.method !== "length") clearPathFacts(env);
        if (
          e.type.kind !== "f64" ||
          this.machineAssumptions.representation.arrayLength !== "int32"
        ) {
          return { ...TOP };
        }
        /* An int-bounded target represents all successful array lengths in
         * 0..INT32_MAX. Mutating length operations either throw or return
         * that new length; indexOf returns -1 or a valid int index. Array
         * intrinsics do not invoke user code, so global facts survive. */
        switch (e.method) {
          case "length":
          case "push":
          case "pushSpread":
          case "unshift":
          case "unshiftSpread":
            return absVal(0, MACHINE_I32_MAX, true, false);
          case "indexOf":
            return absVal(-1, MACHINE_I32_MAX - 1, true, false);
          default:
            return { ...TOP };
        }
      }
      case "bytesIntrinsic": {
        this.evalExpr(e.receiver, env);
        for (const argument of e.args) this.evalExpr(argument, env);
        /* Typed-array length observations cannot invoke user code. Their
         * result is an integral safe length just like a string length, so
         * they preserve surrounding immutable-global and induction facts. */
        return (e.method === "length" || e.method === "byteLength") &&
            e.type.kind === "f64"
          ? absVal(0, SAFE_MAX, true, false)
          : { ...TOP };
      }
      case "libCall": {
        const math = this.evalMath(e, env, true);
        if (math !== null) {
          clearPathFacts(env);
          return math;
        }
        for (const a of e.args) this.evalExpr(a, env);
        if (e.args.some((a) => typeContainsFunc(a.type))) this.havocAllGlobals(env);
        clearPathFacts(env);
        return { ...TOP };
      }
      case "virtualCall": {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        this.havocAllGlobals(env);
        const methodKey = machineIntegerMethodKey(e.className, e.method);
        const methodValue = this.machineAssumptions.methodValues.get(methodKey);
        if (methodValue !== undefined) return methodValue;
        return this.machineAssumptions.methods.has(methodKey)
          ? classSeed("i32")
          : { ...TOP };
      }
      case "callValue":
      case "newValue":
      case "dynCall":
      case "dynInvoke":
      case "new":
      case "nativePeerAttach":
      case "intrinsic": {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        this.havocAllGlobals(env);
        return { ...TOP };
      }
      case "nativeCall":
        return this.evalNativeCall(e, env);
      case "ffiCall":
      case "yieldExpr":
      case "awaitExpr":
      case "awaitUnionExpr": {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        /* Each of these can run other code before the value comes back: an
         * FFI callback, or whatever the scheduler resumes at a suspension.
         * A global written there is not the one this environment holds. */
        this.havocAllGlobals(env);
        return { ...TOP };
      }
      case "recordLit": {
        const slotMap = this.cfg.records.get((e.type as { kind: "record"; shapeId: string }).shapeId);
        for (const f of e.fields) {
          const v = this.evalExpr(f.value, env);
          const slot = slotMap?.get(f.name);
          if (slot !== undefined && numberCarrierKind(f.value.type, this.mod) !== null) {
            this.emitRecordSlot(v, slot, f.value.loc);
          }
        }
        return { ...TOP };
      }
      case "recordClone": {
        // The clone copies already-proven field values. Only explicit
        // overrides create new writes that must discharge integer slots.
        this.evalExpr(e.source, env);
        const slotMap = this.cfg.records.get((e.type as { kind: "record"; shapeId: string }).shapeId);
        for (const f of e.overrides) {
          const v = this.evalExpr(f.value, env);
          const slot = slotMap?.get(f.name);
          if (slot !== undefined && numberCarrierKind(f.value.type, this.mod) !== null) {
            this.emitRecordSlot(v, slot, f.value.loc);
          }
        }
        return { ...TOP };
      }
      case "recordGet": {
        // A declared record-field slot is an assumption on the read side,
        // exactly like a declared parameter inside its callee: every write
        // into the field discharged the class's obligations, so its path
        // starts at the class seed. An ordinary numeric field starts at TOP
        // but can acquire the same straight-line guard facts as a local.
        this.evalExpr(e.obj, env);
        const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
        if (numberCarrierKind(e.type, this.mod) !== null) {
          const key = this.pathKey(e, slot?.cls ?? null);
          return key === null ? (slot === undefined ? { ...TOP } : classSeed(slot.cls)) : envGet(env, key);
        }
        return { ...TOP };
      }
      case "fieldGet": {
        this.evalExpr(e.obj, env);
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const fieldValue = this.machineAssumptions.fields.get(
          machineIntegerFieldKey(e.className, e.field),
        );
        if (fieldValue !== undefined) return fieldValue;
        const key = this.pathKey(e, null);
        return key === null ? { ...TOP } : envGet(env, key);
      }
      case "nativeScalarToNumber": {
        this.evalExpr(e.value, env);
        /* A widened exact integer is whole and inside its own slot — the
         * same fact a widened result carries, reached through the named
         * conversion instead of a boundary. A branded double says nothing. */
        if (e.value.type.kind !== "nativeScalar") return { ...TOP };
        const slot = nativeSlot(e.value.type.scalar);
        return slot === null ? { ...TOP } : slotSeed(slot);
      }
      case "nativeScalarFromNumber": {
        /* The value it yields is exact, not an f64, so nothing in this domain
         * describes it; what matters is that the operand is evaluated and no
         * global fact is disturbed by a conversion. */
        this.evalExpr(e.value, env);
        return { ...TOP };
      }
      case "nativeStructGet": {
        this.evalExpr(e.value, env);
        /* Reading a number-projected field widens an exact slot, so the
         * value it yields is whole and inside that slot's interval — the
         * same fact a widened result carries, and what lets a field read
         * flow back into a boundary without a second check. */
        if (e.type.kind !== "f64" || this.native === null) return { ...TOP };
        const owner = e.value.type.kind === "nativeStruct"
          ? this.native.structs.get(e.value.type.typeId)
          : undefined;
        const field = owner?.fields.find((entry) => entry.name === e.field);
        const slot = field?.type.kind === "nativeScalar"
          ? nativeSlot(field.type.scalar)
          : null;
        return slot === null ? { ...TOP } : slotSeed(slot);
      }
      default: {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        // Unmodeled expressions do not participate in the cheap
        // straight-line proof. Some can invoke runtime/user machinery —
        // an array intrinsic taking a callback, a generator resumption, a
        // promise executor — so the safe verdict drops the global facts
        // too, not only the field ones. The polarity is deliberate: a kind
        // added later is conservative here until it is modeled.
        this.havocAllGlobals(env);
        return { ...TOP };
      }
    }
  }

  /* ── the native checked-number boundary ───────────────────────────────
   * A native call is an opaque transfer of control: it may run a
   * call-scoped callback, dispatch a queued one, or re-enter the program
   * some other way, so every global fact dies here. What it gives back is
   * narrower than TOP when the result widens out of an exact slot — the
   * fact that makes a round trip through the boundary free. */
  private evalNativeCall(
    e: Extract<IrExpr, { kind: "nativeCall" }>,
    env: Env,
  ): AbsVal {
    const values = e.args.map((argument) => this.evalExpr(argument, env));
    const native = this.native;
    const binding = native?.bindings.get(e.binding);
    /* Only a call that can re-enter the program forgets what the globals
     * hold: one carrying a callback of its own, or any call at all once the
     * module has registered a callback the native side may dispatch on its
     * own schedule. A plain call into C cannot reach a ScriptC binding, and
     * pretending otherwise would forget the value of the very line above. */
    if (
      native === null || native === undefined || binding === undefined ||
      native.reentrant ||
      binding.arguments.some((argument) => argument.callback !== undefined)
    ) {
      this.havocAllGlobals(env);
    } else {
      clearPathFacts(env);
    }
    if (native !== null && native !== undefined && binding !== undefined) {
      binding.parameters.forEach((parameter, index) => {
        if (parameter.projection.kind !== "number") return;
        /* A wrapping conversion is TOTAL: every double has an answer, so no
         * value can be proven not to cross and the slot constrains nothing
         * about what reaches it. Only the checked conversion has a range to
         * fall outside of. */
        if (parameter.projection.conversion !== "checked") return;
        const slot = parameter.type.kind === "nativeScalar"
          ? nativeSlot(parameter.type.scalar)
          : null;
        const value = values[parameter.projection.argument];
        if (slot === null || value === undefined) return;
        this.recordCrossing(native, e, index, slot, value, binding.id);
      });
      if (binding.result.projection.kind === "number") {
        const slot = binding.result.type.kind === "nativeScalar"
          ? nativeSlot(binding.result.type.scalar)
          : null;
        if (slot !== null) return slotSeed(slot);
      }
    }
    return { ...TOP };
  }

  /** Record one crossing's verdict. A site visited more than once — the
   * same expression under two enclosing collect passes — keeps its check
   * unless every visit certified it. */
  private recordCrossing(
    native: NativeBoundaryContext,
    call: IrExpr,
    parameter: number,
    slot: NativeSlot,
    value: AbsVal,
    bindingId: string,
  ): void {
    if (!this.collect) return;
    const verdict = certifyNumberCrossing(value, slot);
    if (verdict === "certified") {
      let set = native.certified.get(call);
      if (set === undefined) {
        set = new Set();
        native.certified.set(call, set);
      }
      set.add(parameter);
      return;
    }
    let unproven = native.unproven.get(call);
    if (unproven === undefined) {
      unproven = new Set();
      native.unproven.set(call, unproven);
    }
    unproven.add(parameter);
    if (verdict === "refused") {
      native.refusals.push({
        binding: bindingId,
        parameter,
        scalar: slot.scalar,
        detail: describeRefusedCrossing(value),
        loc: call.loc,
      });
    }
  }

  private havocCall(callee: string, env: Env): void {
    clearPathFacts(env);
    if (this.effects.havocAll.has(callee) || !this.effects.perFn.has(callee)) {
      this.havocAllGlobals(env);
      return;
    }
    for (const g of this.effects.perFn.get(callee)!) env.delete(g); // absent global = TOP
  }

  private havocAllGlobals(env: Env): void {
    clearPathFacts(env);
    for (const k of [...env.keys()]) {
      /* Re-entrant callbacks may mutate only mutable bindings. Literal
       * immutable globals are source-level constants, so forgetting their
       * value here is not conservative—it is simply false, and it can make
       * one retained callback de-specialize every unrelated loop whose
       * bound is such a constant. */
      if (isGlobalId(k) && !this.globalSeeds.has(k)) env.delete(k);
    }
  }
}

function cloneEnv(env: Env): Env {
  return new Map(env);
}

function mergeInto(dst: Env, src: Env | null): void {
  if (src === null || src === dst) return;
  dst.clear();
  for (const [k, v] of src) dst.set(k, v);
}

function typeContainsFunc(t: unknown): boolean {
  return JSON.stringify(t).includes('"func"');
}

/** Every direct IrExpr child of a node, order-preserving (evaluation
 * order for the shapes we don't model precisely). */
function childExprs(e: IrExpr): IrExpr[] {
  const out: IrExpr[] = [];
  for (const [key, v] of Object.entries(e)) {
    if (key === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object") {
          if (typeof (item as { kind?: unknown }).kind === "string" && !isStmtKind((item as { kind: string }).kind)) {
            out.push(item as IrExpr);
          } else {
            for (const sub of Object.values(item as object)) {
              if (sub !== null && typeof sub === "object" && typeof (sub as { kind?: unknown }).kind === "string" && !isStmtKind((sub as { kind: string }).kind)) {
                out.push(sub as IrExpr);
              }
            }
          }
        }
      }
    } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && !isStmtKind((v as { kind: string }).kind)) {
      out.push(v as IrExpr);
    }
  }
  return out;
}

/** Immutable numeric globals whose sole write is their literal module
 * initializer. ScriptC runs module initialization before any exported
 * function can be entered, so this is a proof seed, not speculative
 * constant propagation. A second or indirect write drops the seed. */
function constantNumberGlobals(mod: IrModule): ReadonlyMap<string, AbsVal> {
  const candidates = new Set(
    (mod.globals ?? [])
      .filter((global) => global.type.kind === "f64" && !global.mutable)
      .map((global) => global.id),
  );
  const writes = new Map<string, { count: number; value: AbsVal | null }>();
  for (const id of candidates) writes.set(id, { count: 0, value: null });

  walkBodyNodes(mod.functions, (node) => {
    if (
      node.kind !== "assign" &&
      node.kind !== "varDecl" &&
      node.kind !== "assignExpr" &&
      node.kind !== "incDec" &&
      node.kind !== "forOf"
    ) {
      return;
    }
    const write = node as {
      readonly localId?: string;
      readonly value?: IrExpr;
      readonly init?: IrExpr | null;
    };
    if (write.localId === undefined || !candidates.has(write.localId)) return;
    const state = writes.get(write.localId)!;
    state.count++;
    const value = write.value ?? write.init;
    state.value = value?.kind === "numLit"
      ? constVal(value.value, value.spelling)
      : null;
  });

  const constants = new Map<string, AbsVal>();
  for (const [id, state] of writes) {
    if (state.count === 1 && state.value !== null) constants.set(id, state.value);
  }
  return constants;
}

export interface MachineIntegerFacts {
  /** Immutable literal module globals proved to fit the same carrier. */
  readonly globals: ReadonlySet<string>;
  /** Managed f64 fields whose default value and every whole-program write
   * fit a signed int32 and can never carry -0. Keys include inherited class
   * views so a backend need not rediscover the declaring layout owner. */
  readonly fields: ReadonlySet<string>;
  /** Direct-only f64 parameters whose complete set of call sites passes a
   * signed int32 value. Externally callable functions, closures, class
   * methods, boxed parameters, and functions with an unknown entry path are
   * never present. The source-visible number ABI therefore remains f64. */
  readonly parameters: ReadonlySet<string>;
  /** Function name → f64 locals whose every reachable write is proved to
   * be a signed 32-bit integer and never the observably distinct -0. */
  readonly locals: ReadonlyMap<string, ReadonlySet<string>>;
  /** f64 expressions proved to have the same representation-safe range. */
  readonly expressions: ReadonlySet<IrExpr>;
  /** Internal f64-returning functions whose every reachable return is
   * proved to fit the signed-int32 carrier. Source-visible number ABIs stay
   * f64; a backend may use this only between generated implementation
   * bodies and widen at an external boundary. */
  readonly returns: ReadonlySet<string>;
  /** Static class views whose complete override family has an integer
   * return. A virtual descriptor is specialized only as a family: one
   * fractional override keeps every dispatch through that slot on f64. */
  readonly methods: ReadonlySet<string>;
}

const machineIntegerFactsByModule = new WeakMap<
  IrModule,
  Map<string, MachineIntegerFacts>
>();

export function machineIntegerFieldKey(className: string, field: string): string {
  return JSON.stringify([className, field]);
}

export function machineIntegerParameterKey(functionName: string, index: number): string {
  return JSON.stringify([functionName, index]);
}

export function machineIntegerMethodKey(className: string, method: string): string {
  return JSON.stringify([className, method]);
}

function machineIntegerFieldValues(
  mod: IrModule,
  expressions: ReadonlyMap<IrExpr, AbsVal>,
): ReadonlyMap<string, AbsVal> {
  const classes = new Map(
    (mod.classes ?? [])
      .filter((class_) => class_.runtime !== true)
      .map((class_) => [class_.name, class_]),
  );
  const declaredOwner = (className: string, field: string): string | null => {
    const class_ = classes.get(className);
    if (class_ === undefined) return null;
    const index = class_.fields.findIndex((candidate) => candidate.name === field);
    if (index < 0) return null;
    if (class_.base !== undefined) {
      const base = classes.get(class_.base);
      if (base !== undefined && index < base.fields.length) {
        return declaredOwner(base.name, field);
      }
    }
    return class_.name;
  };

  const eligible = new Set<string>();
  for (const class_ of classes.values()) {
    const inherited = class_.base === undefined
      ? 0
      : classes.get(class_.base)?.fields.length ?? 0;
    for (const field of class_.fields.slice(inherited)) {
      if (field.type.kind === "f64") {
        eligible.add(machineIntegerFieldKey(class_.name, field.name));
      }
    }
  }
  const unsafe = new Set<string>();
  const declarationValues = new Map<string, AbsVal>();
  walkBodyNodes(mod.functions, (node) => {
    if (node.kind === "fieldSet") {
      const write = node as Extract<IrStmt, { kind: "fieldSet" }>;
      const owner = declaredOwner(write.className, write.field);
      if (owner === null) return;
      const key = machineIntegerFieldKey(owner, write.field);
      if (!eligible.has(key)) return;
      const value = expressions.get(write.value) ?? TOP;
      if (!isMachineI32(value)) {
        unsafe.add(key);
      } else {
        declarationValues.set(
          key,
          join(declarationValues.get(key) ?? BOTTOM, value),
        );
      }
      return;
    }
    if (node.kind === "fieldIncDec") {
      const write = node as Extract<IrExpr, { kind: "fieldIncDec" }>;
      const owner = declaredOwner(write.className, write.field);
      if (owner !== null) unsafe.add(machineIntegerFieldKey(owner, write.field));
    }
  });

  const safeDeclarations = new Set(
    [...eligible].filter((key) => !unsafe.has(key)),
  );
  const fields = new Map<string, AbsVal>();
  for (const class_ of classes.values()) {
    for (const field of class_.fields) {
      const owner = declaredOwner(class_.name, field.name);
      if (
        owner !== null &&
        safeDeclarations.has(machineIntegerFieldKey(owner, field.name))
      ) {
        const ownerKey = machineIntegerFieldKey(owner, field.name);
        fields.set(
          machineIntegerFieldKey(class_.name, field.name),
          declarationValues.get(ownerKey) ?? classSeed("i32"),
        );
      }
    }
  }
  return fields;
}

/** Infer an implementation-only parameter carrier from the complete direct
 * call graph. A source `number` parameter can become Java `int` only when
 * every way into that implementation is visible here. Public JVM wrappers
 * are supplied by the emitter as `externallyCallable`; closures, managed
 * methods, module entry, async/generator bodies, and boxed parameters are
 * excluded structurally because another entry path can supply an arbitrary
 * JavaScript number.
 *
 * Values come from the same abstract interpreter that proves locals and
 * returns. This is deliberately a call-site proof rather than a parameter
 * annotation: a helper called only with 50_000 may specialize, while an
 * otherwise identical exported helper remains f64. */
function machineIntegerParameterValues(
  mod: IrModule,
  expressions: ReadonlyMap<IrExpr, AbsVal>,
  externallyCallable: ReadonlySet<string>,
): ReadonlyMap<string, AbsVal> {
  const excluded = new Set(externallyCallable);
  excluded.add(mod.entry);
  const managedImplementations = new Set<string>();
  for (const class_ of mod.classes ?? []) {
    for (const fn of mod.functions) {
      if (fn.name.startsWith(`%${class_.name}.`)) {
        managedImplementations.add(fn.name);
      }
    }
  }
  for (const fn of mod.functions) {
    if (
      managedImplementations.has(fn.name) ||
      fn.captures !== undefined ||
      fn.async === true ||
      fn.generator !== undefined
    ) {
      excluded.add(fn.name);
    }
  }

  const calls = new Map<
    string,
    Extract<IrExpr, { readonly kind: "call" }>[]
  >();
  walkBodyNodes(mod.functions, (node) => {
    if (node.kind === "closure") {
      excluded.add((node as Extract<IrExpr, { readonly kind: "closure" }>).fnName);
      return;
    }
    if (node.kind !== "call") return;
    const call = node as Extract<IrExpr, { readonly kind: "call" }>;
    const sites = calls.get(call.callee) ?? [];
    sites.push(call);
    calls.set(call.callee, sites);
  });

  const values = new Map<string, AbsVal>();
  for (const fn of mod.functions) {
    if (excluded.has(fn.name)) continue;
    const sites = calls.get(fn.name);
    if (sites === undefined || sites.length === 0) continue;
    fn.params.forEach((parameter, index) => {
      if (parameter.type.kind !== "f64") return;
      const local = fn.locals.find(({ id }) => id === parameter.localId);
      if (local?.boxed === true) return;
      let value = BOTTOM;
      for (const site of sites) {
        const argument = site.args[index];
        if (argument === undefined) return;
        const observed = expressions.get(argument) ?? BOTTOM;
        if (!isMachineI32(observed)) return;
        value = join(value, observed);
      }
      values.set(machineIntegerParameterKey(fn.name, index), value);
    });
  }
  return values;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameAbsValMap(
  left: ReadonlyMap<string, AbsVal>,
  right: ReadonlyMap<string, AbsVal>,
): boolean {
  return left.size === right.size && [...left].every(([key, value]) => {
    const other = right.get(key);
    return other !== undefined && sameVal(value, other);
  });
}

function joinAbsValMaps(
  left: ReadonlyMap<string, AbsVal>,
  right: ReadonlyMap<string, AbsVal>,
): ReadonlyMap<string, AbsVal> {
  const result = new Map(left);
  for (const [key, value] of right) {
    result.set(key, join(result.get(key) ?? BOTTOM, value));
  }
  return result;
}

/** Resolve one virtual slot to the oldest declaration in its inheritance
 * chain. That declaration owns the Java descriptor all overrides must share. */
function machineMethodSlotOwner(
  classes: ReadonlyMap<string, NonNullable<IrModule["classes"]>[number]>,
  className: string,
  method: string,
): string | null {
  let current = classes.get(className);
  let owner: string | null = null;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    if (current.methods?.includes(method) === true) owner = current.name;
    current = current.base === undefined ? undefined : classes.get(current.base);
  }
  return owner;
}

/** A Java virtual method's result descriptor belongs to the whole override
 * family, not to one body. Publish a class-view fact only when every concrete
 * declaration in the slot already has a proved integer implementation. */
function machineIntegerMethodFacts(
  mod: IrModule,
  returns: ReadonlySet<string>,
  returnValues: ReadonlyMap<string, AbsVal>,
): {
  readonly methods: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, AbsVal>;
} {
  const classes = new Map(
    (mod.classes ?? [])
      .filter((class_) => class_.runtime !== true)
      .map((class_) => [class_.name, class_]),
  );
  const functionNames = new Set(mod.functions.map((fn) => fn.name));
  const implementations = new Map<string, Set<string>>();
  const incomplete = new Set<string>();
  for (const class_ of classes.values()) {
    for (const method of class_.methods ?? []) {
      const owner = machineMethodSlotOwner(classes, class_.name, method);
      if (owner === null) continue;
      const slot = machineIntegerMethodKey(owner, method);
      if (class_.abstractMethods?.includes(method) === true) continue;
      const implementation = `%${class_.name}.${method}`;
      if (!functionNames.has(implementation)) {
        incomplete.add(slot);
        continue;
      }
      let members = implementations.get(slot);
      if (members === undefined) {
        members = new Set();
        implementations.set(slot, members);
      }
      members.add(implementation);
    }
  }
  const safeSlots = new Set(
    [...implementations]
      .filter(([slot, members]) =>
        !incomplete.has(slot) && [...members].every((fn) => returns.has(fn))
      )
      .map(([slot]) => slot),
  );
  const slotValues = new Map<string, AbsVal>();
  for (const slot of safeSlots) {
    let value = BOTTOM;
    for (const implementation of implementations.get(slot) ?? []) {
      value = join(
        value,
        returnValues.get(implementation) ?? classSeed("i32"),
      );
    }
    slotValues.set(slot, value);
  }
  const methods = new Set<string>();
  const values = new Map<string, AbsVal>();
  for (const class_ of classes.values()) {
    const visible = new Set<string>();
    let current: typeof class_ | undefined = class_;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.name)) {
      seen.add(current.name);
      for (const method of current.methods ?? []) visible.add(method);
      current = current.base === undefined ? undefined : classes.get(current.base);
    }
    for (const method of visible) {
      const owner = machineMethodSlotOwner(classes, class_.name, method);
      if (
        owner !== null &&
        safeSlots.has(machineIntegerMethodKey(owner, method))
      ) {
        const view = machineIntegerMethodKey(class_.name, method);
        methods.add(view);
        values.set(
          view,
          slotValues.get(machineIntegerMethodKey(owner, method)) ??
            classSeed("i32"),
        );
      }
    }
  }
  return { methods, values };
}

function inferMachineIntegerReturns(
  mod: IrModule,
  effects: GlobalEffects,
  native: NativeBoundaryContext,
  globalSeeds: ReadonlyMap<string, AbsVal>,
  fields: ReadonlyMap<string, AbsVal>,
  parameters: ReadonlyMap<string, AbsVal>,
  returnValues: ReadonlyMap<string, AbsVal>,
  representation: MachineIntegerRepresentation,
): ReadonlySet<string> {
  let candidates: ReadonlySet<string> = new Set(
    mod.functions
      .filter((fn) => fn.returnType.kind === "f64")
      .map((fn) => fn.name),
  );
  while (true) {
    const methodFacts = machineIntegerMethodFacts(mod, candidates, returnValues);
    const assumptions: MachineIntegerAssumptions = {
      fields,
      parameters,
      methods: methodFacts.methods,
      methodValues: methodFacts.values,
      returns: candidates,
      returnValues,
      representation,
    };
    const next = new Set<string>();
    for (const fn of mod.functions) {
      if (!candidates.has(fn.name)) continue;
      const observer = new FunctionMachineIntegerObserver(fn);
      const analyzer = new FnAnalyzer(
        mod,
        { fns: new Map(), records: new Map() },
        effects,
        [],
        native,
        globalSeeds,
        observer,
        assumptions,
      );
      analyzer.seedBindings(fn, mod);
      analyzer.analyze(fn);
      if (observer.returnsMachineInteger()) next.add(fn.name);
    }
    if (sameStringSet(candidates, next)) {
      return next;
    }
    candidates = next;
  }
}

/** Recover the useful interval behind each proved return. The descriptor
 * decision needs only the set above, but callers such as `super.m() + 1`
 * must see the base's actual `0..1023` result rather than the entire int32
 * carrier or they would conservatively manufacture an overflow. */
function summarizeMachineIntegerReturns(
  mod: IrModule,
  effects: GlobalEffects,
  native: NativeBoundaryContext,
  globalSeeds: ReadonlyMap<string, AbsVal>,
  fields: ReadonlyMap<string, AbsVal>,
  parameters: ReadonlyMap<string, AbsVal>,
  returns: ReadonlySet<string>,
  representation: MachineIntegerRepresentation,
): ReadonlyMap<string, AbsVal> {
  let values: ReadonlyMap<string, AbsVal> = new Map(
    [...returns].map((fn) => [fn, BOTTOM]),
  );
  for (let iteration = 0; iteration < LOOP_CAP; iteration++) {
    const methodFacts = machineIntegerMethodFacts(mod, returns, values);
    const assumptions: MachineIntegerAssumptions = {
      fields,
      parameters,
      methods: methodFacts.methods,
      methodValues: methodFacts.values,
      returns,
      returnValues: values,
      representation,
    };
    const next = new Map<string, AbsVal>();
    for (const fn of mod.functions) {
      if (!returns.has(fn.name)) continue;
      const observer = new FunctionMachineIntegerObserver(fn);
      const analyzer = new FnAnalyzer(
        mod,
        { fns: new Map(), records: new Map() },
        effects,
        [],
        native,
        globalSeeds,
        observer,
        assumptions,
      );
      analyzer.seedBindings(fn, mod);
      analyzer.analyze(fn);
      const previous = values.get(fn.name) ?? BOTTOM;
      const joined = join(previous, observer.returnValue());
      next.set(
        fn.name,
        iteration < WIDEN_AFTER ? joined : widen(previous, joined),
      );
    }
    if (sameAbsValMap(values, next)) return next;
    values = next;
  }
  return values;
}

function observeMachineIntegers(
  mod: IrModule,
  effects: GlobalEffects,
  native: NativeBoundaryContext,
  globalSeeds: ReadonlyMap<string, AbsVal>,
  assumptions: MachineIntegerAssumptions,
): {
  readonly expressionValues: ReadonlyMap<IrExpr, AbsVal>;
  readonly expressions: ReadonlySet<IrExpr>;
  readonly locals: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const cfg: IntSlotConfig = { fns: new Map(), records: new Map() };
  const locals = new Map<string, ReadonlySet<string>>();
  const expressions = new Set<IrExpr>();
  const expressionValues = new Map<IrExpr, AbsVal>();
  for (const fn of mod.functions) {
    const observer = new FunctionMachineIntegerObserver(fn);
    const analyzer = new FnAnalyzer(
      mod,
      cfg,
      effects,
      [],
      native,
      globalSeeds,
      observer,
      assumptions,
    );
    analyzer.seedBindings(fn, mod);
    analyzer.analyze(fn);
    const functionLocals = observer.locals();
    if (functionLocals.size > 0) locals.set(fn.name, functionLocals);
    for (const expression of observer.expressions()) expressions.add(expression);
    for (const [expression, value] of observer.expressionValues()) {
      expressionValues.set(
        expression,
        join(expressionValues.get(expression) ?? BOTTOM, value),
      );
    }
  }
  return { expressionValues, expressions, locals };
}

/** Proved storage choices for backends that have a cheaper signed-integer
 * representation. JavaScript's public number type remains f64: external
 * parameters and returns widen at their boundary, while overflow, fractions,
 * NaN, infinities, and -0 keep that carrier everywhere. `externallyCallable`
 * names implementation bodies a target exposes through another ABI; their
 * parameters must remain general numbers even when every internal call site
 * happens to pass an integer. */
export function machineIntegerFacts(
  mod: IrModule,
  externallyCallable: ReadonlySet<string> = new Set(),
  representation: MachineIntegerRepresentation =
    GENERIC_MACHINE_INTEGER_REPRESENTATION,
): MachineIntegerFacts {
  const cacheKey = JSON.stringify({
    externallyCallable: [...externallyCallable].sort(),
    arrayLength: representation.arrayLength ?? null,
  });
  let moduleCache = machineIntegerFactsByModule.get(mod);
  const cached = moduleCache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const effects = globalEffectsOf(mod);
  const globalSeeds = constantNumberGlobals(mod);
  const globals = new Set(
    [...globalSeeds]
      .filter(([, value]) => isMachineI32(value))
      .map(([id]) => id),
  );
  const native = nativeBoundaryContext(mod);
  let observed = observeMachineIntegers(
    mod,
    effects,
    native,
    globalSeeds,
    {
      ...EMPTY_MACHINE_INTEGER_ASSUMPTIONS,
      representation,
    },
  );
  let fieldValues: ReadonlyMap<string, AbsVal> = machineIntegerFieldValues(
    mod,
    observed.expressionValues,
  );
  let parameterValues: ReadonlyMap<string, AbsVal> = machineIntegerParameterValues(
    mod,
    observed.expressionValues,
    externallyCallable,
  );
  let returns: ReadonlySet<string> = new Set();
  let returnValues: ReadonlyMap<string, AbsVal> = new Map();
  let methods: ReadonlySet<string> = new Set();
  while (true) {
    const inferredReturns = inferMachineIntegerReturns(
      mod,
      effects,
      native,
      globalSeeds,
      fieldValues,
      parameterValues,
      returnValues,
      representation,
    );
    const nextReturnValues = summarizeMachineIntegerReturns(
      mod,
      effects,
      native,
      globalSeeds,
      fieldValues,
      parameterValues,
      inferredReturns,
      representation,
    );
    const methodFacts = machineIntegerMethodFacts(
      mod,
      inferredReturns,
      nextReturnValues,
    );
    const assumptions: MachineIntegerAssumptions = {
      fields: fieldValues,
      parameters: parameterValues,
      methods: methodFacts.methods,
      methodValues: methodFacts.values,
      returns: inferredReturns,
      returnValues: nextReturnValues,
      representation,
    };
    const nextObserved = observeMachineIntegers(
      mod,
      effects,
      native,
      globalSeeds,
      assumptions,
    );
    const nextFieldValues = joinAbsValMaps(
      fieldValues,
      machineIntegerFieldValues(mod, nextObserved.expressionValues),
    );
    const nextParameterValues = machineIntegerParameterValues(
      mod,
      nextObserved.expressionValues,
      externallyCallable,
    );
    const stable =
      sameStringSet(returns, inferredReturns) &&
      sameAbsValMap(returnValues, nextReturnValues) &&
      sameAbsValMap(fieldValues, nextFieldValues) &&
      sameAbsValMap(parameterValues, nextParameterValues);
    returns = inferredReturns;
    returnValues = nextReturnValues;
    methods = methodFacts.methods;
    fieldValues = nextFieldValues;
    parameterValues = nextParameterValues;
    observed = nextObserved;
    if (stable) break;
  }
  const facts = Object.freeze({
    globals,
    fields: new Set(fieldValues.keys()),
    parameters: new Set(parameterValues.keys()),
    locals: observed.locals,
    expressions: observed.expressions,
    returns,
    methods,
  });
  if (moduleCache === undefined) {
    moduleCache = new Map();
    machineIntegerFactsByModule.set(mod, moduleCache);
  }
  moduleCache.set(cacheKey, facts);
  return facts;
}

/* ── the entry point ───────────────────────────────────────────────────── */

/** Run the inference over every function of a lowered library module and
 * return one verdict per (obligation site) — internal call arguments into
 * declared integer parameters, returns of declared integer returns, and
 * writes into declared record-field slots. Callers turn REFUSE verdicts
 * into diagnostics; PROVE verdicts carry the proven crossing range. */
export function checkLibraryIntegerSlots(mod: IrModule, cfg: IntSlotConfig): IntVerdict[] {
  const verdicts: IntVerdict[] = [];
  if (!hasIntSlots(cfg)) return verdicts;
  const effects = globalEffectsOf(mod);
  const globalSeeds = constantNumberGlobals(mod);
  for (const fn of mod.functions) {
    const analyzer = new FnAnalyzer(mod, cfg, effects, verdicts, null, globalSeeds);
    analyzer.seedBindings(fn, mod);
    analyzer.analyze(fn);
  }
  return verdicts;
}

/* ── the native checked-number boundary ──────────────────────────────────
 * The second consumer of the domain above. A `number` parameter projection
 * converts a plain JavaScript number into an exact slot at most 32 bits
 * wide, and the conversion is checked at run time because in general
 * nothing knows what the value is. Where this analysis does know — the
 * value is whole and its whole interval fits the slot — the check is dead
 * code, and eliding it is what makes the plain-number carrier cost nothing
 * on the paths that matter: a widened result fed straight back, a payload
 * a handler passes on, a loop induction used as an index.
 *
 * The polarity is the point. A site is certified only by a proof, and
 * everything unmodeled reaches TOP and keeps its check. A site whose every
 * admitted value is outside the slot is refused at compile time instead —
 * the judgment the frontend already makes for a literal, reached here by
 * inference. */

/** A crossing that cannot succeed for any value the analysis admits. */
export interface NumberBoundaryRefusal {
  readonly binding: string;
  readonly parameter: number;
  readonly scalar: string;
  readonly detail: string;
  readonly loc: SrcLoc;
}

export interface NumberBoundaryFacts {
  /** Native call expression → the physical parameter indices whose checked
   * ingress is proven unnecessary. Keyed by IR node identity: the facts are
   * a pure function of the module, so every consumer holding the module
   * holds the same keys. */
  readonly certified: ReadonlyMap<IrExpr, ReadonlySet<number>>;
  readonly refusals: readonly NumberBoundaryRefusal[];
}

interface NativeSlot {
  readonly min: number;
  readonly max: number;
  readonly scalar: string;
}

interface NativeBoundaryContext {
  readonly bindings: ReadonlyMap<string, IrNativeBinding>;
  /** The module registered a callback the native side holds past the call
   * that passed it, so any later native call may dispatch it. */
  readonly reentrant: boolean;
  readonly structs: ReadonlyMap<string, IrNativeStructDef>;
  readonly callbackSeeds: ReadonlyMap<string, readonly (AbsVal | null)[]>;
  readonly certified: Map<IrExpr, Set<number>>;
  /** Sites a visit failed to certify. A site is elided only when no visit
   * left it unproven, so a second, weaker visit cannot be overruled by an
   * earlier stronger one. */
  readonly unproven: Map<IrExpr, Set<number>>;
  readonly refusals: NumberBoundaryRefusal[];
}

const EMPTY_BOUNDARY_FACTS: NumberBoundaryFacts = Object.freeze({
  certified: new Map<IrExpr, ReadonlySet<number>>(),
  refusals: Object.freeze([]) as readonly NumberBoundaryRefusal[],
});

const boundaryFactsByModule = new WeakMap<IrModule, NumberBoundaryFacts>();

/** The boundary facts for one module, computed once. Both backends and the
 * driver ask independently; the module is frozen, so one analysis answers
 * all of them and every consumer sees the same verdicts. */
export function numberBoundaryFacts(mod: IrModule): NumberBoundaryFacts {
  const cached = boundaryFactsByModule.get(mod);
  if (cached !== undefined) return cached;
  const facts = computeNumberBoundaryFacts(mod);
  boundaryFactsByModule.set(mod, facts);
  return facts;
}

/** The exact interval of a widenable slot, as f64 bounds. Every value of an
 * integer at most 32 bits wide is an exact double, so these bounds are
 * exact and the comparisons below are not approximations. */
function nativeSlot(scalar: string): NativeSlot | null {
  switch (scalar) {
    case "i8": return { min: -128, max: 127, scalar };
    case "u8": return { min: 0, max: 255, scalar };
    case "i16": return { min: -32768, max: 32767, scalar };
    case "u16": return { min: 0, max: 65535, scalar };
    case "i32": return { min: -(2 ** 31), max: 2 ** 31 - 1, scalar };
    case "u32": return { min: 0, max: 2 ** 32 - 1, scalar };
    default: return null;
  }
}

function slotSeed(slot: NativeSlot): AbsVal {
  return absVal(slot.min, slot.max, true, false);
}

export type NumberCrossingVerdict = "certified" | "refused" | "unknown";

/** Decide one crossing. Certifying requires the whole abstract set to be
 * integral and inside the slot, NaN excluded — NaN lives outside the
 * interval and converts to nothing. Refusing requires the opposite proof:
 * a non-empty set of values none of which can convert. An empty set is
 * unreachable code, which needs neither a check nor a diagnostic. */
export function certifyNumberCrossing(v: AbsVal, slot: NativeSlot): NumberCrossingVerdict {
  if (isBottom(v)) return "certified";
  if (v.lo > v.hi) return v.maybeNaN ? "refused" : "certified";
  if (v.maybeNaN) return "unknown";
  if (v.whole && v.lo >= slot.min && v.hi <= slot.max) return "certified";
  if (v.hi < slot.min || v.lo > slot.max) return "refused";
  return "unknown";
}

function describeRefusedCrossing(v: AbsVal): string {
  if (v.lo > v.hi) return "the value is always NaN";
  if (isSingleton(v)) return `the value is always ${v.lo}`;
  return `the value is always in [${v.lo}, ${v.hi}]`;
}

/** Every function name the module can reach other than through the native
 * callback closures collected beside it. A parameter seed is an assumption
 * about how a function is entered, so it is admissible only when the
 * callback arguments are the only way in. */
function referencesOutsideCallbacks(
  mod: IrModule,
  candidates: ReadonlySet<string>,
  callbackUses: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  if (candidates.size === 0) return new Set();
  /* Embedded npm sources are program text, not IR, and cannot name an IR
   * function; excluding them keeps this scan proportional to the code the
   * compiler actually lowered. */
  const { embedded: _embedded, ...structure } = mod;
  const serialized = JSON.stringify(structure);
  const excluded = new Set<string>();
  for (const name of candidates) {
    const needle = JSON.stringify(name);
    let count = 0;
    let at = serialized.indexOf(needle);
    while (at !== -1) {
      count++;
      at = serialized.indexOf(needle, at + needle.length);
    }
    /* One occurrence is the definition itself; the rest must be exactly
     * the callback closures that justified the seed. */
    if (count !== 1 + (callbackUses.get(name) ?? 0)) excluded.add(name);
  }
  return excluded;
}

/** Walk every node of the module's function bodies. Deliberately
 * reflective: this pre-pass only looks for one expression kind, and an IR
 * node shape it has never heard of must not hide one. */
function walkBodyNodes(node: unknown, visit: (node: { kind: string }) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkBodyNodes(item, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const kind = (node as { kind?: unknown }).kind;
  if (typeof kind === "string") visit(node as { kind: string });
  for (const [key, value] of Object.entries(node)) {
    // Types carry their own `kind` and hold no expressions.
    if (key === "type" || key === "loc") continue;
    walkBodyNodes(value, visit);
  }
}

/** The seeds a native callback's handler may assume for its parameters: a
 * source parameter the delivery widens arrives already inside the physical
 * slot it was read from. */
function callbackParameterSeeds(
  mod: IrModule,
  bindings: ReadonlyMap<string, IrNativeBinding>,
): ReadonlyMap<string, readonly (AbsVal | null)[]> {
  const seeds = new Map<string, (AbsVal | null)[]>();
  const callbackUses = new Map<string, number>();
  const disagreed = new Set<string>();

  walkBodyNodes(mod.functions, (node) => {
    if (node.kind !== "nativeCall") return;
    const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
    const binding = bindings.get(call.binding);
    if (binding === undefined) return;
    binding.arguments.forEach((argument, index) => {
      if (argument.type.kind !== "func") return;
      const value = call.args[index];
      if (value?.kind !== "closure") return;
      const physical = physicalCallbackSlots(binding, index);
      const vector = argument.type.params.map((parameter, position) =>
        parameter.kind === "f64" ? physical[position] ?? null : null
      );
      callbackUses.set(value.fnName, (callbackUses.get(value.fnName) ?? 0) + 1);
      const previous = seeds.get(value.fnName);
      if (previous === undefined) {
        seeds.set(value.fnName, vector);
        return;
      }
      /* Two registrations of one handler must agree, or neither seed is
       * an assumption every entry satisfies. */
      if (
        previous.length !== vector.length ||
        previous.some((entry, position) => {
          const next = vector[position] ?? null;
          return entry === null
            ? next !== null
            : next === null || !sameVal(entry, next);
        })
      ) {
        disagreed.add(value.fnName);
      }
    });
  });

  for (const name of disagreed) seeds.delete(name);
  for (const name of referencesOutsideCallbacks(mod, new Set(seeds.keys()), callbackUses)) {
    seeds.delete(name);
  }
  return seeds;
}

/** The physical slot behind each source parameter of one callback
 * argument, indexed by source position. A widened source parameter reads
 * the exact scalar the trampoline stored, so that scalar's interval is the
 * seed; every other position contributes nothing. */
function physicalCallbackSlots(
  binding: IrNativeBinding,
  argument: number,
): readonly (AbsVal | null)[] {
  const carrier = binding.parameters.find(
    (parameter) =>
      parameter.projection.kind === "callbackFunction" &&
      parameter.projection.argument === argument,
  );
  const contract = binding.arguments[argument]?.callback;
  if (carrier?.type.kind !== "nativeCallback" || contract === undefined) return [];
  const physical = carrier.type.signature.parameters;
  return contract.sourceArguments.map((source) => {
    if (source.kind !== "callback-parameter") return null;
    const slotType = physical[source.parameter];
    const slot = slotType?.kind === "nativeScalar" ? nativeSlot(slotType.scalar) : null;
    return slot === null ? null : slotSeed(slot);
  });
}

function nativeBoundaryContext(mod: IrModule): NativeBoundaryContext {
  const bindings = new Map(
    (mod.nativeBindings ?? []).map((binding) => [binding.id, binding] as const),
  );
  const structs = new Map<string, IrNativeStructDef>();
  for (const definition of mod.nativeTypes ?? []) {
    if (definition.kind === "struct") structs.set(definition.id, definition);
  }
  return {
    bindings,
    /* An FFI import taking a function pointer is the same hazard: the C
     * side may keep it and call it back during an unrelated call. */
    reentrant: moduleUsesRetainedCallbacks(mod) ||
      (mod.ffiImports ?? []).some((entry) =>
        entry.params.some((parameter) => isFfiCallbackParam(parameter))
      ),
    structs,
    callbackSeeds: callbackParameterSeeds(mod, bindings),
    certified: new Map(),
    unproven: new Map(),
    refusals: [],
  };
}

function computeNumberBoundaryFacts(mod: IrModule): NumberBoundaryFacts {
  const native = nativeBoundaryContext(mod);
  const bindings = native.bindings;
  const projects = [...bindings.values()].some((binding) =>
    binding.parameters.some((parameter) => parameter.projection.kind === "number")
  );
  if (!projects) return EMPTY_BOUNDARY_FACTS;

  const effects = globalEffectsOf(mod);
  const cfg: IntSlotConfig = { fns: new Map(), records: new Map() };
  const globalSeeds = constantNumberGlobals(mod);
  for (const fn of mod.functions) {
    const analyzer = new FnAnalyzer(mod, cfg, effects, [], native, globalSeeds);
    analyzer.seedBindings(fn, mod);
    analyzer.analyze(fn);
  }

  const certified = new Map<IrExpr, ReadonlySet<number>>();
  for (const [call, parameters] of native.certified) {
    const unproven = native.unproven.get(call);
    const proven = unproven === undefined
      ? parameters
      : new Set([...parameters].filter((parameter) => !unproven.has(parameter)));
    if (proven.size > 0) certified.set(call, proven);
  }
  const seen = new Set<string>();
  const refusals = native.refusals.filter((refusal) => {
    const key = `${refusal.binding}#${refusal.parameter}@${refusal.loc.file}:${refusal.loc.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Object.freeze({ certified, refusals: Object.freeze(refusals) });
}
