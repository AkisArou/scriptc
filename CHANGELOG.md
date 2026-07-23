# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

## 0.0.4

<!-- release:start -->

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

<!-- release:end -->

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
