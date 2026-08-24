import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { planExecutableCompilation } from "../../index.js";
import { emitJvmSerializedModule, JvmUnsupportedError } from "./emitter.js";

const hello = fileURLToPath(
  new URL("../../../../../tests/corpus/001-hello.ts", import.meta.url),
);
const arithmetic = fileURLToPath(
  new URL("../../../../../tests/corpus/101-arithmetic.ts", import.meta.url),
);
const integerLocals = fileURLToPath(
  new URL("../../../../../tests/corpus/109-jvm-integer-locals.ts", import.meta.url),
);
const referenceValues = fileURLToPath(
  new URL("../../../../../tests/corpus/110-jvm-reference-values.ts", import.meta.url),
);
const stringValues = fileURLToPath(
  new URL("../../../../../tests/corpus/112-jvm-string-values.ts", import.meta.url),
);
const byteValues = fileURLToPath(
  new URL("../../../../../tests/corpus/113-jvm-byte-values.ts", import.meta.url),
);
const stringIntrinsics = fileURLToPath(
  new URL("../../../../../tests/corpus/114-jvm-string-intrinsics.ts", import.meta.url),
);
const arrayValues = fileURLToPath(
  new URL("../../../../../tests/corpus/115-jvm-array-values.ts", import.meta.url),
);
const classFields = fileURLToPath(
  new URL("../../../../../tests/corpus/111-jvm-class-fields.ts", import.meta.url),
);

test("the JVM emitter consumes checked ScriptC IR and emits a direct Java call", () => {
  const planned = planExecutableCompilation(hello, { backend: "c" });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    packageName: "dev.scriptc.generated",
    className: "Hello",
  });

  expect(source).toContain("package dev.scriptc.generated;");
  expect(source).toContain('System.out.println("hello world");');
  expect(source).toContain("public static void main(String[] args)");
  expect(source).not.toContain("native ");
  expect(source).not.toContain("JNI");
});

test("the JVM tier refuses an unsupported checked surface precisely", () => {
  const planned = planExecutableCompilation(arithmetic, { backend: "c" });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  expect(() => emitJvmSerializedModule(planned.plan.ir, { className: "Refusal" }))
    .toThrowError(new JvmUnsupportedError(
      "intrinsic 'console.log'",
      { file: "101-arithmetic.ts", start: 0, end: 22 },
    ));
});

test("the JVM emitter specializes only proved signed-integer locals", () => {
  const planned = planExecutableCompilation(integerLocals, {
    backend: "c",
    externalFunctionRoots: [
      "integerLoop",
      "overflowingNumber",
      "fractionalNumber",
      "negativeZeroNumber",
      "nonIntegerGlobals",
    ],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "IntegerLocals",
  });
  const integerDeclaration = /\bint (l_[0-9a-f]+) = 0;/u.exec(source);

  expect(integerDeclaration).not.toBeNull();
  if (integerDeclaration === null) return;
  expect(source).toMatch(/private static int g_[0-9a-f]+;/u);
  expect(source.match(/private static double g_[0-9a-f]+;/gu)?.length).toBe(3);
  expect(source).not.toContain(`ntsToInt32(${integerDeclaration[1]})`);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = 2147483647d;/u);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = 0\.5d;/u);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = -0\.0d;/u);
});

