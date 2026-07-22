// The definite-assignment fences. A field whose type ADMITS undefined
// starts as JS's undefined and compiles (corpus 1584-1587); a field whose
// type CANNOT hold undefined has no honest pre-assignment value in these
// monomorphic layouts, so it must be provably assigned during
// construction. tsc's strictPropertyInitialization is that proof — and a
// `!` assertion exists precisely to WAIVE it (assign later, outside the
// constructor), so the waived field is fenced unless the constructor's
// top level assigns it anyway.

class Lazy {
  path!: string; // fenced: only a method assigns it
  init(): void {
    this.path = "/tmp/lazy";
  }
}

class Eager {
  root!: string; // compiles: the constructor's top level assigns it
  constructor() {
    this.root = "/";
  }
}

// Reached: collection defers its diagnostics until a reference makes
// them relevant.
new Lazy();
new Eager();
