# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

## 0.0.2

<!-- release:start -->

Compiler fixes and static-surface growth driven by the first days of real-world use.

### Features

- **`Number(aString)` compiles statically**: the full ECMAScript ToNumber string grammar (whitespace forms, hex/octal/binary literals, `Infinity`, exponents, trailing-garbage → `NaN`), verified bit-exact against Node on one million fuzzed strings. Unary `+` on strings and `%d` formatting over strings ride the same lowering; `parseFloat(aString)` compiles statically with its own longest-prefix grammar.
- **`Array.from(aString)` and `[...aString]` compile statically**: strings split by code points, so astral characters stay whole — exactly the string iterator's walk.
- **Bare `'.'` and `'..'` import specifiers** resolve as relative directory imports, and default imports of supported Node builtins (`import fs from "node:fs"`) pass type checking under the project's own interop settings.
- **Workspace-linked packages** register before the type-check gate, so pnpm-workspace monorepos analyze without their sibling packages' shipped JavaScript gating the build.

### Fixes

- `scriptc coverage` now renders the same diagnostics a build prints — code frames included — when analysis stops on type errors or import fences, instead of a bare summary line.
- The LLVM backend's runtime declarations are now mechanically checked against the C runtime's prototypes at test time; two latent signature mismatches were found and fixed.
- Import-cycle admission accepts declaration-only initialization windows whose calls resolve entirely to declaration files, widening the set of legal ESM cycles that compile statically.

<!-- release:end -->

## 0.0.1

The first release: `scriptc` on npm, with `@scriptc/compiler` and `@scriptc/runtime` underneath it.

### Features

- **The CLI**: `scriptc build` compiles a TypeScript or JavaScript entry point into a self-contained native executable, `scriptc run` builds and runs it in one step, and `scriptc coverage` reports statement by statement what compiles statically and which specific constructs block, each with a diagnostic code.
- **The static tier**: programs compile to native code with no JavaScript engine in the binary. Type checking is the real TypeScript compiler; what compiles behaves byte-for-byte like Node, enforced by a differential test corpus.
- **`--dynamic`**: an embedded JavaScript engine (quickjs-ng) executes what cannot compile statically. Values crossing back into static code are validated at runtime, so a mismatched type throws a catchable `TypeError`. Static remains the default; a binary never silently grows an engine.
- **npm dependencies** (with `--dynamic`): packages resolve with Node's own resolution algorithm, typecheck against their shipped `.d.ts`, and their JavaScript is embedded into the binary at build time. Binaries never read `node_modules` at runtime.
- **Platforms**: macOS arm64 is the primary platform; Linux and Windows binaries build by cross-compilation, each verified by its own differential test lane.
- **Documentation** at [scriptc.dev](https://scriptc.dev).
