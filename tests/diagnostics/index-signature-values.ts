// SC2006: index-signature object types outside the supported shape.
// String- and number-keyed signatures over the supported value types
// compile; these do not.

// A symbol-keyed signature has no lowering.
const bySymbol: { [s: symbol]: number } = {};
console.log(bySymbol);

// A function-valued signature is outside the value domain.
const handlers: Record<string, () => void> = {};
console.log(handlers);

// Dual signatures with UNEQUAL value types cannot share the one store.
const dual: { [k: string]: string; [n: number]: "a" } = {};
console.log(dual);
