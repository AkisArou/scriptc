# Changelog

All notable changes to scriptc will be documented in this file.

## Unreleased

## 0.0.1

<!-- release:start -->

The first release: `scriptc` on npm, with `@scriptc/compiler` and `@scriptc/runtime` underneath it.

### Features

- **The CLI**: `scriptc build` compiles a TypeScript or JavaScript entry point into a self-contained native executable, `scriptc run` builds and runs it in one step, and `scriptc coverage` reports statement by statement what compiles statically and which specific constructs block, each with a diagnostic code.
- **The static tier**: programs compile to native code with no JavaScript engine in the binary. Type checking is the real TypeScript compiler; what compiles behaves byte-for-byte like Node, enforced by a differential test corpus.
- **`--dynamic`**: an embedded JavaScript engine (quickjs-ng) executes what cannot compile statically. Values crossing back into static code are validated at runtime, so a mismatched type throws a catchable `TypeError`. Static remains the default; a binary never silently grows an engine.
- **npm dependencies** (with `--dynamic`): packages resolve with Node's own resolution algorithm, typecheck against their shipped `.d.ts`, and their JavaScript is embedded into the binary at build time. Binaries never read `node_modules` at runtime.
- **Platforms**: macOS arm64 is the primary platform; Linux and Windows binaries build by cross-compilation, each verified by its own differential test lane.
- **Documentation** at [scriptc.dev](https://scriptc.dev).

<!-- release:end -->
