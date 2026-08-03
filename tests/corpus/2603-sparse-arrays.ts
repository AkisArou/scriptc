import assert from "node:assert";

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

const filledDuringForIn = [1, , 3];
let filledKeys = "";
for (const key in filledDuringForIn) {
  filledKeys += key;
  if (key === "0") filledDuringForIn[1] = 2;
}
console.log("for-in-fill-snapshot", filledKeys);

const deletedDuringForIn = [1, 2, 3];
let deletedKeys = "";
for (const key in deletedDuringForIn) {
  deletedKeys += key;
  if (key === "0") delete deletedDuringForIn[1];
}
console.log("for-in-delete-live", deletedKeys);

function inspectSparseUnknown(value: unknown): void {
  if (!Array.isArray(value)) return;
  console.log("unknown-sparse", typeof value, value.length, Object.keys(value).join(","), 0 in value, 1 in value, JSON.stringify(value));
  const first = "0";
  console.log("unknown-presence", first in value, Object.hasOwn(value, first), Object.hasOwn(value, "1"));
}
const sparseIntoUnknown: number[] = new Array(2);
sparseIntoUnknown[1] = 42;
inspectSparseUnknown(sparseIntoUnknown);

function inspectSparseMethods(value: unknown): void {
  if (!Array.isArray(value)) return;

  const sliced = value.slice();
  const concatenated = value.concat([9]);
  console.log("dyn-copy", Object.keys(sliced).join(","), JSON.stringify(sliced), Object.keys(concatenated).join(","), JSON.stringify(concatenated));

  let forEachVisits = "";
  value.forEach((_entry: unknown, index: number) => { forEachVisits += index; });
  let mapVisits = "";
  const mappedUnknown: unknown = value.map((_entry: unknown, index: number) => { mapVisits += index; return index; });
  if (!Array.isArray(mappedUnknown)) return;
  const mapped = mappedUnknown;
  let filterVisits = "";
  const filteredUnknown: unknown = value.filter((_entry: unknown, index: number) => { filterVisits += index; return index === 2; });
  if (!Array.isArray(filteredUnknown)) return;
  const filtered = filteredUnknown;
  let someVisits = "";
  const some = value.some((_entry: unknown, index: number) => { someVisits += index; return false; });
  let everyVisits = "";
  const every = value.every((_entry: unknown, index: number) => { everyVisits += index; return true; });
  console.log("dyn-hof", forEachVisits, mapVisits, Object.keys(mapped).join(","), JSON.stringify(mapped), filterVisits, JSON.stringify(filtered), someVisits, some, everyVisits, every);

  let findVisits = "";
  const found = value.find((entry: unknown, index: number) => { findVisits += `${index}${entry === undefined ? "u" : "v"}`; return index === 0; });
  let findIndexVisits = "";
  const foundIndex = value.findIndex((entry: unknown, index: number) => { findIndexVisits += `${index}${entry === undefined ? "u" : "v"}`; return index === 0; });
  console.log("dyn-search", value.includes(undefined), value.indexOf(undefined), value.lastIndexOf(undefined), found === undefined, findVisits, foundIndex, findIndexVisits);

  let flatVisits = "";
  const flatMappedUnknown: unknown = value.flatMap((_entry: unknown, index: number): unknown => {
    flatVisits += index;
    return [index, , index + 10];
  });
  if (!Array.isArray(flatMappedUnknown)) return;
  const flatMapped = flatMappedUnknown;
  console.log("dyn-flatMap", flatVisits, Object.keys(flatMapped).join(","), flatMapped.length, flatMapped.join(","));
  let typedFlatVisits = "";
  const typedFlatMapped: number[] = value.flatMap((_entry: unknown, index: number): number[] => {
    typedFlatVisits += index;
    const returned: number[] = new Array(3);
    returned[0] = index;
    returned[2] = index + 10;
    return returned;
  });
  console.log("dyn-flatMap-typed", typedFlatVisits, typedFlatMapped.length, typedFlatMapped.join(","));

  const sorted = value.slice();
  sorted.sort();
  console.log("dyn-sort", Object.keys(sorted).join(","), 2 in sorted, 3 in sorted, JSON.stringify(sorted));
  const shrinkSorted = value.slice();
  let shrinkComparisons = 0;
  shrinkSorted.sort((left: unknown, right: unknown) => {
    shrinkComparisons++;
    while (shrinkSorted.length > 0) shrinkSorted.pop();
    return (left as number) - (right as number);
  });
  console.log("dyn-sort-shrink", shrinkComparisons, shrinkSorted.length, Object.keys(shrinkSorted).join(","), JSON.stringify(shrinkSorted));
  const cloned = structuredClone(value);
  console.log("dyn-clone", Object.keys(cloned).join(","), JSON.stringify(cloned));
  assert.deepStrictEqual(cloned, value);
  const denseUndefined: unknown = [undefined, undefined, 3, undefined, 1, undefined];
  assert.notDeepStrictEqual(value, denseUndefined);
  console.log("dyn-deep hole-distinct");

  const popped = value.slice();
  const popResult = popped.pop();
  const shifted = value.slice();
  const shiftResult = shifted.shift();
  console.log("dyn-ends", popResult === undefined, popped.length, Object.keys(popped).join(","), shiftResult === undefined, shifted.length, Object.keys(shifted).join(","), value.at(0) === undefined);

  let iterated = "";
  for (const entry of value) iterated += entry === undefined ? "u" : "v";
  console.log("dyn-iterate", iterated);
  console.log("dyn-inspect", value);
}

