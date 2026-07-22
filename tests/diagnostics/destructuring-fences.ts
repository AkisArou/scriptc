// Destructuring now lowers defaults in every position (tuple, array with
// the bounds test, record fields, nested patterns, whole-pattern and
// rest-pattern parameters), rest in every declaration position (array
// slices, tuple tails pack fresh, object rest copies the unconsumed
// fields), assignment-position patterns over static sources, and for-of
// expression heads. What stays fenced is the honest residue:
// class-instance sources (accessors make the desugar observable), union
// sources (narrow first), object patterns over arrays, index-signature
// rest packing, and assignment targets that are not writable variables.

class C {
  f = 1;
}
const { f } = new C();

interface E1 {
  kind: "one";
  b: string;
  count: number;
}
interface E2 {
  kind: "two";
  b: string;
  label: string;
}
function fromUnion(u: E1 | E2): string {
  const { b } = u; // union source: narrow first
  return b;
}
console.log(fromUnion({ kind: "one", b: "s", count: 1 }));

const xs = [1, 2, 3];
const { length: len } = xs; // object patterns over arrays keep the fence
console.log(len);

const indexed: Record<string, number> = { a: 1 };
const { ...allOfIt } = indexed; // index-signature rest needs overflow packing
console.log(allOfIt["a"]);

const holder = { inner: { v: 1 } };
let sink = 0;
({ inner: { v: sink } } = holder); // nested assignment targets keep the fence
console.log(sink);
