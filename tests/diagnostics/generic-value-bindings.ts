// Generic function VALUE fences, named: every shape here keeps the generic
// signature alive where static monomorphization cannot follow.

// A reassigned binding cannot resolve statically — a later write could hold
// a structurally identical function with a different body.
let flip = <T>(x: T): T => x;
flip = <T>(x: T): T => x;
console.log(flip(1));

// A binding whose USES keep the generic signature: nothing pins a concrete
// signature, so the value fences at the reference.
const id = <T>(x: T): T => x;
const stored = id;
console.log(stored(2));

// Declared inside a function: instances are module functions and cannot
// capture the enclosing frame.
function outer(): number {
  const inner = <T>(x: T): T => x;
  return inner(3);
}
console.log(outer());

// An ambient binding of generic function type has no body to monomorphize.
declare const ambient: undefined | (<T>(f: (a: T) => T) => T);
console.log(ambient?.((n: number) => n) === undefined);

// A call whose RESULT is itself a generic function: the returned signature
// keeps its type parameters and would need the producing call's frame.
const curried = <T>(x: T) => <U>(y: U): string => `${x}|${y}`;
console.log(curried(1)("a"));

// Ambient `declare class` generic methods are signature-only. Through an
// AMBIENT-ROOTED receiver the call now compiles to Node's ReferenceError
// at the root (the declare-const chain stance — no diagnostic here); a
// receiver that exists at runtime keeps the fence.
declare class Amb {
  m<T>(x: T): T;
}
declare const amb: Amb;
console.log(amb.m(4));
function throughParam(a: Amb): void {
  console.log(a.m(4));
}
throughParam(amb);

// A generic lambda outside any monomorphizable home (an IIFE).
console.log((<T>(x: T): T => x)(5));
