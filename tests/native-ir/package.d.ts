declare const nativeScalar: unique symbol;
declare const nativeCounterBaseResource: unique symbol;
declare const nativeCounterMiddleResource: unique symbol;
declare const nativeCounterResource: unique symbol;

export type i8 = number & { readonly [nativeScalar]: "i8" };
export type u8 = number & { readonly [nativeScalar]: "u8" };
export type i16 = number & { readonly [nativeScalar]: "i16" };
export type u16 = number & { readonly [nativeScalar]: "u16" };
export type i32 = number & { readonly [nativeScalar]: "i32" };
export type u32 = number & { readonly [nativeScalar]: "u32" };
export type i64 = bigint & { readonly [nativeScalar]: "i64" };
export type u64 = bigint & { readonly [nativeScalar]: "u64" };
export type usize = bigint & { readonly [nativeScalar]: "usize" };
export type f64 = number & { readonly [nativeScalar]: "f64" };

export declare namespace FixtureValue {
  const answer: i32;
  function combine(first: i32, ...rest: readonly i32[]): i32;
}

/* The conversions between an exact scalar and an ordinary number. They are
 * functions because no syntax names a direction, and they are named rather
 * than spelled `Number(v)` and `BigInt(n)` because JavaScript's conversions
 * mean something else: `Number` rounds silently where this one refuses, and
 * `BigInt` is arbitrary precision where this slot is 64 bits wide.
 *
 * Arithmetic needs no declaration: `(a / b) as i64` is an ordinary operator
 * expression inside the construction that names its exact type. */
export declare namespace i32 {
  function toNumber(value: i32): number;
  function fromNumber(value: number): i32;
}

export declare namespace u32 {
  function toNumber(value: u32): number;
  function fromNumber(value: number): u32;
}

export declare namespace i64 {
  function toNumber(value: i64): number;
  function fromNumber(value: number): i64;
}

export declare namespace u64 {
  function toNumber(value: u64): number;
  function fromNumber(value: number): u64;
}

export declare namespace f64 {
  function toNumber(value: f64): number;
  function fromNumber(value: number): f64;
}

export interface Padded {
  readonly tag: u8;
  readonly value: u64;
  readonly ratio: f64;
}

export interface Pair32 {
  readonly first: i32;
  readonly second: i32;
}

export interface PairF64 {
  readonly first: f64;
  readonly second: f64;
}

export interface NestedPair32 {
  readonly left: Pair32;
  readonly right: Pair32;
  readonly marker: i64;
}

export interface CounterBase {
  readonly [nativeCounterBaseResource]: true;
  value(): i32;
}

export interface CounterMiddle extends CounterBase {
  readonly [nativeCounterMiddleResource]: true;
}

export interface Counter extends CounterMiddle {
  readonly [nativeCounterResource]: true;
  add(delta: i32): i32;
  label(): string | null;
  requiredLabel(): string;
  /** A vector the receiver keeps: borrowed, so nothing is freed. */
  tags(): string[];
  dispose(): void;
}

/* Accepts an optional counter: null is a valid argument, not a failure. */
export declare function counterValueOr(counter: Counter | null, fallback: i32): i32;

/* The same over the base of the hierarchy, so a derived handle widens into
 * the optional slot rather than being refused by it. */
export declare function counterBaseValueOr(
  counter: CounterBase | null,
  fallback: i32,
): i32;

export interface Subscription {
  emit(value: i32): i32;
  emitForeign(value: i32): i32;
  dispose(): void;
}

export declare class NativeCounter {
  constructor(initialValue: i32);
  static withInitialValue(initialValue: i32): NativeCounter;
}

/* Reports failure by returning an owned error object rather than a code, the
 * shape a C error object takes once an adapter has absorbed its
 * out-parameter. */
export declare function errorHandleFail(code: i32): void;
/** Fails through a trailing out-parameter, so the quotient survives. */
export declare function errorOutDivide(numerator: i32, divisor: i32): i32;
export declare function fixtureErrorsOutstanding(): i32;

