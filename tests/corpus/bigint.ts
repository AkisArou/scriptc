/* bigint: the value kind, its literals, ordering, conversions, and the
 * containers that hold it. Node is the oracle — every line below is a
 * byte-for-byte claim about V8's behavior, including the two throws.
 *
 * The arithmetic operators are deliberately absent: they refuse at compile
 * time until they are implemented, and a corpus program only holds what
 * compiles. */

/* ── literals ───────────────────────────────────────────────────────── */

const decimal: bigint = 42n;
const negative: bigint = -42n;
const zero: bigint = 0n;
const hex: bigint = 0xffn;
const octal: bigint = 0o17n;
const binary: bigint = 0b1011n;
const separated: bigint = 1_000_000n;
const wide: bigint = 123456789012345678901234567890n;
const beyondDouble: bigint = 9007199254740993n;

console.log(decimal, negative, zero, hex, octal, binary, separated);
console.log(wide);
console.log(beyondDouble);

/* Two spellings of one value are one value. */
console.log(0xffn === 255n, 0o17n === 15n, 0b1011n === 11n, 1_000_000n === 1000000n);
console.log(-0n === 0n);

/* ── typeof and truthiness ──────────────────────────────────────────── */

console.log(typeof decimal, typeof zero);
console.log(zero ? "truthy" : "falsy", decimal ? "truthy" : "falsy", negative ? "truthy" : "falsy");
console.log(!zero, !decimal);

/* ── equality and ordering ──────────────────────────────────────────── */

console.log(decimal === 42n, decimal === 43n, decimal !== 43n);
console.log(negative < zero, zero < decimal, decimal <= 42n, decimal >= 43n, wide > beyondDouble);
/* Ordering is exact at any magnitude — the whole reason the type exists.
 * Both of these are the same double. */
console.log(9007199254740993n > 9007199254740992n);

/* ── string conversion ──────────────────────────────────────────────── */

console.log(String(decimal), String(negative), String(zero), String(wide));
console.log(`${decimal} and ${negative} and ${wide}`);
console.log(decimal.toString(), wide.toString());
/* console.log/util.inspect keeps the `n`; String() and toString() do not. */
console.log([decimal, negative, zero]);
console.log({ id: wide, count: zero });

/* ── conversions across the number line ─────────────────────────────── */

console.log(Number(decimal), Number(negative), Number(zero));
/* Lossy by construction, round-to-nearest-ties-to-even against the exact
 * value — not a truncation and not an accumulation. */
console.log(Number(beyondDouble));
console.log(Number(wide));
console.log(Number(-123456789012345678901234567890n));

console.log(BigInt(7), BigInt(-7), BigInt(0));
console.log(BigInt(9007199254740992));
console.log(BigInt(1e30));
console.log(BigInt("123456789012345678901234567890"));
console.log(BigInt("  12  "), BigInt(""), BigInt("   "));
console.log(BigInt("0x1f"), BigInt("0o17"), BigInt("0b1011"), BigInt("+5"), BigInt("-5"));
console.log(BigInt(true), BigInt(false));
console.log(BigInt(42n) === 42n);

/* The two failures, both catchable, both with V8's own text. */
try {
  console.log(BigInt(1.5));
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message);
}
try {
  console.log(BigInt(NaN));
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message);
}
try {
  console.log(BigInt("abc"));
} catch (error) {
  console.log(error instanceof SyntaxError, (error as Error).message);
}
try {
  /* A radix prefix admits no sign. */
  console.log(BigInt("-0x1f"));
} catch (error) {
  console.log(error instanceof SyntaxError, (error as Error).message);
}
try {
  /* Numeric separators are literal syntax, not string syntax. */
  console.log(BigInt("1_0"));
} catch (error) {
  console.log(error instanceof SyntaxError, (error as Error).message);
}

/* ── bigints in the containers ──────────────────────────────────────── */

function identity(value: bigint): bigint {
  return value;
}
console.log(identity(5n), identity(wide));

const list: bigint[] = [3n, 1n, 2n];
console.log(list, list.length, list[0], list.includes(1n), list.indexOf(2n));

const record = { small: decimal, big: wide };
console.log(record.small, record.big);

let counter = 0n;
counter = wide;
console.log(counter);

/* A capture box holds one too. */
function held(): () => bigint {
  const captured: bigint = beyondDouble;
  return () => captured;
}
console.log(held()());

/* A union arm, narrowed the ordinary way. */
const maybe: bigint | undefined = 5n;
console.log(maybe === undefined ? "none" : String(maybe));
const absent: bigint | null = null;
console.log(absent === null);

class Holder {
  value: bigint = 0n;
}
const holder = new Holder();
holder.value = 9n;
console.log(holder.value, String(holder.value), holder);

console.log([1n, 2n].map((v) => String(v)).join("|"));
console.log([1n, 2n, 3n].filter((v) => v > 1n).length);

let total = 0;
for (const value of [1n, 2n, 3n]) total += Number(value);
console.log(total);

const [head, ...tail] = [7n, 8n, 9n];
console.log(head, tail);
