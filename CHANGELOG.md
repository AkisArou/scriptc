# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

## 0.0.11

<!-- release:start -->

### Features

- **Profiles declare integer boundary slots**: library exports may class parameters and returns `i64`/`u64`, and the compiler proves integrality and range for every value that can reach them — or refuses with the slot path, the failed obligation with evidence, and the concrete fix. Proven returns cross as exact machine integers; a bounded counter loop proves its exact range; `x | 0` is a proof by the ToInt32 contract. Semantics stay f64 everywhere inside the program.
- **Library fences cover the whole ambient surface**: the Date, performance, and process families join the surface manifest as fenceable ids, so a profile can deny every surface the determinism attestation knows — full fences now imply a deterministic attestation by construction. The attestation itself tightened: six live ambient reads it previously missed now demote it. Profile roots refuse unknown keys.
- **Subclasses override `emit`**: the wrap-and-forward pattern (`emit(event, ...args)` delegating to `super.emit`) compiles with Node's dispatch, error-event, and super-chain semantics, monomorphized per event.
- **Stream timing matches Node's tick order**: stream emissions interleave with `process.nextTick` in enqueue order — Node's order — instead of draining after user ticks; stream emitters model the event-key shape that governs `eventNames()` order; `push(string)` honors `defaultEncoding` with Node's unknown-encoding errors.
- **`node:stream/consumers` compiles statically** (`text`/`json`/`buffer` with Node's settle timing and rejection set), and **`createRequire` erases at compile time** — builtin specs become static imports, relative JSON bakes as the validated document, npm packages resolve their CJS arms under `--dynamic`, and unresolvable names throw Node's catchable `MODULE_NOT_FOUND`.

### Fixes

- The two 0.0.10 crash classes are fixed and its seven behavior regressions restored: collect-phase probes recover from rejected constructs instead of crashing, and the no-storage binding families claim statement declarators only.
- `Buffer.slice`/`subarray` and `TypedArray.subarray` are true aliasing views — mutating through a view silently computed wrong bytes before.
- Math.trunc and Math.ceil compile statically.

<!-- release:end -->

## 0.0.10

### Features

- **Engine-held values flow through dynamic code**: values born in the embedded engine now cross into `unknown`/`object`-typed slots and back — `typeof`, strict equality, `String()`, keyed reads and writes, calls, and method dispatch route through the engine (its own prototypes run, JS-exact), with reference-preserving identity on the round trip. Unions like `string | object` compile wholesale into the checked-dynamic representation, and nullish coalescing and optional chains work on every dynamic value. Operations not yet routed fail loudly by name — the boundary's silent wrong answers (`typeof` misreporting, phantom `.length`) are gone.
- **`Object.create(null)`, array `entries()`/`keys()`, and variadic `Object.assign`**: real null-prototype dictionaries with Node's inspect/`toString`/comparison behavior (the dynamic tier delegates to the engine's own `Object.create` for live prototypes); live index-walking pair iterators; `Object.assign(target, ...sources)` with JavaScript's exact evaluation order and V8's position-dependent error texts.
- **Erased ambient declarations behave like Node**: chains rooted in `declare`d values compile and throw the catchable `ReferenceError` Node produces at first touch; never-read unmappable bindings vanish; nullish-cast bindings answer Node's exact `TypeError` on member access; assertion-shaped generic signatures monomorphize per call.
- **Misuse of fs, net, dgram, tls, and stream APIs throws Node's validation ladders**: argument checks run in Node's order with `ERR_*` codes and message-exact texts; `fs.exists` is genuinely async (including its no-error-argument wart), and `mkdtempSync` and `lchmod` are real.
- **Keyed writes land on dynamic receivers** (`bag[key] = value` on objects built up dynamically, with `ToPropertyKey`-exact key handling), and array destructuring walks dynamic sources with V8's exact non-iterable error wordings.
- **Library mode: profiles deny surfaces by manifest id** — a `fences` array refuses fenced surfaces reached by the compiled graph, with the profile's guidance attached as a visibly-attributed note; teachings generalize to any refusal; fence evaluation reads the same dead-stripped graph as the determinism attestation, so full fences imply a deterministic attestation by construction.