test("the JVM emitter keeps strings and byte arrays as direct Java references", () => {
  const planned = planExecutableCompilation(referenceValues, {
    backend: "c",
    externalFunctionRoots: ["utf16Length", "byteLength"],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "ReferenceValues",
    functionExports: [{
      functionName: "utf16Length",
      methodName: "utf16Length",
    }, {
      functionName: "byteLength",
      methodName: "byteLength",
    }],
  });

  expect(source).toContain("public static double utf16Length(String a0)");
  expect(source).toContain("public static double byteLength(byte[] a0)");
  expect(source).toMatch(/\.length\(\)/u);
  expect(source).toMatch(/\.length\)/u);
  expect(source).not.toContain("UTF");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter preserves JavaScript string values inside ART", () => {
  const planned = planExecutableCompilation(stringValues, {
    backend: "c",
    externalFunctionRoots: [
      "joined",
      "equal",
      "notEqual",
      "numberText",
      "maybeText",
      "nullableLength",
    ],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "StringValues",
    functionExports: [{
      functionName: "joined",
      methodName: "joined",
    }, {
      functionName: "equal",
      methodName: "equal",
    }, {
      functionName: "notEqual",
      methodName: "notEqual",
    }, {
      functionName: "numberText",
      methodName: "numberText",
    }, {
      functionName: "maybeText",
      methodName: "maybeText",
    }, {
      functionName: "nullableLength",
      methodName: "nullableLength",
    }],
  });

  expect(source).toContain("private static String ntsNumberToString(double value)");
  expect(source).toContain(".equals(");
  expect(source).toContain("Boolean.toString(");
  expect(source).toContain("public static String maybeText(String a0, boolean a1)");
  expect(source).toContain("public static double nullableLength(String a0)");
  expect(source).not.toContain("ntsI64ToNumber");
  expect(source).not.toContain("NtsRangeError");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter constructs and fills Uint8Array values as Java byte arrays", () => {
  const planned = planExecutableCompilation(byteValues, {
    backend: "c",
    externalFunctionRoots: ["filledBytes", "copiedBytes", "emptyBytes"],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "ByteValues",
    functionExports: [{
      functionName: "filledBytes",
      methodName: "filledBytes",
    }, {
      functionName: "copiedBytes",
      methodName: "copiedBytes",
    }, {
      functionName: "emptyBytes",
      methodName: "emptyBytes",
    }],
  });

  expect(source).toContain("public static byte[] filledBytes(double a0)");
  expect(source).toContain("new byte[ntsUint8ArrayLength(");
  expect(source).toContain(".clone()");
  expect(source).toContain("new byte[0]");
  expect(source).toMatch(/\[[^\]]+\] = \(byte\)/u);
  expect(source).not.toContain("JNI");
});

test("the JVM emitter lowers JavaScript string operations directly in ART", () => {
  const roots = [
    "codeAt",
    "characterAt",
    "findText",
    "hasText",
    "startsWithText",
    "endsWithText",
    "sliced",
    "substring",
    "repeated",
    "padded",
    "trimmed",
    "cased",
    "wellFormed",
    "repaired",
    "splitCount",
    "splitPart",
  ];
  const planned = planExecutableCompilation(stringIntrinsics, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "StringIntrinsics",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("ntsStringCharCodeAt(");
  expect(source).toContain("ntsStringSlice(");
  expect(source).toContain("ntsStringRepeat(");
  expect(source).toContain("ntsStringPad(");
  expect(source).toContain("ntsStringToWellFormed(");
  expect(source).toContain("ntsStringSplit(");
  expect(source).toContain("java.util.Locale.ROOT");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter specializes ordinary arrays instead of boxing their elements", () => {
  const roots = [
    "mutateNumbers",
    "findString",
    "mutateBooleans",
    "arrayPipeline",
    "capturedPipeline",
    "mutateCapturedTotal",
    "namedPipeline",
  ];
  const planned = planExecutableCompilation(arrayValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "ArrayValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("double[] data");
  expect(source).toContain("String[] data");
  expect(source).toContain("boolean[] data");
  expect(source).toContain("double push(double... values)");
  expect(source).toContain("boolean includes(String value)");
  expect(source).not.toContain("ArrayList");
  expect(source).not.toContain("Object[] data");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter refuses unsigned byte element access until it is explicit", () => {
  const planned = planExecutableCompilation(referenceValues, {
    backend: "c",
    externalFunctionRoots: ["firstByte"],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  expect(() => emitJvmSerializedModule(planned.plan.ir, { className: "Refusal" }))
    .toThrowError(new JvmUnsupportedError(
      "byte-array intrinsic 'get'",
      { file: "110-jvm-reference-values.ts", start: 225, end: 233 },
    ));
});

test("the JVM emitter keeps managed class fields and dispatch in ART", () => {
  const planned = planExecutableCompilation(classFields, {
    backend: "c",
    externalFunctionRoots: ["classFields", "integerFieldBitwise"],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "ClassFields",
    functionExports: [{
      functionName: "classFields",
      methodName: "classFields",
    }, {
      functionName: "integerFieldBitwise",
      methodName: "integerFieldBitwise",
    }],
  });

  expect(source).toContain("private static class");
  expect(source).toContain(" extends ");
  expect(source).toMatch(/\.m_[0-9a-f]+\(/u);
  expect(source).toMatch(/\n    int m_[0-9a-f]+\(\) \{/u);
  expect(source.match(/\n    double m_[0-9a-f]+\(double a0\) \{/gu)?.length).toBe(2);
  expect(source).toMatch(/private static int f_[0-9a-f]+\(\)/u);
  expect(source).toContain("public static double integerFieldBitwise()");
  expect(source).toMatch(/private int d_[0-9a-f]+;/u);
  expect(source).toContain(" >>> ");
  expect(source).not.toContain("Integer.toUnsignedLong");
  expect(source).not.toContain("JNI");
});
