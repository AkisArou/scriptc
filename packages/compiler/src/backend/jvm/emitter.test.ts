import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { planExecutableCompilation } from "../../index.js";
import { deserializeModule } from "../../ir/serialize.js";
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
const recordValues = fileURLToPath(
  new URL("../../../../../tests/corpus/116-jvm-record-values.ts", import.meta.url),
);
const unionValues = fileURLToPath(
  new URL("../../../../../tests/corpus/117-jvm-union-values.ts", import.meta.url),
);
const mapValues = fileURLToPath(
  new URL("../../../../../tests/corpus/118-jvm-map-values.ts", import.meta.url),
);
const setValues = fileURLToPath(
  new URL("../../../../../tests/corpus/119-jvm-set-values.ts", import.meta.url),
);
const mathValues = fileURLToPath(
  new URL("../../../../../tests/corpus/120-jvm-math-values.ts", import.meta.url),
);
const numberParsing = fileURLToPath(
  new URL("../../../../../tests/corpus/121-jvm-number-parsing.ts", import.meta.url),
);
const integerParameters = fileURLToPath(
  new URL("../../../../../tests/corpus/122-jvm-integer-parameters.ts", import.meta.url),
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
    "spreadLiteralOrder",
    "selfSpreadArray",
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
  expect(source).toContain("double pushSpread(NtsArray");
  expect(source).toContain("System.arraycopy(values.data, 0, data, length, count)");
  expect(source).toContain("boolean includes(String value)");
  expect(source).not.toContain("ArrayList");
  expect(source).not.toContain("Object[] data");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter gives fixed-shape object literals exact Java fields", () => {
  const roots = ["recordFields", "recordEvaluationOrder"];
  const planned = planExecutableCompilation(recordValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "RecordValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("double r_");
  expect(source).toContain("String r_");
  expect(source).toContain("boolean r_");
  expect(source).not.toContain("HashMap");
  expect(source).not.toContain("Object[]");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter keeps optional references nullable and scalar unions exact", () => {
  const roots = [
    "optionalNumber",
    "optionalRecord",
    "optionalString",
    "optionalArray",
    "mixedValue",
  ];
  const planned = planExecutableCompilation(unionValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "UnionValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("final int tag");
  expect(source).toContain("final double payload");
  expect(source).toContain("final String payload");
  expect(source).toMatch(/NtsRecord\d+ l_/u);
  expect(source).toMatch(/NtsArray\d+ l_/u);
  expect(source).toMatch(/String l_/u);
  expect(source).not.toContain("Object payload");
  expect(source).not.toContain("Double.valueOf");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter keeps typed maps in exact key and value arrays", () => {
  const roots = [
    "stringNumberMap",
    "numberStringMap",
    "booleanMap",
    "unionValueMap",
    "nullableValueMap",
    "undefinedValueMap",
    "liveIterationMap",
    "clearDuringIterationMap",
    "rehashAndCompactMap",
  ];
  const planned = planExecutableCompilation(mapValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "MapValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("String[] keys");
  expect(source).toContain("double[] keys");
  expect(source).toContain("double[] values");
  expect(source).toContain("String[] values");
  expect(source).toContain("boolean[] values");
  expect(source).not.toContain("HashMap");
  expect(source).not.toContain("LinkedHashMap");
  expect(source).not.toContain("Object[]");
  expect(source).not.toContain("Double.valueOf");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter keeps typed sets in exact element arrays", () => {
  const roots = [
    "stringSet",
    "numberSet",
    "seededEvaluationOrderSet",
    "spreadSet",
    "liveIterationSet",
    "clearDuringIterationSet",
    "combinedSets",
    "rehashAndCompactSet",
    "directSetIteration",
  ];
  const planned = planExecutableCompilation(setValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "SetValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("String[] elements");
  expect(source).toContain("double[] elements");
  expect(source).toContain("int[] table");
  expect(source).toContain("catch (Throwable l_25697465726578632e30)");
  expect(source).toContain("throw ntsRethrow(l_25697465726578632e30);");
  expect(source).toContain("<T extends Throwable> void ntsThrowUnchecked");
  expect(source).not.toContain("Object[]");
  expect(source).not.toContain("HashSet");
  expect(source).not.toContain("LinkedHashSet");
  expect(source).not.toContain("Double.valueOf");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter keeps static JavaScript math as primitive JVM operations", () => {
  const roots = [
    "mathTransforms",
    "mathEdges",
    "extremaArity",
    "spreadExtrema",
    "variadicMathOrder",
    "randomInvariant",
  ];
  const planned = planExecutableCompilation(mathValues, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "MathValues",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("Math.floor(");
  expect(source).toContain("Math.ceil(");
  expect(source).toContain("Math.abs(");
  expect(source).toContain("ntsMathRound(");
  expect(source).toContain("ntsMathMaxArray(");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter keeps numeric recognition and parsing inside ART", () => {
  const roots = [
    "numberPredicates",
    "numericSameValue",
    "predicateEvaluationOrder",
    "parseIntegerEdges",
    "parseFloatEdges",
    "convertStringEdges",
    "parsedInteger",
    "parsedFloat",
    "convertedNumber",
  ];
  const planned = planExecutableCompilation(numberParsing, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "NumberParsing",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  expect(source).toContain("Double.isFinite(");
  expect(source).toContain("Double.isNaN(");
  expect(source).toContain("ntsNumberIsInteger(");
  expect(source).toContain("ntsNumberIsSafeInteger(");
  expect(source).toContain("Double.doubleToLongBits(");
  expect(source).toContain("ntsIsJsWhitespace(");
  expect(source).toContain("ntsParseInt(");
  expect(source).toContain("ntsParseFloat(");
  expect(source).toContain("ntsStringToNumber(");
  expect(source).toContain("new java.math.BigInteger(");
  expect(source).not.toContain("java.util.regex");
  expect(source).not.toContain("JNI");
});

test("the JVM emitter specializes only closed integer parameter entries", () => {
  const roots = [
    "directIntegerParameter",
    "publicNumberParameter",
    "callPublicNumberParameter",
  ];
  const planned = planExecutableCompilation(integerParameters, {
    backend: "c",
    externalFunctionRoots: roots,
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const module = deserializeModule(planned.plan.ir);
  const bounded = module.functions.find(({ name }) =>
    name.endsWith(".boundedIntegerLoop") || name === "boundedIntegerLoop"
  );
  const publicParameter = module.functions.find(({ name }) =>
    name.endsWith(".publicNumberParameter") || name === "publicNumberParameter"
  );
  expect(bounded).toBeDefined();
  expect(publicParameter).toBeDefined();
  if (bounded === undefined || publicParameter === undefined) return;
  const encoded = (name: string): string => {
    let result = "f_";
    for (const byte of new TextEncoder().encode(name)) {
      result += byte.toString(16).padStart(2, "0");
    }
    return result;
  };

  const source = emitJvmSerializedModule(planned.plan.ir, {
    className: "IntegerParameters",
    functionExports: roots.map((functionName) => ({
      functionName,
      methodName: functionName,
    })),
  });

  const boundedName = encoded(bounded.name);
  const boundedStart = source.search(
    new RegExp(`private static (?:int|double) ${boundedName}\\(int `, "u"),
  );
  expect(boundedStart).toBeGreaterThanOrEqual(0);
  const boundedEnd = source.indexOf("\n  private static", boundedStart + 1);
  const boundedSource = source.slice(
    boundedStart,
    boundedEnd < 0 ? source.length : boundedEnd,
  );
  expect(boundedSource).not.toContain("ntsToInt32");

  expect(source).toContain(
    `private static int ${encoded(publicParameter.name)}(double `,
  );
  expect(source).toContain("public static double publicNumberParameter(double a0)");
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