### Fixes

- Mixed engine-vs-native `deepStrictEqual` comparisons fence loudly instead of fabricating a failure result.
- The LLVM code generator marshals dynamic values in `jsMarshal` positions identically to the C backend (a latent gap).
- Concurrent plain and sanitized test-suite runs no longer race each other's scratch directories (a test-infrastructure fix).


## 0.0.9

### Features

- **API misuse throws Node's exact errors**: argument-validation ladders on Buffer (`compare`/`equals`/constructors), URLSearchParams (WHATWG brand checks, arity, ToPrimitive coercion running user `toString`/`valueOf`), the max-listeners family, and range checks across bytes/fs — `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, and `ERR_MISSING_ARGS` with Node's message texts, catchable and assertable.
- **Strings destructure**: array patterns over strings split by code point (positions, holes, defaults, rest, nesting, for-of heads); destructured built-in globals (`const { subtle } = globalThis.crypto`) bind with Node-agreeing identity.
- **Spread arguments land anywhere**: `f(...args)` outside typed rest slots builds the argument list with JavaScript's exact evaluation order on both backends, including under `--dynamic`, with V8's spread-TypeError texts for non-iterable sources.
- **Record shapes widen further**: hybrid declared-plus-index-signature records width-coerce in both directions; index signatures carry function, Map, and Set values (the command-registry pattern); per-field lifts cover `unknown` destinations, upcasts, and function adapters.
- **DataView setters, `Object.is`, and an exact Intl slice**: the full DataView setter family; fresh ArrayBuffers erase into zero-filled views; `Object.is` with the spec's SameValue; `new Intl.NumberFormat("en-US").format()` and `toLocaleString("en-US")` print byte-identically to Node without linking ICU.
- **`stream/promises` compiles statically**, and out-of-scope modules (`v8`, `domain`, `node:sqlite`, Node's underscore-internals) refuse with reasons instead of a generic unsupported-module message.
- **Bundler interop**: esbuild's `__toESM(require(...))` external-dependency wrapper compiles statically under `--npm-static`, with build-time `.default` semantics matching Node's interop rules; unrecognizable variants degrade to the embedded engine with the construct named.
- **Library mode**: runtime-detected traps deliver the structured teaching encoding unconditionally (code, trapping symbol, optional profile remediation); bare npm specifiers compile statically when eligible or refuse with the failed bar named.

### Fixes

- The C code generator compiles with strict aliasing disabled: the refcounted object header is accessed through base- and derived-typed views by design, and optimizer type-based alias analysis could elide refcount updates, freeing objects still in use. The LLVM lane was unaffected.
- `Promise.reject` with an untyped reason no longer crashes the LLVM code generator; rest-parameter arrows forwarding their rest via spread no longer trip an internal error.
- Two readable-stream lifecycle bugs: the `emittedReadable` flag now clears at Node's moment, and absent-size reads clear pending state correctly.
- String-typed `'data'` listeners (the `setEncoding` shape) received raw byte headers as string content on sockets, http requests, and http2 streams; they now decode UTF-8 correctly.


## 0.0.8

### Features

- **Destructuring completes its static surface**: nested patterns and property/element targets in assignment position (`[c.x, c.y] = arr`, `({ a: rec.f } = o)`) with JavaScript's exact evaluation order, destructuring from class instances (getters called once per element), rest over class instances packing the inheritance chain in Node's key order, and defaults on destructured accessor results.
- **The monomorphization frontier widens**: `keyof`-constrained generics specialize per literal key (`pick<T, K extends keyof T>` and keyed writes), generic methods called through interface-typed receivers compile against the proven class, and generic-signature annotations, aliases of generic functions, and generic arrow initializers all monomorphize per pinned signature.
- **`#private` statics resolve through class values**: `X.#m()` calls, const-bound class expressions with static initializers, decorated class names, and aliases of the class all reach static private members when the receiver provably holds the declaring class.
- **Named type-shape diagnostics**: the former catch-all "unsupported type" diagnostic splits into SC2005 (generic call signatures), SC2006 (index-signature shapes), SC2007 (overloaded function types), SC2008 (unresolved intersections), and SC2009 (a supported shape whose named component is the blocker — the message points at the exact offending piece).
- **Library builds speak the structured trap encoding**: trap messages carry a diagnostic code, the trapping export's symbol, and optional profile-supplied remediation inside the frozen sink signature, degrading gracefully to plain text; contract sidecars refuse order-ambiguous type declarations (multi-site merging, conditional/mapped types) with teachings naming every site, and spread-composed unions pin depth-first declaration order.
- **Broader dynamic-tier interop**: `Object.hasOwn`/`Object.assign` on records and engine values, runtime-keyed writes to fixed shapes, regex union arms with `instanceof RegExp` narrowing, tagged templates receiving a real `TemplateStringsArray`, getters and spreads in island object literals, and JavaScript variadics binding the engine's arguments array.

### Fixes

- Arrays that grow from an empty `any[]` no longer break compilation under `--dynamic` when they flow into typed array methods (`map`/`filter`/`forEach` and family).
- A latent double-getter-call in destructuring defaults over accessor results is fixed.


## 0.0.7

### Features

- **Library builds emit a contract sidecar**: a profile that declares a sidecar path gets a deterministic `*.contract.json` beside the archive — exported symbols with marshalled signatures, record/union type tables in declaration order, and a 64-bit build id that is also readable from the archive itself through synthesized constant getters (safe to call before init and after a trap). Two builds of the same tree produce byte-identical sidecars, so embedder tooling can diff contracts mechanically.

### Fixes

- Comparing a union value against `null` or `undefined` when the union has no such arm now answers the constant the type system already knows (`false` for `===`, `true` for `!==`) instead of trapping at runtime; `switch` cases on absent unit arms fold the same way. The scrutinee is still evaluated exactly once.
- Programs using `net` auto-select-family timeouts no longer fail at link on the default backend: the code generator's symbol table spelled two runtime symbols differently than the runtime defines them. The ABI audit now verifies every runtime symbol the code generator can emit against the runtime header, so this class of skew fails in CI rather than at a user's link step.

## 0.0.6

### Features

- **Recursive types compile statically**: self-referential interfaces (`interface TreeNode { label: string; children: TreeNode[] }`), mutually recursive types, and recursive unions — the AST/tree/linked-list class — now map to native representations. Cyclic values are collected by the cycle collector; `JSON.stringify` on a cyclic value throws V8's exact circular-structure error; `console.log` prints Node's circular reference markers; `JSON.parse(x) as T` validates recursive shapes with path-exact failures.

## 0.0.5


### Features

- **Library mode**: `scriptc build --lib --profile <profile.json>` compiles a TypeScript module set into a linkable static archive exporting profile-declared C symbols — marshalled scalar/string/bytes signatures, a re-runnable init entry, panic-to-sink routing instead of aborts, and a cycle-collection entry. The emitted archive links against nothing but libSystem, creates no threads, and installs no signal handlers; conformance fixtures drive both code generators from a real C host.
- **Bundler-emitted CommonJS packages work with `--npm-static`**: getter-table and star re-export plumbing now types its named exports from the same name set Node's lexer sees, and a package whose shipped code still breaks the typecheck falls back to the embedded engine with a note naming why — never a failed build.

### Fixes

- Two compile-time crashes on unusual shipped-JavaScript shapes (probe reads that mutated locals, captures through non-lifted functions) now compile or fence with a named diagnostic.

## 0.0.4


### Features

- **`console.log` prints every inspectable shape**: arrays, records, Maps/Sets, class instances, `undefined`/`null`, Buffers, and unions — each non-scalar argument renders through the same machinery as `util.inspect`, matching Node's console semantics exactly (string union arms print raw, format-string first arguments keep `util.format` behavior).
- **The `#private` members chain**: private fields, instance and static methods, accessors, generator methods, and `#x in obj` brand checks all compile, with Node's lexical binding and brand semantics.
- **`node:querystring` compiles statically**: the full legacy surface (`parse`, `stringify`, `escape`, `unescape`) with Node's exact separator, `maxKeys`, and malformed-escape behavior.
- **Command-table and generic-member patterns**: `as const` option tables with `String`/`Number`/`Boolean` constructor values, generic arrow instance fields, async generic methods and statics, and definite-assignment (`field!`) declarations all lower.
- **Object literals widen per-field into union arms**: the reducer-action pattern — a literal whose fields fit exactly one arm of a contextual union — now compiles.
- **The `performance` global**, `Response.headers`/`arrayBuffer()`/`bytes()`, and `Math.max`/`Math.min` at any arity.
- **Workspace members install-agnostic**: monorepo siblings classify identically whether the package manager symlinks or copies them into `node_modules`.

### Fixes

- Whole-program IR validation over large mixed static/dynamic graphs no longer surfaces internal errors: island values entering typed intrinsic slots are validated at the boundary, and `any`-typed values dispatch through the checked-dynamic machinery.
- `JSON.stringify` of a dynamic value holding `undefined` now prints identically on both backends.
- Loose equality between same-kind operands lowers as strict equality.
- The limitations page documents the type surface: where scriptc's ambient world is narrower than stock TypeScript's, and what diagnostics point at instead.

## 0.0.3

### Features

- **Surface manifest**: each release now ships a machine-readable `surface-manifest.json` — the language and stdlib surface the static tier compiles at that version, with stable per-entry ids so tooling can diff two releases mechanically. Every non-static entry carries the diagnostic code the compiler raises for it. Attached to the GitHub release and shipped inside `@scriptc/compiler` as `@scriptc/compiler/surface-manifest.json`; regenerate with `pnpm manifest`.

## 0.0.2

### Features

- **`Number(aString)` compiles statically**: the full ECMAScript ToNumber string grammar (whitespace forms, hex/octal/binary literals, `Infinity`, exponents, trailing-garbage → `NaN`), verified bit-exact against Node on one million fuzzed strings. Unary `+` on strings and `%d` formatting over strings ride the same lowering; `parseFloat(aString)` compiles statically with its own longest-prefix grammar.
- **`Array.from(aString)` and `[...aString]` compile statically**: strings split by code points, so astral characters stay whole — exactly the string iterator's walk.
- **Bare `'.'` and `'..'` import specifiers** resolve as relative directory imports, and default imports of supported Node builtins (`import fs from "node:fs"`) pass type checking under the project's own interop settings.
- **Workspace-linked packages** register before the type-check gate, so pnpm-workspace monorepos analyze without their sibling packages' shipped JavaScript gating the build.

### Fixes

- `scriptc coverage` now renders the same diagnostics a build prints — code frames included — when analysis stops on type errors or import fences, instead of a bare summary line.
- The LLVM backend's runtime declarations are now mechanically checked against the C runtime's prototypes at test time; two latent signature mismatches were found and fixed.
- Import-cycle admission accepts declaration-only initialization windows whose calls resolve entirely to declaration files, widening the set of legal ESM cycles that compile statically.

## 0.0.1

### Features

- **The CLI**: `scriptc build` compiles a TypeScript or JavaScript entry point into a self-contained native executable, `scriptc run` builds and runs it in one step, and `scriptc coverage` reports statement by statement what compiles statically and which specific constructs block, each with a diagnostic code.
- **The static tier**: programs compile to native code with no JavaScript engine in the binary. Type checking is the real TypeScript compiler; what compiles behaves byte-for-byte like Node, enforced by a differential test corpus.
- **`--dynamic`**: an embedded JavaScript engine (quickjs-ng) executes what cannot compile statically. Values crossing back into static code are validated at runtime, so a mismatched type throws a catchable `TypeError`. Static remains the default; a binary never silently grows an engine.
- **npm dependencies** (with `--dynamic`): packages resolve with Node's own resolution algorithm, typecheck against their shipped `.d.ts`, and their JavaScript is embedded into the binary at build time. Binaries never read `node_modules` at runtime.
- **Platforms**: macOS arm64 is the primary platform; Linux and Windows binaries build by cross-compilation, each verified by its own differential test lane.
- **Documentation** at [scriptc.dev](https://scriptc.dev).
