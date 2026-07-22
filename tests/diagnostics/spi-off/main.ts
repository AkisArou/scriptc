// A project tsconfig with strictPropertyInitialization OFF (strict: false;
// strictNullChecks stays on — the floor): tsc no longer verifies that
// initializer-less fields are assigned in the constructor, so scriptc
// requires the proof itself — an unconditional top-level constructor
// assignment. `Ok` compiles (the common ctor-assignment pattern survives
// the lax config); `Bad` is assigned only in a method and fences instead
// of reading zeroed memory where Node reads undefined.

class Ok {
  n: number;
  s: string;
  constructor(n: number) {
    this.n = n;
    this.s = "ok";
  }
}

class Bad {
  v: number; // fenced: no initializer, no top-level ctor assignment
  m(): void {
    this.v = 1;
  }
}

console.log(new Ok(5).n);
new Bad();
