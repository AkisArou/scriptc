import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  compile,
  emitExecutableCompilationPlan,
  planExecutableCompilation,
  type CcOptions,
  type ExecutableCompilationPlan,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true })
    ),
  );
});

describe.each(["c", "llvm"] as const)(
  "executable compilation plan (%s)",
  (backend) => {
    test("is path-free, immutable, and emits exactly like compile", async () => {
      const directory = await mkdtemp(join(tmpdir(), "scriptc-executable-plan-"));
      temporaryDirectories.push(directory);
      const entryPath = join(directory, "main.ts");
      const helperPath = join(directory, "answer.ts");
      const entrySource =
        'import { answer } from "./answer.js";\nconsole.log(answer);\n';
      const helperSource = "export const answer = 40 + 2;\n";
      await writeFile(entryPath, entrySource);
      await writeFile(helperPath, helperSource);
      const options = {
        backend,
        nativeLinkInputs: ["object/platform"],
        nativeSystemLibraries: ["platform"],
      } as const;

      const planned = planExecutableCompilation(entryPath, options);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(planned.plan.schema).toBe("scriptc.executable-compilation-plan");
      expect(planned.plan.schemaVersion).toBe(1);
      expect(planned.plan.backend).toBe(backend);
      expect(planned.plan.nativeBuild.linkInputs).toEqual(["object/platform"]);
      expect(planned.plan.nativeBuild.systemLibraries).toEqual(["platform"]);
      expect(Object.isFrozen(planned.plan)).toBe(true);
      expect(Object.isFrozen(planned.plan.target)).toBe(true);
      expect(Object.isFrozen(planned.plan.nativeBuild)).toBe(true);
      expect(Object.isFrozen(planned.plan.nativeBuild.linkInputs)).toBe(true);
      expect(JSON.stringify(planned.plan)).not.toContain(directory);

      const relocatedDirectory = await mkdtemp(
        join(tmpdir(), "scriptc-executable-plan-relocated-"),
      );
      temporaryDirectories.push(relocatedDirectory);
      await writeFile(join(relocatedDirectory, "main.ts"), entrySource);
      await writeFile(join(relocatedDirectory, "answer.ts"), helperSource);
      const relocated = planExecutableCompilation(
        join(relocatedDirectory, "main.ts"),
        options,
      );
      expect(relocated.ok).toBe(true);
      if (!relocated.ok) return;
      expect(relocated.plan).toEqual(planned.plan);

      let directBuild: Readonly<CcOptions> | null = null;
      const direct = await compile(entryPath, {
        ...options,
        outDir: join(directory, "direct"),
        outPath: join(directory, "direct", "main"),
        nativeBuildExecutor: async (request) => {
          directBuild = request;
          return { binaryPath: request.outPath };
        },
      });
      expect(direct.ok).toBe(true);
      if (!direct.ok) return;
      expect(emitExecutableCompilationPlan(planned.plan)).toBe(
        (await readFile(direct.cPath, "utf8"))
          .replaceAll(entryPath, "main.ts")
          .replaceAll(helperPath, "answer.ts"),
      );
      const { cPath: _cPath, outPath: _outPath, ...directNativeBuild } =
        directBuild!;
      expect(directNativeBuild).toEqual(planned.plan.nativeBuild);
    });
  },
);

test("emission rejects an unknown executable plan schema", () => {
  expect(() =>
    emitExecutableCompilationPlan({
      schema: "scriptc.unknown",
      schemaVersion: 1,
    } as unknown as ExecutableCompilationPlan)
  ).toThrowError(/Unsupported ScriptC executable compilation plan schema/u);
});

test("emission rejects an unknown backend before reading IR", () => {
  expect(() =>
    emitExecutableCompilationPlan({
      schema: "scriptc.executable-compilation-plan",
      schemaVersion: 1,
      backend: "machine-code",
      target: { platform: "linux", pointerBits: 64, wasi: false },
      ir: "{}",
      entrySource: "",
      nativeBuild: {},
    } as unknown as ExecutableCompilationPlan)
  ).toThrowError(/invalid backend/u);
});