export declare function i8Identity(value: i8): i8;
export declare function u8Identity(value: u8): u8;
export declare function i16Identity(value: i16): i16;
export declare function u16Identity(value: u16): u16;
export declare function i32Identity(value: i32): i32;
export declare function u32Identity(value: u32): u32;
export declare function i64Identity(value: i64): i64;
export declare function u64Identity(value: u64): u64;
export declare function usizeIdentity(value: usize): usize;
export declare function nativeFalse(): boolean;
export declare function nativeInvalidBoolean(): boolean;
export declare function nativeNot(value: boolean): boolean;
export declare function nativeTrue(): boolean;
export declare function paddedRoundtrip(value: Padded): Padded;
export declare function pair32Transform(value: Pair32): Pair32;
export declare function pairF64Transform(value: PairF64): PairF64;
export declare function pairF64Verify(value: PairF64): i32;
export declare function nestedPair32Transform(value: NestedPair32): NestedPair32;
export declare function hashUtf8(value: string): u64;
export declare function cStringObserve(value: string): void;
export declare function nullableCStringObserve(value: string | null): i32;
export declare function hashBytes(value: Uint8Array): u64;
export declare function callScoped(
  callback: (value: i32) => i32,
  value: i32,
): i32;
export declare function failErrno(errorNumber: i32): never;
export declare function createCounter(initialValue: i32): Counter;
/* A callback the native side asks rather than tells: it runs during the
 * emitting call and the value it answers with is that call's result. */
export interface Asker {
  ask(value: i32): i32;
  asked(): i32;
  dispose(): void;
}
export declare function askFor(callback: (value: i32) => i32): Asker;

/* A callee that takes ownership of a handle argument. `adopt` consumes the
 * counter: the reference moves to the vault, and the handle is spent. */
export interface Vault {
  adopt(counter: Counter): void;
  value(): i32;
  dispose(): void;
}
export declare function createVault(): Vault;

/* The same question answered with an ordinary boolean. */
export declare function answerWith(callback: (value: i32) => boolean): Asker;

export declare function subscribe(
  callback: (value: i32) => void,
): Subscription;
export declare function subscribeNumber(
  callback: (value: number) => void,
): Subscription;
export declare function callScopedFloat(
  callback: (value: number) => i32,
  value: number,
): number;
export declare function callScopedNumber(
  callback: (value: number) => i32,
  value: number,
): number;
export declare function numberI32Identity(value: number): number;
export declare function numberU32Identity(value: number): number;
export declare function numberU8Identity(value: number): number;
export declare function numberI16Identity(value: number): number;
export declare function numberI64Identity(value: number): number;
export declare function numberUsizeIdentity(value: number): number;

/* Exact in, number out: reading a 64-bit slot as a number answers only when
 * the double denotes the same integer, and throws otherwise. */
export declare function wideToNumber(value: i64): number;
export declare function numberF64Identity(value: number): number;
export declare function numberF32Identity(value: number): number;
export interface NumberPair32 {
  readonly first: number;
  readonly second: number;
}
export declare function numberPair32Transform(value: NumberPair32): NumberPair32;

/** A call that fills storage and separately says whether it managed to. The
 * answer is a field rather than the result, because a call that reported
 * absence instead would throw away the value it looked at. */
export interface Answered {
  readonly answered: boolean;
  readonly value: number;
}
/** Reads a NUL-terminated vector built for this call alone. Answers
 * `total * 100 + count` so a wrong pointer and a wrong length are different
 * wrong answers. */
export declare function cstringArrayMeasure(items: readonly string[]): i32;
/** The same measurement where the vector may be absent. Answers -1 for the
 * absent vector, which is not the empty one. */
export declare function cstringArrayMeasureOptional(
  items: readonly string[] | null,
): i32;
/** The same measurement with a string beside the vector, so a program can put
 * a throwing conversion after a successful borrow. */
export declare function cstringArrayMeasureNamed(
  items: readonly string[],
  name: string,
): i32;
/** A string the caller owns, freed through the symbol the binding names once
 * its bytes have been copied. A negative count answers null. */
export declare function cstringMade(count: i32): string | null;
/** A vector the caller owns, freed through the symbol the binding names. A
 * negative count answers the absent vector, which is not the empty one. */
export declare function cstringArrayMade(count: i32): string[] | null;
export declare function answeredAbove(value: i32, threshold: i32): Answered;
/** What actually landed in the slot, so the write is observable and not only
 * the read. */
export declare function answeredRaw(value: Answered): i32;
export declare function counterDestroyedCount(): i32;
export declare function counterVerify(
  actualValue: i32,
  actualDestroyed: i32,
  expectedValue: i32,
  expectedDestroyed: i32,
): i32;
