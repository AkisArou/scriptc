// The assert surface's honest fences: the loose == quartet (assert's own
// equal/deepEqual — assert/strict's same-named members ARE the strict
// comparisons and lower), reference-equality strictEqual on objects,
// union operands (narrow first), mismatched or uncomparable deep types
// (typed arrays, class instances), namespace-object calls, unsupported
// throws/rejects expectations (properties outside the static error
// surface, empty shapes, non-literal objects, doesNotReject shapes —
// Node's own TypeError), ifError over uncomparable types, and assert
// functions as values. Every reached site terminates in a named
// diagnostic — never a miscompare, never silence.
import assert from "node:assert";
import * as assertNs from "node:assert";

assert.equal(1, 1); // loose == — points at the strict forms
assert.notEqual(1, 2);
assert.deepEqual([1], [1]);
assert.notDeepEqual([1], [2]);

const box = { n: 1 };
assert.strictEqual(box, box); // reference equality — deepStrictEqual hint

let maybe: string | undefined = "x";
if ("x".length === 0) maybe = undefined;
assert.strictEqual(maybe, "x"); // union operand — narrow first

const unk: unknown = JSON.parse("{}");
assert.strictEqual(unk, { n: 1 }); // strict + composite static side: reference identity does not survive the unknown boundary
assert.deepStrictEqual(unk, new Uint8Array([1])); // bytes static side: the DOM copy cannot carry the brand
assert.deepStrictEqual(unk, new Map<string, number>()); // not DOM-convertible

assert.deepStrictEqual([1, 2], ["a", "b"]); // different static types
assert.deepStrictEqual([new Uint8Array([1])], [new Uint8Array([1])]); // NESTED typed arrays fence (no brand in the element type)
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
assert.deepStrictEqual(new Point(1), new Point(1)); // class instances fence

assertNs(true); // namespace objects are not callable in Node

assert.throws(() => { throw new Error("x"); }, { errno: -2 }); // properties outside the static error surface
assert.throws(() => { throw new Error("x"); }, {}); // Node rejects the empty shape
const shapeValue = { name: "TypeError" };
assert.throws(() => { throw new Error("x"); }, shapeValue); // non-literal expected objects
void assert.doesNotReject(async () => {}, { name: "TypeError" }); // Node's own TypeError (function or RegExp only)
assert.ifError(new Map<string, number>()); // no honest ifError rendering for this type

const eq = assert.strictEqual; // assert functions as values
eq(1, 1);
