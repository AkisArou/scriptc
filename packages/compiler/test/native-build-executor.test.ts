import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  compile,
  compileC,
  ExternalCcPlanError,
  planExternalCCommand,
  type CcOptions,
  type CcCommand,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) =>
      await rm(path, { recursive: true, force: true })
    ),
  );
});

describe("native build executor", () => {
  test("receives the complete request and owns executable materialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-native-executor-"));
    temporaryDirectories.push(directory);
    const entryPath = join(directory, "main.ts");
    const outPath = join(directory, "program");
    await writeFile(entryPath, "console.log(42);\n");

    let received: Readonly<CcOptions> | null = null;
    let command: Readonly<CcCommand> | null = null;
    const result = await compile(entryPath, {
      outDir: join(directory, "out"),
      outPath,
      backend: "c",
      nativeBuildExecutor: async (options) => {
        received = options;
        await compileC({
          ...options,
          commandExecutor: async (planned) => {
            command = planned;
            await execFileAsync(planned.executable, [...planned.arguments]);
          },
        });
        return { binaryPath: options.outPath };
      },
    });

    expect(result.ok).toBe(true);
    expect(received).not.toBeNull();
    expect(Object.isFrozen(received)).toBe(true);
    expect(received?.cPath).toBe(join(directory, "out", "main.c"));
    expect(received?.outPath).toBe(outPath);
    expect(received?.cacheIdentity).toBe("scriptc-generated-v1");
    expect((await execFileAsync(outPath)).stdout).toBe("42\n");

    const external = planExternalCCommand(command!, {
      program: { id: "program/main", path: received!.cPath },
      runtime: {
        id: "runtime/scriptc",
        path: command!.runtimeDirectory,
      },
      linkInputs: [],
      output: { id: "product/main", path: received!.outPath },
    });
    expect(external.plan.driver.command).toBe("clang");
    expect(external.plan.inputs).toEqual(["runtime/scriptc", "program/main"]);
    expect(external.plan.arguments).toContainEqual({
      kind: "input-path",
      input: "runtime/scriptc",
      path: "src/scr_async.c",
    });
    expect(external.plan.arguments.at(-1)).toEqual({
      kind: "output-path",
      output: "product/main",
    });
    expect(JSON.stringify(external.plan)).not.toContain(received?.cPath);
    expect(JSON.stringify(external.plan)).not.toContain(received?.outPath);
    expect(external.bindings.runtimeDirectory).toMatch(/packages\/runtime$/u);
  });

  test("external planning rejects undeclared physical paths", () => {
    expect(() => planExternalCCommand(
      {
        executable: "clang",
        arguments: ["/ambient/undeclared.c"],
        runtimeDirectory: "/runtime",
        targetPlatform: "linux",
      },
      {
        program: { id: "program/main", path: "/generated/main.c" },
        runtime: { id: "runtime/scriptc", path: "/runtime" },
        linkInputs: [],
        output: { id: "product/main", path: "/output/main" },
      },
    )).toThrowError(ExternalCcPlanError);
  });
});
