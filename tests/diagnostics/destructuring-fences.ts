// Destructuring now lowers defaults in every position (tuple, array with
// the bounds test, record fields, nested patterns, whole-pattern and
// rest-pattern parameters), rest in every declaration position (array
// slices, tuple tails pack fresh, object rest copies the unconsumed
// fields), assignment-position patterns over static sources, for-of
// expression heads, and CLASS-INSTANCE sources (fields and getters — one
// member read per element, corpus 2429). What stays fenced is the honest
// residue: rest elements and METHOD extraction over class instances (a
// detached method loses its receiver), setter-only properties, union
// sources (narrow first), object patterns over arrays, index-signature
// rest packing, and assignment targets that are not writable variables.

class C {
  f = 1;
  describe(): string {
    return `f=${this.f}`;
  }
  set onlyIn(v: number) {
    this.f = v;
  }
}
const { describe } = new C(); // method extraction keeps the fence
console.log(describe());
const { f, ...restOfC } = new C(); // rest over a class instance keeps the fence
console.log(f, Object.keys(restOfC).length);
const { onlyIn } = new C(); // tsc types the setter-only read; the fence names it
console.log(onlyIn);

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
