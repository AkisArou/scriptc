// @dynamic
// The jsval→DOM crossing over a REAL package surface (the prettier
// plugins shape from the world-unification design): island values
// flowing into 'unknown' slots wrap by reference — typeof, truthiness,
// String(), and === route to the engine, the identity round trip
// answers the same engine value back, and engine scalars normalize to
// native DOM kinds at wrap time.
import { plugins, obj, scalars } from "plugstub";

// Row 1: typeof through the wrap — "object" (the retired fence box
// answered "function" here, a silent wrong answer).
const u: unknown = plugins;
console.log("typeof plugins:", typeof u);

// Rows 2-3 on a wrapped element: truthiness, String(), engine ===.
const first: unknown = plugins[0];
console.log("truthy:", first ? "yes" : "no");
const uo: unknown = obj;
console.log("str:", String(uo));
const uo2: unknown = obj;
console.log("two wraps ===:", uo === uo2, "cross ===:", uo === first);

// The identity round trip: unknown → any is the SAME engine value.
function isSamePlugins(v: any): boolean {
  return v === plugins;
}
console.log("round trip:", isSamePlugins(u));

// Engine scalars normalize at the wrap: native DOM kinds all the way.
const n: unknown = scalars.n;
const s: unknown = scalars.s;
const b: unknown = scalars.b;
const nul: unknown = scalars.nul;
const und: unknown = scalars.und;
console.log(typeof n, typeof s, typeof b, typeof nul, typeof und);
console.log(n === 5, s === "hi", b === true, nul === null, und === undefined);

// Narrowing stays representation-free over wrapped values.
console.log(Array.isArray(u), Array.isArray(uo), typeof u === "object");
