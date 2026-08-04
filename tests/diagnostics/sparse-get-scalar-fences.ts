const scalarHoles: number[] = new Array(3);
// Direct Get-based methods cannot materialize undefined in number slots.
scalarHoles.find((value) => value > 0);
scalarHoles.findIndex((value) => value > 0);
scalarHoles.findLast((value) => value > 0);
scalarHoles.findLastIndex((value) => value > 0);
// Iteration and spread have the same read-through-holes behavior.
for (const value of scalarHoles) console.log(value);
const copied = [...scalarHoles];
console.log(copied.length);

function takeAll(...values: number[]): number {
  return values.length;
}
takeAll(...scalarHoles);
Math.max(...scalarHoles);
String.fromCharCode(...scalarHoles);
// Copying sort reads through holes and produces present undefined entries.
scalarHoles.toSorted((a, b) => a - b);
// A later write cannot make this earlier Get safe.
const writtenLater = new Array<number>(2);
writtenLater.find((value) => value > 0);
writtenLater[0] = 1;

// Dense construction is safe even with scalar element storage.
const denseLiteral = [3, 1, 2];
denseLiteral.find((value) => value > 0);
for (const value of denseLiteral) console.log(value);
console.log([...denseLiteral].length, denseLiteral.toSorted((a, b) => a - b).length);

const filled = new Array<number>(3);
filled[0] = 0;
filled[1] = 0;
filled[2] = 0;
filled.find((value) => value > 0);
for (const value of filled) console.log(value);
console.log([...filled].length, filled.toSorted((a, b) => a - b).length);

// Parameters and other unknown provenance retain historical lowering.
function readUnknown(values: number[]): void {
  values.find((value) => value > 0);
  for (const value of values) console.log(value);
  console.log([...values].length, values.toSorted((a, b) => a - b).length);
}
