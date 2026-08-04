import assert from "node:assert";

// Static deep equality compares indexed-property presence before values. Two
// scalar holes never reach an unrepresentable arrayGet, while a hole remains
// distinct from a present undefined in an undefined-capable array.
const scalarHolesA: number[] = new Array(3);
const scalarHolesB: number[] = new Array(3);
assert.deepStrictEqual(scalarHolesA, scalarHolesB);
scalarHolesB[1] = 0;
assert.notDeepStrictEqual(scalarHolesA, scalarHolesB);

const unionHole: (number | undefined)[] = new Array(1);
const unionUndefined: (number | undefined)[] = new Array(1);
unionUndefined[0] = undefined;
assert.notDeepStrictEqual(unionHole, unionUndefined);
console.log("deep-presence", Object.keys(scalarHolesA).length, 0 in unionHole, 0 in unionUndefined);

// In-place sort works privately until all comparisons succeed. Comparator
// observation sees the original receiver, and a throw commits no writes.
const observed = [3, 1, 2];
let receiverStayedOriginal = true;
observed.sort((a, b) => {
  receiverStayedOriginal = receiverStayedOriginal && observed.join(",") === "3,1,2";
  return a - b;
});
console.log("sort-observe", receiverStayedOriginal, observed.join(","));

const throwing = [4, 2, 3];
let caught = false;
try {
  throwing.sort((_a, _b): number => {
    throw new Error("stop sort");
  });
} catch (error) {
  caught = error instanceof Error && error.message === "stop sort";
}
console.log("sort-throw", caught, throwing.join(","));

const sparseSort: number[] = new Array(5);
sparseSort[1] = 3;
sparseSort[3] = 1;
const sparseKeys = Object.keys(sparseSort).join(",");
try {
  sparseSort.sort((_a, _b): number => {
    throw new Error("sparse stop");
  });
} catch {}
console.log("sparse-throw", Object.keys(sparseSort).join(",") === sparseKeys, sparseSort.length);
sparseSort.sort((a, b) => a - b);
console.log("sparse-commit", sparseSort.join(","), Object.keys(sparseSort).join(","), sparseSort.length);

// at has an undefined-capable result even when the element slot is scalar,
// so a presence miss returns that result arm without touching the slot.
const scalarAt: number[] = new Array(2);
scalarAt[1] = 7;
console.log("at-hole", scalarAt.at(0) === undefined, scalarAt.at(1), scalarAt.at(-2) === undefined);

// Undefined-capable element storage supports Get-based callback visits to
// holes directly.
const searchable: (number | undefined)[] = new Array(3);
searchable[2] = 5;
let visits = "";
const holeIndex = searchable.findIndex((value, index) => {
  visits += `${index}${value === undefined ? "u" : "v"}`;
  return value === undefined;
});
const lastHole = searchable.findLastIndex((value) => value === undefined);
console.log("find-holes", holeIndex, lastHole, visits);

// Packed provenance discharges scalar Get fences through a direct parameter,
// for-of, spread, and toSorted.
function firstEven(values: number[]): number {
  return values.findIndex((value) => value % 2 === 0);
}
const packed = [3, 2, 1];
let packedSum = 0;
for (const value of packed) packedSum += value;
const packedCopy = [...packed];
console.log("packed", firstEven(packed), packedSum, packedCopy.join(","), packed.toSorted((a, b) => a - b).join(","));
