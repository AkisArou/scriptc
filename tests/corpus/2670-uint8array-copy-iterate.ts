// Uint8Array copying methods, array conversion/destructuring, iterator
// projections, and join. Every output is compared byte-for-byte with Node 24.

const source = new Uint8Array([5, 1, 4, 1, 3]);
const ascending = source.toSorted((a, b) => a - b);
console.log(ascending.join(","), source.join(","));
console.log(source.toSorted().join(","));
console.log(source.toSorted(undefined).join(","));
console.log(source.toReversed().join(","), source.join(","));
console.log(source.with(1, -1).join(","), source.join(","));
console.log(source.with(-1, 260).join(","));
console.log(source.with(1.9, 8).join(","));
console.log(source.with(NaN, 9).join(","));

const snapshotSource = new Uint8Array([3, 1, 2]);
const snapshotSorted = snapshotSource.toSorted((a, b) => {
  snapshotSource[0] = 0;
  return a - b;
});
console.log(snapshotSorted.join(","), snapshotSource.join(","));

for (const index of [source.length, -source.length - 1, Infinity]) {
  try {
    source.with(index, 0);
  } catch (err) {
    const e = err as Error;
    console.log(e.name, e.message);
  }
}

const spread = [...source];
spread[0] = 99;
console.log(spread.join(","), source.join(","));

const [a, b, , d] = source;
console.log(a, b, d);

for (const [i, value] of source.entries()) console.log("entry", i, value);
for (const key of source.keys()) console.log("key", key);
for (const value of source.values()) console.log("value", value);

const values = source.values();
let sum = 0;
for (const value of values) sum += value;
console.log("sum", sum);

console.log(new Uint8Array().join("-"));
console.log(source.join(), source.join(undefined), source.join("-"), source.join(""));
