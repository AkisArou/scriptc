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
  /* An i32 constant a generated surface would declare as `number`, because a
   * brand does not change what the primitive maps to. */
  const count: number;
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

/* A class MERGED with an ambient namespace, which is how a class carrying
 * compile-time constants projects. The constructor above must keep resolving:
 * a namespace supplies no call declaration and no body, exactly as a merged
 * interface does not. */
export declare namespace NativeCounter {
  const step: i32;
  /* A NESTED class, which is how a platform's inner class projects
   * (`View$OnClickListener` as `View.OnClickListener`). Its declaration name is
   * dotted, and a nested class lives on the VALUE side of the merged symbol —
   * the instance type has no such property. */
  class Nested {
    private readonly nested: unique symbol;
  }
}

export declare function makeNested(initialValue: i32): NativeCounter.Nested;

/* A native class a TypeScript class may EXTEND. The platform shape: the
 * framework constructs the object and calls a member on it, so the program
 * declares the member rather than registering a function, and `this` is the
 * object the framework made. */
export declare class TickSource {
  value(): i32;
  /* What `super.onTick(...)` reaches. Declared on the base because that is
   * where the base implementation lives; the manifest names the binding. */
  baseTick(seed: i32): void;
  /* The member a subclass overrides. A platform base really does declare its
   * lifecycle members — Activity declares onCreate — so `override` is legal
   * for the ordinary TypeScript reason rather than by special arrangement. */
  onTick(seed: i32): void;
}
/* An object the runtime may NOT intern: its identity arm is `none`, because a
 * platform whose references cannot be compared for identity has no pointer to
 * key a cell by. Two acquisitions of the same object are two managed values,
 * and `===` between them is false where the platform's own equality is true. */
export declare class Token {
  value(): i32;
  dispose(): void;
}
export declare function tokenAcquire(): Token;
/* The SAME object as `Token`, under the other identity arm: `pointer`, so the
 * runtime interns it and two acquisitions are ONE managed value. */
export declare class Shared {
  dispose(): void;
}
export declare function sharedAcquire(): Shared;
export declare function tokenOutstanding(): i32;
/* A native base whose object receives TWO lifecycle dispatches, and which
 * carries a slot for a managed peer. Its identity arm is `none`, so the two
 * dispatches arrive as two distinct cells — which is what makes an instance
 * field a question about the OBJECT rather than about the cell. */
export declare class Host {
  /* Inherited, and reached through `this` from inside an override — which is
   * what proves a peer still reaches its handle. */
  report(value: i32): void;
  onOpen(seed: i32): void;
  onSettle(): void;
}
/* The generated platform class that is actually delivered. It is not the
 * source base: this distinction pins the slot to the object that owns it. */
export declare class HostReceiver extends Host {}
export declare function hostRun(seed: i32): i32;
export declare function hostOutstanding(): i32;
export declare function tickMark(): void;

/* Declared by the surface, mapped to NO handle type — a selection short a
 * type, which is the shape a packaging bug takes. Nothing may bind to it; it
 * exists so a class can try to extend it and be told why it cannot. */
export declare class UnmappedSource {
  /* A member that DOES bind, so the import resolves and the class reaches the
   * heritage check. Without it the name has nothing native at all and the
   * external-module check refuses first, which is a different fact. */
  value(): i32;
  onTick(seed: i32): void;
}

export declare function tickFire(seed: i32): i32;
export declare function useNested(nested: NativeCounter.Nested): i32;

/* Reports failure by returning an owned error object rather than a code, the
 * shape a C error object takes once an adapter has absorbed its
 * out-parameter. */
export declare function errorHandleFail(code: i32): void;
/** Fails through a trailing out-parameter, so the quotient survives. */
export declare function errorOutDivide(numerator: i32, divisor: i32): i32;
export declare function errorOutU8(value: i32): u8;
export declare function errorOutI8(value: i32): i8;
/** Fails through a trailing out-parameter and hands back an owned string when
 * it succeeds, so the result means something on the path that has one. */
export declare function errorOutLabel(code: i32): string;
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
/* UTF-8 text arriving as a pointer and a length rather than a terminator, so
 * the bytes may contain NUL. The fixture's label does. */
export declare function spanLabel(): string;
export declare function spanLabelMaybe(which: i32): string | null;
export declare function createCounter(initialValue: i32): Counter;
/* A constructor-shaped result whose capsule can provide either a stable
 * reference or a frame-bounded one. The source type deliberately does not
 * expose that representation choice. */
export declare function createFrameCounter(initialValue: i32): Counter;
export declare function frameResourceReset(): void;
export declare function frameGlobalPromotions(): i32;
export declare function frameLocalReleases(): i32;
export declare function frameManagedCells(): i32;
export declare function frameExpectedManagedCells(expected: i32): i32;
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

/* Two synchronous registrations that hand the handler an OBJECT while it runs
 * inside the caller's frame — the pair neither delivery shape could express
 * before. The counter is the handler's: it arrives with a reference, and the
 * cell that receives it is what gives that reference back. */
export interface Teller {
  /* Invokes the handler and then reads its mark, so a delivery that arrived
   * on a later turn answers 0 where the truth is 1. */
  tell(seed: i32): i32;
  dispose(): void;
}
export declare function tellWith(callback: (subject: Counter) => void): Teller;
export declare function tellMark(): void;

/* A registration nothing owns — no handle comes back, and nothing can cancel
 * it, because there is no receiver whose lifetime bounds it. */
export declare function noticeWith(callback: (subject: Counter) => void): void;
export declare function noticeMark(): void;
export declare function noticeFire(seed: i32): i32;

/* The same telling registration where the payload may be ABSENT: the handler
 * receives `Counter | null` and tests it, because a framework that hands a
 * lifecycle an object on one call and nothing on another is describing a
 * value rather than a failure. */
export declare function maybeWith(callback: (subject: Counter | null) => void): void;
export declare function maybeMark(): void;
export declare function maybeFire(seed: i32): i32;

/* The `onKeyDown` shape: answers a boolean while holding both a scalar and an
 * object. */
export interface Judge {
  ask(code: i32, seed: i32): i32;
  /* The same question where the subject may be absent. */
  askMaybe(code: i32, seed: i32): i32;
  dispose(): void;
}
export declare function judgeWith(
  callback: (code: i32, subject: Counter) => boolean,
): Judge;

/* The owner-scoped withheld payload: answers while holding a subject that may
 * not be there, and the receiver's disposal is what cancels it. */
export declare function maybeJudgeWith(
  callback: (code: i32, subject: Counter | null) => boolean,
): Judge;

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
/** A span of a WIDER element, where a length counting elements and one
 * counting bytes differ by four. */
export declare function i32SpanMake(count: i32): Int32Array;
/** Answers the BYTE length it was handed, so which count crossed is
 * observable rather than assumed. */
export declare function i32SpanBytes(data: Int32Array): i32;
/** Answers NULL where the contract says a span. Its failure is the contract
 * violation becoming a catchable error. */
export declare function bytesAbsent(): Uint8Array;
/** A byte span the caller owns, reversed, whose length arrives beside the
 * pointer. Freed through the symbol the binding names once copied. */
export declare function bytesReverse(data: Uint8Array): Uint8Array;
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
