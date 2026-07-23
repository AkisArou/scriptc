// SC2007: values of overloaded function type — a compiled function VALUE is
// one concrete signature. Calls of overloaded declarations resolve per call
// site; it is the value position that fences.

function pick(x: "a"): string;
function pick(x: "b"): number;
function pick(x: string): string | number {
  return x === "a" ? "A" : 1;
}
const stored = pick;
console.log(stored("a"));

// An overloaded TYPE LITERAL slot fences the same way.
declare const on: { (event: "exit", code: number): void; (event: "error", err: string): void };
const listener = on;
console.log(listener("exit", 0));