const sparseMethods: (number | undefined)[] = new Array(6);
sparseMethods[1] = undefined;
sparseMethods[2] = 3;
sparseMethods[4] = 1;
inspectSparseMethods(sparseMethods);

function appendedCallbackVisits(kind: number): string {
  const initial: number[] = [1];
  const value: unknown = initial;
  if (!Array.isArray(value)) return "not-array";
  let visits = "";
  const append = (index: number): void => { visits += index; value.push(2); };
  if (kind === 0) value.forEach((_entry: unknown, index: number) => append(index));
  else if (kind === 1) value.map((_entry: unknown, index: number) => { append(index); return index; });
  else if (kind === 2) value.filter((_entry: unknown, index: number): boolean => { append(index); return true; });
  else if (kind === 3) value.some((_entry: unknown, index: number) => { append(index); return false; });
  else if (kind === 4) value.every((_entry: unknown, index: number) => { append(index); return true; });
  else if (kind === 5) value.find((_entry: unknown, index: number) => { append(index); return false; });
  else value.findIndex((_entry: unknown, index: number) => { append(index); return false; });
  return `${visits}:${value.length}`;
}
const appendVisits: string[] = [];
for (let method = 0; method < 7; method++) appendVisits.push(appendedCallbackVisits(method));
console.log("dyn-append-snapshot", appendVisits.join(","));

function deletionVisits(find: boolean): string {
  const initial = [1, 2];
  const value: unknown = initial;
  if (!Array.isArray(value)) return "not-array";
  let visits = "";
  const callback = (entry: unknown, index: number): boolean => {
    visits += `${index}${entry === undefined ? "u" : "v"}`;
    if (index === 0) value.pop();
    return false;
  };
  if (find) value.find(callback);
  else value.forEach(callback);
  return visits;
}
console.log("dyn-delete-live", deletionVisits(false), deletionVisits(true));

const twoHoles: number[] = new Array(3);
twoHoles[2] = 1;
const twoHolesUnknown: unknown = twoHoles;
const denseForMessage: unknown = [undefined, undefined, 1];
try {
  assert.deepStrictEqual(twoHolesUnknown, denseForMessage);
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.log("dyn-assert-holes", message.includes("<2 empty items>"), message.includes("undefined"));
}

function inspectExtractedSparse(numbersValue: unknown, unionValue: unknown, stringsValue: unknown): void {
  const numbers = numbersValue as number[];
  const union = unionValue as (number | string)[];
  const strings = stringsValue as string[];
  console.log("dyn-extract", numbers.length, Object.keys(numbers).join(","), JSON.stringify(numbers), Object.keys(union).join(","), JSON.stringify(union), Object.keys(strings).join(","), JSON.stringify(strings));
  numbers[0] = 9;
  strings[0] = "set";
  console.log("dyn-extract-set", 0 in numbers, numbers[0], 0 in strings, strings[0]);
}
const extractNumbers: number[] = new Array(3);
extractNumbers[1] = 5;
const extractUnion: (number | string)[] = new Array(3);
extractUnion[1] = "u";
extractUnion[2] = 7;
const extractStrings: string[] = new Array(2);
extractStrings[1] = "x";
inspectExtractedSparse(extractNumbers, extractUnion, extractStrings);

