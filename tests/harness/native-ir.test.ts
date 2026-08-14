/* Native IR is tested below the TypeScript frontend on purpose: this suite
 * proves the serialized compiler/backend contract independently of any
 * particular binding manifest or declaration package. Native TypeScript's
 * SCABI fixture can replace the tiny standalone C source through the two
 * SCRIPTC_NATIVE_IR_FIXTURE_* variables without changing the IR program. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compileC } from "../../packages/compiler/src/backend/cc.js";
import { emitModule } from "../../packages/compiler/src/backend/emission/emitter.js";
import { emitLlvmModule } from "../../packages/compiler/src/backend/llvm/emitter.js";
import type { IrExpr, IrModule, IrNativeScalar, SrcLoc } from "../../packages/compiler/src/ir/nodes.js";
import { nativeScalarType } from "../../packages/compiler/src/ir/nodes.js";
import { deserializeModule, IR_VERSION, serializeModule } from "../../packages/compiler/src/ir/serialize.js";
import { validateModule } from "../../packages/compiler/src/ir/validate.js";
import type { NativeFrontendInput } from "../../packages/compiler/src/frontend/native.js";
import { compile } from "../../packages/compiler/src/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-native-ir-"));
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const loc: SrcLoc = { file: "native-ir.ts", start: 0, end: 0 };
const I8 = nativeScalarType("i8");
const U8 = nativeScalarType("u8");
const I16 = nativeScalarType("i16");
const U16 = nativeScalarType("u16");
const I32 = nativeScalarType("i32");
const U32 = nativeScalarType("u32");
const NATIVE_VOID = { kind: "void" } as const;
const nativePackage = "@native-typescript/scabi-c-v1-fixture";

const narrowIntegerBindings = [
  { scalar: "i8", declaration: "i8Identity", symbol: "nts_i8_identity" },
  { scalar: "u8", declaration: "u8Identity", symbol: "nts_u8_identity" },
  { scalar: "i16", declaration: "i16Identity", symbol: "nts_i16_identity" },
  { scalar: "u16", declaration: "u16Identity", symbol: "nts_u16_identity" },
  { scalar: "i32", declaration: "i32Identity", symbol: "nts_i32_identity" },
  { scalar: "u32", declaration: "u32Identity", symbol: "nts_u32_identity" },
] as const;

const localNativeInput: NativeFrontendInput = {
  sourceTypes: narrowIntegerBindings.map(({ scalar }) => ({
    declaration: { module: nativePackage, name: scalar },
    type: nativeScalarType(scalar),
  })),
  bindings: narrowIntegerBindings.map(({ scalar, declaration, symbol }) => {
    const type = nativeScalarType(scalar);
    return {
      id: `native-typescript.fixture.c-v1@0.0.0#${scalar}_identity`,
      declaration: { module: nativePackage, name: declaration },
      entry: { kind: "c-symbol" as const, symbol },
      callingConvention: "c",
      variadic: false as const,
      parameters: [{ name: "value", type, passMode: "value" as const }],
      result: { type, passMode: "value" as const },
    };
  }),
};

function frontendNativeInput(): NativeFrontendInput {
  const configured = process.env["SCRIPTC_NATIVE_FRONTEND_INPUT"];
  const translated = configured === undefined
    ? localNativeInput
    : JSON.parse(configured) as NativeFrontendInput;
  return {
    sourceTypes: translated.sourceTypes,
    bindings: [
      ...translated.bindings,
      {
        id: "scriptc-test@1#exit",
        declaration: { module: "scriptc-native-test", name: "exit" },
        entry: { kind: "c-symbol", symbol: "exit" },
        callingConvention: "c",
        variadic: false,
        parameters: [{ name: "status", type: I32, passMode: "value" }],
        result: { type: NATIVE_VOID, passMode: "value" },
      },
      {
        id: "scriptc-test@1#unused",
        declaration: { module: "scriptc-native-test", name: "unused" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_unlinked" },
        callingConvention: "c",
        variadic: false,
        parameters: [{ name: "value", type: I32, passMode: "value" }],
        result: { type: I32, passMode: "value" },
      },
      {
        id: "scriptc-test@1#verify-narrow-integers",
        declaration: { module: "scriptc-native-test", name: "verifyNarrowIntegers" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_narrow" },
        callingConvention: "c",
        variadic: false,
        parameters: [
          { name: "signed8", type: I8, passMode: "value" },
          { name: "unsigned8", type: U8, passMode: "value" },
          { name: "signed16", type: I16, passMode: "value" },
          { name: "unsigned16", type: U16, passMode: "value" },
          { name: "signed32", type: I32, passMode: "value" },
          { name: "unsigned32", type: U32, passMode: "value" },
        ],
        result: { type: I32, passMode: "value" },
      },
    ],
  };
}

function nativeExternalTypes(): Record<string, string> {
  const declarations =
    process.env["SCRIPTC_NATIVE_IR_DECLARATIONS"] ??
    join(repoRoot, "tests/native-ir/package.d.ts");
  return {
    "@native-typescript/scabi-c-v1-fixture": declarations,
    "scriptc-native-test": join(repoRoot, "tests/native-ir/support.d.ts"),
  };
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function exactI32Module(value = "42"): IrModule {
  const literal: IrExpr = { kind: "nativeScalarLit", value, type: I32, loc };
  const identity: IrExpr = {
    kind: "nativeCall",
    binding: "fixture.i32_identity",
    args: [literal],
    type: I32,
    loc,
  };
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    nativeBindings: [
      {
        id: "fixture.i32_identity",
        declaration: { module: "@native-typescript/scabi-c-v1-fixture", name: "i32Identity" },
        entry: { kind: "c-symbol", symbol: "nts_i32_identity" },
        callingConvention: "c",
        variadic: false,
        parameters: [{ name: "value", type: I32, passMode: "value" }],
        result: { type: I32, passMode: "value" },
      },
      {
        id: "process.exit",
        declaration: { module: "scriptc:test", name: "exit" },
        entry: { kind: "c-symbol", symbol: "exit" },
        callingConvention: "c",
        variadic: false,
        parameters: [{ name: "status", type: I32, passMode: "value" }],
        result: { type: NATIVE_VOID, passMode: "value" },
      },
    ],
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "nativeCall",
              binding: "process.exit",
              args: [identity],
              type: NATIVE_VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function exactScalarLiteralModule(
  scalar: IrNativeScalar,
  value: string,
): IrModule {
  const type = nativeScalarType(scalar);
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "nativeScalarLit", value, type, loc },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function compileNativeObject(
  source: string,
  objectName: string,
  includeDir?: string,
): string {
  const object = join(scratch, objectName);
  execFileSync("clang", [
    "-std=c11",
    ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-O2"]),
    ...(includeDir === undefined ? [] : ["-I", includeDir]),
    "-c",
    source,
    "-o",
    object,
  ]);
  return object;
}

function fixtureObject(): string {
  const source =
    process.env["SCRIPTC_NATIVE_IR_FIXTURE_SOURCE"] ??
    join(repoRoot, "tests/native-ir/native.c");
  return compileNativeObject(
    source,
    "native.o",
    process.env["SCRIPTC_NATIVE_IR_FIXTURE_INCLUDE"],
  );
}

function supportObject(): string {
  return compileNativeObject(
    join(repoRoot, "tests/native-ir/native-support.c"),
    "native-support.o",
  );
}

test("Native IR validates and serializes an exact i32 call without a number carrier", () => {
  const mod = exactI32Module("-2147483648");
  expect(validateModule(mod)).toEqual([]);
  const json = serializeModule(mod);
  expect(json).toContain('"value": "-2147483648"');
  expect(deserializeModule(json)).toEqual(mod);
});

test("Native IR validates every narrow integer's signed bounds", () => {
  const cases: readonly [IrNativeScalar, string, string][] = [
    ["i8", "-128", "127"],
    ["u8", "0", "255"],
    ["i16", "-32768", "32767"],
    ["u16", "0", "65535"],
    ["i32", "-2147483648", "2147483647"],
    ["u32", "0", "4294967295"],
  ];
  for (const [scalar, min, max] of cases) {
    for (const value of [min, max]) {
      const mod = exactScalarLiteralModule(scalar, value);
      expect(validateModule(mod), `${scalar} ${value}`).toEqual([]);
      expect(deserializeModule(serializeModule(mod))).toEqual(mod);
    }
  }
});

test("Native IR rejects invalid binding identity, exact types, and i32 literals", () => {
  const invalidId = exactI32Module();
  invalidId.nativeBindings![0]!.id = "bad id";
  expect(validateModule(invalidId).map((error) => error.message)).toContain(
    'invalid Native IR binding id "bad id"',
  );

  const duplicateDeclaration = exactI32Module();
  duplicateDeclaration.nativeBindings![1]!.declaration = {
    ...duplicateDeclaration.nativeBindings![0]!.declaration,
  };
  expect(validateModule(duplicateDeclaration).map((error) => error.message)).toContain(
    'duplicate Native IR declaration "@native-typescript/scabi-c-v1-fixture"::"i32Identity"',
  );

  const outOfRange = exactI32Module("2147483648");
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    "in __main: native i32 literal 2147483648 is out of range",
  );

  const wrongResult = exactI32Module();
  const exit = wrongResult.functions[0]!.body[0]!;
  if (exit.kind !== "exprStmt" || exit.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR call shape");
  }
  exit.expr.type = I32;
  expect(validateModule(wrongResult).map((error) => error.message)).toContain(
    "in __main: Native IR call process.exit type native:i32 != result void",
  );
});

test("the frontend rejects an out-of-range exact i32 constructor before linking", async () => {
  const outDir = join(scratch, "frontend-out-of-range");
  const result = await compile(join(repoRoot, "tests/native-ir/out-of-range.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: frontendNativeInput(),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("the frontend rejects an out-of-range unsigned constructor before linking", async () => {
  const outDir = join(scratch, "frontend-unsigned-out-of-range");
  const result = await compile(
    join(repoRoot, "tests/native-ir/unsigned-out-of-range.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("a reached native symbol missing from the link fails as SC5105", async () => {
  const outDir = join(scratch, "frontend-missing-symbol");
  const result = await compile(join(repoRoot, "tests/native-ir/missing-symbol.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: frontendNativeInput(),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5105"]);
});

describe.each(["c", "llvm"] as const)("Native IR exact integers, %s backend", (backend) => {
  test("round-trips the SCABI identity result as the observable process status", async () => {
    const mod = exactI32Module();
    expect(validateModule(mod)).toEqual([]);
    const outDir = join(scratch, backend);
    mkdirSync(outDir, { recursive: true });
    const sourcePath = join(outDir, backend === "c" ? "program.c" : "program.ll");
    writeFileSync(
      sourcePath,
      backend === "c" ? emitModule(mod) : emitLlvmModule(mod, { pointerBits: 64 }),
    );
    const binaryPath = join(outDir, "program");
    await compileC({
      cPath: sourcePath,
      outPath: binaryPath,
      linkInputs: [fixtureObject()],
      sanitize,
    });
    const result = spawnSync(binaryPath);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("lowers exact declaration symbols and literals through the TypeScript frontend", async () => {
    const outDir = join(scratch, `frontend-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/program.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings?.map((binding) => binding.id).sort()).toEqual([
      "native-typescript.fixture.c-v1@0.0.0#i16_identity",
      "native-typescript.fixture.c-v1@0.0.0#i32_identity",
      "native-typescript.fixture.c-v1@0.0.0#i8_identity",
      "native-typescript.fixture.c-v1@0.0.0#u16_identity",
      "native-typescript.fixture.c-v1@0.0.0#u32_identity",
      "native-typescript.fixture.c-v1@0.0.0#u8_identity",
      "scriptc-test@1#exit",
      "scriptc-test@1#verify-narrow-integers",
    ]);
    const json = serializeModule(mod);
    expect(json).toContain('"kind": "nativeScalarLit"');
    expect(json).not.toContain('"kind": "numLit"');

    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});
