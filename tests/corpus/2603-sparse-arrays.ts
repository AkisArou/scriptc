// Sparse arrays retain length independently from indexed-property presence.
const a: (number | undefined)[] = new Array(5);
a[1] = 10;
a[3] = undefined;
console.log("new", a.length, 0 in a, 1 in a, 3 in a, 4 in a, a.join("|"));
console.log("keys", Object.keys(a).join(","), Object.hasOwn(a, 0), Object.hasOwn(a, 1));
const jsonNumbers: number[] = new Array(3);
jsonNumbers[1] = 2;
console.log("json", JSON.stringify(jsonNumbers));

let maps = 0;
const mapped = a.map((v, i) => {
  maps++;
  return v === undefined ? i : v + i;
});
console.log("map", maps, mapped.length, 0 in mapped, 1 in mapped, 3 in mapped);

let visits = 0;
a.forEach(() => visits++);
const filtered = a.filter((v): boolean => v === undefined);
console.log("hof", visits, filtered.length, filtered[0] === undefined);

const sliced = a.slice(1, 5);
console.log("slice", sliced.length, 0 in sliced, 1 in sliced, 2 in sliced, 3 in sliced);
delete sliced[0];
console.log("delete", sliced.length, 0 in sliced, sliced.join(","));

let iter = "";
for (const value of a) iter += value === undefined ? "u" : String(value);
console.log("iter", iter);

const called: (string | undefined)[] = Array<string | undefined>(3);
called[2] = "x";
console.log("call", called.length, 0 in called, 2 in called, called.join("-"));

const literal: (number | undefined)[] = [1, , undefined];
console.log("literal", 0 in literal, 1 in literal, 2 in literal, literal.join(","));

literal.length = 1;
literal.length = 4;
console.log("length", literal.length, 0 in literal, 1 in literal, literal.join("|"));

const holes: number[] = new Array(3);
let skipped = 0;
console.log("pred", holes.some(() => { skipped++; return true; }), holes.every(() => { skipped++; return false; }), skipped);
console.log("reduce-init", holes.reduce((sum, value) => sum + value, 7));
try {
  holes.reduce((sum, value) => sum + value);
} catch (error) {
  console.log("reduce-empty", (error as Error).message);
}

const enumerable: (number | undefined)[] = new Array(4);
enumerable[1] = 2;
enumerable[3] = undefined;
let sparseKeys = "";
for (const key in enumerable) sparseKeys += key;
console.log("for-in-holes", sparseKeys);

try {
  const invalid: number[] = new Array<number>(-1);
  console.log(invalid.length);
} catch (error) {
  console.log("new-length-error", error instanceof RangeError, (error as Error).message);
}
try {
  enumerable.length = NaN;
} catch (error) {
  console.log("set-length-error", error instanceof RangeError, (error as Error).message, enumerable.length);
}

const sparseNumbers: number[] = new Array(5);
sparseNumbers[1] = 3;
sparseNumbers[3] = 1;
let reductions = 0;
console.log("reduce", sparseNumbers.reduce((sum, value) => { reductions++; return sum + value; }), reductions);
console.log("reduce-right", sparseNumbers.reduceRight((sum, value) => sum * 10 + value, 0));

let flatVisits = 0;
const flattened = sparseNumbers.flatMap((value) => {
  flatVisits++;
  return [value, , value + 10];
});
console.log("flatMap", flatVisits, flattened.join(","), flattened.length);

const concatTail: (number | undefined)[] = new Array(3);
concatTail[1] = 20;
const concatenated = a.concat(concatTail, undefined);
console.log("concat", concatenated.length, 0 in concatenated, 5 in concatenated, 6 in concatenated, 7 in concatenated, 8 in concatenated);

sparseNumbers.sort((x, y) => x - y);
console.log("sort-presence", sparseNumbers.length, 0 in sparseNumbers, 1 in sparseNumbers, 2 in sparseNumbers, 4 in sparseNumbers);
console.log("sort", sparseNumbers[0], sparseNumbers[1]);

// ES2023 copying methods read through holes (Get): union-backed holes
// densify to present undefined; sort/toSorted sink undefineds past values
// without calling the comparator, holes last (deleted in place, undefined
// in the dense copy).
const src: (number | undefined)[] = [1, , undefined, 4];
const rev = src.toReversed();
console.log("toReversed", rev.length, 0 in rev, 1 in rev, 2 in rev, 3 in rev, rev.join(","));
const spl = src.toSpliced(1, 1, 9);
console.log("toSpliced", spl.length, 1 in spl, 2 in spl, spl.join(","));
const wth = src.with(0, 9);
console.log("with", wth.length, 1 in wth, 2 in wth, wth[1], wth.join(","));
let cmpCalls = 0;
const mixed: (number | undefined)[] = [undefined, 3, , 1, undefined, , 2];
const dense = mixed.toSorted((x, y) => { cmpCalls++; return (x as number) - (y as number); });
console.log("toSorted", dense.length, dense.join(","), 3 in dense, 6 in dense, dense[4] === undefined);
mixed.sort((x, y) => (x as number) - (y as number));
console.log("sort", mixed.join(","), 2 in mixed, 4 in mixed, 6 in mixed, mixed[3] === undefined);
console.log("cmp-suppressed", cmpCalls <= 6);

// pop() reads through the hole: undefined, length shrinks.
const tail: (string | undefined)[] = ["x", ,];
console.log("pop", tail.pop(), tail.length, tail.pop(), tail.length);