function applyHoleProbe(first: unknown): string {
  const targetValue: unknown = [];
  if (!Array.isArray(targetValue)) return "not-array";
  targetValue[0] = first;
  return `${first === undefined} ${Object.hasOwn(targetValue, 0)} ${0 in targetValue}`;
}
const applyProbeValue: unknown = applyHoleProbe;
const sparseApplyArgs: number[] = new Array(1);
if (typeof applyProbeValue === "function") {
  console.log("dyn-apply-hole", applyProbeValue.apply(null, sparseApplyArgs));
}

function inspectTupleHole(value: unknown): void {
  const tuple = value as [unknown];
  const targetValue: unknown = [];
  if (!Array.isArray(targetValue)) return;
  targetValue[0] = tuple[0];
  console.log("dyn-tuple-hole", tuple[0] === undefined, Object.hasOwn(targetValue, 0), 0 in targetValue);
  try {
    const required = value as [number];
    console.log(required[0].toFixed(0));
  } catch (error) {
    console.log("dyn-tuple-required", error instanceof TypeError);
  }
}
const sparseTupleSource: number[] = new Array(1);
inspectTupleHole(sparseTupleSource);

function inspectFunctionTuple(value: unknown): void {
  const tuple = value as [number | (() => number)];
  const item = tuple[0];
  console.log("dyn-tuple-function", typeof item, typeof item === "function" ? item() : item);
}
const functionTupleSource: unknown = [];
const boxedTupleFunction: unknown = (): number => 42;
if (Array.isArray(functionTupleSource)) functionTupleSource[0] = boxedTupleFunction;
inspectFunctionTuple(functionTupleSource);

type RecursiveCallable = number | (() => RecursiveCallable);
function recursiveCallable(): RecursiveCallable {
  return recursiveCallable;
}
function inspectRecursiveCallable(value: unknown): void {
  const tuple = value as [RecursiveCallable];
  const first = tuple[0];
  const second = typeof first === "function" ? first() : first;
  console.log("dyn-recursive-callable", typeof first, typeof second);
}
const recursiveTupleSource: unknown = [];
const recursiveCallableValue: unknown = recursiveCallable;
if (Array.isArray(recursiveTupleSource)) recursiveTupleSource[0] = recursiveCallableValue;
inspectRecursiveCallable(recursiveTupleSource);

type FunctionValue = number | (() => number);
function inspectFunctionComposites(arrayValue: unknown, recordValue: unknown): void {
  const array = arrayValue as FunctionValue[];
  const record = recordValue as { item: FunctionValue };
  const av = array[0];
  const rv = record.item;
  console.log("dyn-function-composites", typeof av === "function" ? av() : av, typeof rv === "function" ? rv() : rv);
}
const functionArraySource: unknown = [];
if (Array.isArray(functionArraySource)) functionArraySource[0] = boxedTupleFunction;
const functionRecordSource: Record<string, unknown> = { item: boxedTupleFunction };
inspectFunctionComposites(functionArraySource, functionRecordSource);

function inspectNestedTuple(value: unknown): void {
  const tuple = value as [[unknown]];
  const targetValue: unknown = [];
  if (!Array.isArray(targetValue)) return;
  targetValue[0] = tuple[0][0];
  console.log("dyn-tuple-nested", tuple[0][0] === undefined, Object.hasOwn(targetValue, 0), 0 in targetValue);
}
const nestedInnerStatic: number[] = new Array(1);
const nestedInner: unknown = nestedInnerStatic;
const nestedOuter: unknown = [];
if (Array.isArray(nestedOuter)) nestedOuter[0] = nestedInner;
inspectNestedTuple(nestedOuter);

function inspectLargeSparse(value: unknown, label: string): void {
  console.log(label, value);
}
const inspectHoles200: number[] = new Array(200);
inspectLargeSparse(inspectHoles200, "dyn-inspect-200");
const inspectMixed200: number[] = new Array(200);
inspectMixed200[99] = 1;
inspectMixed200[150] = 2;
inspectLargeSparse(inspectMixed200, "dyn-inspect-mixed");
const inspectBoundary101: number[] = new Array(101);
for (let i = 1; i < inspectBoundary101.length; i++) inspectBoundary101[i] = i;
inspectLargeSparse(inspectBoundary101, "dyn-inspect-boundary");
const clonedBareUndefined: undefined = structuredClone(undefined);
console.log("clone-bare-undefined", clonedBareUndefined === undefined);

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
