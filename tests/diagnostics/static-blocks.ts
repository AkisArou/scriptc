// Static-block FENCES — every unlowerable shape must fail the compile, never
// silently drop the block (the classStaticBlock13 miscompile: an unreferenced
// class's deferred diagnostics vanished along with the block's side effects).

// `this` inside a static block names the class constructor — no value form.
class UsesThis {
  static {
    const me = this;
  }
}

// An unreferenced class whose collection poisons for ANOTHER reason still
// reports eagerly when it carries a static block: the block would have run
// under Node, so deferral may not swallow it.
class NeverReferenced {
  #hidden = 1;
  static {
    console.log("must not be dropped");
  }
}

// The classStaticBlock13 shape: the block itself lowers, but reading a
// static PRIVATE field goes through the class name, which has no value form
// (only static readonly identifier-named fields lower, as module globals).
class PrivateStatic {
  static #x = 123;

  static {
    console.log(PrivateStatic.#x);
  }
}
