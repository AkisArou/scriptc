/* The published manifest format is imported from outside this package's build,
 * by a consumer that reads it as SOURCE and never builds it. Two properties
 * make that possible, and both fail somewhere else when they break: a stray
 * import drags this package's source graph into a consumer's typecheck, and a
 * runtime value stops the import erasing, so a clean checkout of a consumer
 * fails before anything has been built.
 *
 * Neither failure shows up here, which is exactly why it is asserted here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  IR_NATIVE_INTEGER_SCALARS,
  type IrNativeBinding,
  type IrNativeExport,
  type IrNativeIntegerScalar,
} from "../src/ir/nodes.js";
import type { NativeFrontendBinding, NativeFrontendExport } from "../src/frontend/native.js";
import type {
  IrNativeBinding as PublishedBinding,
  IrNativeExport as PublishedExport,
  IrNativeIntegerScalar as PublishedIntegerScalar,
} from "../src/native-manifest.js";

const source = readFileSync(
  fileURLToPath(new URL("../src/native-manifest.d.ts", import.meta.url)),
  "utf8",
);

/** Source lines with block and line comments removed, so a mention of
 * `import` in prose is not read as one. */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
}

test("the published manifest module is reachable by a supported specifier", () => {
  /* The two properties above make the file importable. This one makes it
   * IMPORTED. An `exports` map does not merely describe a package's entry
   * points, it restricts them: a subpath it does not list cannot be imported
   * at all, however present the file is on disk. So a contract this package
   * documents as consumed from outside, and copies into `dist` on every
   * build, was reachable only by a relative path into the package's source
   * tree — which is a consumer reading around the package rather than from
   * it, and breaks silently the first time the layout moves.
   *
   * The subpath resolves to the SOURCE file rather than the built copy on
   * purpose, so it keeps the property the header claims: a consumer needs no
   * build of this package to typecheck against it. The `dist` copy stays
   * because this package's own emitted declarations resolve through it. */
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { exports: Record<string, string>; files: string[] };

  const subpath = manifest.exports["./native-manifest.d.ts"];
  expect(subpath).toBe("./src/native-manifest.d.ts");

  /* Listed AND shipped: an export map entry pointing outside `files` resolves
   * in this checkout and is absent from the published tarball, which is the
   * one failure mode a test run from inside the repository cannot otherwise
   * see. */
  expect(manifest.files).toContain("src/native-manifest.d.ts");
  expect(
    readFileSync(fileURLToPath(new URL(`../${subpath.slice(2)}`, import.meta.url)), "utf8"),
  ).toBe(source);
});

test("the published manifest module imports nothing", () => {
  expect(code()).not.toMatch(/^\s*import\b/mu);
  expect(code()).not.toMatch(/\bfrom\s*["']/u);
  expect(code()).not.toMatch(/\brequire\s*\(/u);
});

test("the published manifest module declares no runtime value", () => {
  /* Everything it exports must erase. A `const`, `function`, `class`, `enum`
   * or `namespace` here would survive type stripping and give the import a
   * runtime edge into this package. */
  expect(code()).not.toMatch(/^export\s+(?:const|let|var|function|class|enum|namespace|default)\b/mu);
  expect(code()).not.toMatch(/^export\s*\{/mu);
  for (const declaration of code().matchAll(/^export\s+(\w+)/gmu)) {
    expect(declaration[1]).toMatch(/^(?:interface|type)$/u);
  }
});

test("the IR's vocabulary is the published one, not a copy of it", () => {
  /* Assignability in both directions is the whole guarantee: if these compile,
   * the two names denote one type and cannot have drifted. They are not merely
   * structurally equal — `nodes.ts` re-exports the published declarations — and
   * this test is what fails if someone re-declares them locally instead. */
  const binding = (value: IrNativeBinding): PublishedBinding => value;
  const backAgain = (value: PublishedBinding): IrNativeBinding => value;
  const exported = (value: IrNativeExport): PublishedExport => value;
  const exportedBack = (value: PublishedExport): IrNativeExport => value;
  const scalar = (value: IrNativeIntegerScalar): PublishedIntegerScalar => value;
  const scalarBack = (value: PublishedIntegerScalar): IrNativeIntegerScalar => value;
  expect([binding, backAgain, exported, exportedBack, scalar, scalarBack])
    .toHaveLength(6);
});

test("an embedder's input speaks the published vocabulary", () => {
  /* `NativeFrontendInput` is what an embedder hands the compiler, and its
   * members are the published shapes with the embedder's own identity fields
   * around them. A binding accepted by the frontend must therefore be a
   * published binding, which is what makes publishing the format sufficient
   * for a generator to target. */
  const asPublished = (value: NativeFrontendBinding): PublishedBinding => value;
  const asPublishedExport = (value: NativeFrontendExport): PublishedExport => value;
  expect([asPublished, asPublishedExport]).toHaveLength(2);
});

test("the integer scalar value and its published union cannot drift", () => {
  /* The union is spelled out in the published module because deriving it from
   * this array would make the module depend on a runtime value. The array is
   * annotated with the union, so a name added to one and not the other fails
   * to compile; this pins the membership itself so a name silently DROPPED
   * from the array is caught too. */
  expect([...IR_NATIVE_INTEGER_SCALARS]).toEqual([
    "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize",
  ]);
});
