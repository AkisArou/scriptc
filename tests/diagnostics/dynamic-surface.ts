// The island-backed ambient surface (Math beyond the static members,
// number methods, string-pattern replace/at, the Number statics, ...)
// typechecks against real static types but executes in the embedded
// engine: in a static build every use site is its own SC2012 naming the
// flag — never an ICE, never a link error. (Math.floor/abs/round,
// .split(string), the trim/pad variants, parseInt, isNaN, and the global
// parseFloat/isFinite over exactly-typed arguments compile statically
// now and no longer appear here.)
const up = Math.ceil(1.2);
const tau = Math.PI * 2;
const price = (19.99).toFixed(2);
const swapped = "banana".replace("an", "AN");
const ch = "hello".at(0);
const n = Number.parseFloat("3.14");
