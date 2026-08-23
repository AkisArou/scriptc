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
  expect(source).not.toContain(`ntsToInt32(${integerDeclaration[1]})`);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = 2147483647d;/u);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = 0\.5d;/u);
  expect(source).toMatch(/\bdouble l_[0-9a-f]+ = -0\.0d;/u);
});
