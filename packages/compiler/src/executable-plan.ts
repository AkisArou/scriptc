import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule } from "./backend/llvm/emitter.js";
import {
  compileC,
  planExternalCCommand,
  type CcOptions,
  type ExternalCcPlan,
} from "./backend/cc.js";
import { deserializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";

export type ExecutableNativeBuildPlan = Readonly<
  Omit<CcOptions, "cPath" | "outPath" | "commandExecutor">
>;

/** A path-free, serializable boundary between ScriptC semantic lowering and
 * backend source emission. Embedders may content-address this value and run
 * emission as an ordinary build-graph action. */
export interface ExecutableCompilationPlan {
  readonly schema: "scriptc.executable-compilation-plan";
  readonly schemaVersion: 1;
  readonly backend: "c" | "llvm";
  readonly target: {
    readonly platform: string;
    readonly pointerBits: 32 | 64;
    readonly wasi: boolean;
  };
  readonly ir: string;
  readonly entrySource: string;
  readonly nativeBuild: ExecutableNativeBuildPlan;
}

export interface ExecutableExternalBuildArtifacts {
  readonly program: string;
  readonly runtime: string;
  readonly linkInputs: readonly string[];
  readonly output: string;
  /**
   * Prefix for the artifact IDs of per-source runtime objects.
   *
   * Supplying it splits the build: one plan per runtime source, then the link.
   * The runtime depends on the checkout and the toolchain, not on the
   * application, so separating them lets an embedder reuse the runtime across
   * application edits. Omitting it keeps the single combined command.
   */
  readonly runtimeObjectIdPrefix?: string;
}

/** One compiled runtime object, named so the embedder can declare it. */
export interface ExternalRuntimeObject {
  readonly id: string;
  readonly fileName: string;
}

export interface ExecutableExternalBuild {
  /** Runtime object compiles first, then the link that consumes them. */
  readonly plans: readonly ExternalCcPlan[];
  readonly runtimeObjects: readonly ExternalRuntimeObject[];
  readonly bindings: { readonly runtimeDirectory: string };
}

function freezeNativeBuild(
  nativeBuild: ExecutableNativeBuildPlan,
): ExecutableNativeBuildPlan {
  return Object.freeze({
    ...nativeBuild,
    ...(nativeBuild.linkInputs === undefined
      ? {}
      : { linkInputs: Object.freeze([...nativeBuild.linkInputs]) }),
    ...(nativeBuild.systemLibraries === undefined
      ? {}
      : { systemLibraries: Object.freeze([...nativeBuild.systemLibraries]) }),
  });
}

export function defineExecutableCompilationPlan(
  input: Omit<ExecutableCompilationPlan, "schema" | "schemaVersion">,
): ExecutableCompilationPlan {
  return Object.freeze({
    schema: "scriptc.executable-compilation-plan",
    schemaVersion: 1,
    backend: input.backend,
    target: Object.freeze({ ...input.target }),
    ir: input.ir,
    entrySource: input.entrySource,
    nativeBuild: freezeNativeBuild(input.nativeBuild),
  });
}

function validateExecutableCompilationPlan(plan: ExecutableCompilationPlan): void {
  if (
    plan.schema !== "scriptc.executable-compilation-plan" ||
    plan.schemaVersion !== 1
  ) {
    throw new Error("Unsupported ScriptC executable compilation plan schema");
  }
  if (plan.backend !== "c" && plan.backend !== "llvm") {
    throw new Error("ScriptC executable compilation plan has an invalid backend");
  }
  if (
    typeof plan.target !== "object" ||
    plan.target === null ||
    typeof plan.target.platform !== "string" ||
    plan.target.platform.length === 0 ||
    typeof plan.target.wasi !== "boolean"
  ) {
    throw new Error("ScriptC executable compilation plan has an invalid target");
  }
  if (plan.target.pointerBits !== 32 && plan.target.pointerBits !== 64) {
    throw new Error("ScriptC executable compilation plan has an invalid pointer width");
  }
  if (typeof plan.ir !== "string" || typeof plan.entrySource !== "string") {
    throw new Error("ScriptC executable compilation plan has invalid source payloads");
  }
}

/** Deterministically materializes the program translation unit described by
 * a compilation plan. The IR version and structure are revalidated at this
 * process boundary before either backend sees it. */
export function emitExecutableCompilationPlan(
  plan: ExecutableCompilationPlan,
): string {
  validateExecutableCompilationPlan(plan);
  const module = deserializeModule(plan.ir);
  const diagnostics = validateModule(module);
  if (diagnostics.length > 0) {
    throw new Error(
      `ScriptC executable compilation plan contains invalid IR\n${diagnostics
        .map(({ message }) => message)
        .join("\n")}`,
    );
  }
  return plan.backend === "c"
    ? emitModule(module, plan.entrySource)
    : emitLlvmModule(module, {
        pointerBits: plan.target.pointerBits,
        wasi: plan.target.wasi,
      });
}

/** Produces ScriptC's exact uncached native-driver action without emitting or
 * materializing any program, runtime, vendor, or output artifact. Logical
 * native link-input IDs stay in their command-line positions. */
export async function planExecutableExternalCBuild(
  plan: ExecutableCompilationPlan,
  artifacts: ExecutableExternalBuildArtifacts,
): Promise<ExecutableExternalBuild> {
  validateExecutableCompilationPlan(plan);
  const nativeLinkInputs = plan.nativeBuild.linkInputs ?? [];
  if (artifacts.linkInputs.length !== nativeLinkInputs.length) {
    throw new Error(
      `ScriptC executable build declares ${nativeLinkInputs.length} native link input(s), ` +
        `but received ${artifacts.linkInputs.length} artifact ID(s)`,
    );
  }
  const extension = plan.backend === "llvm" ? ".ll" : ".c";
  const programPath = `/__scriptc_external__/program${extension}`;
  const outputPath = "/__scriptc_external__/output";
  const objectDir = artifacts.runtimeObjectIdPrefix === undefined
    ? undefined
    : "/__scriptc_external__/runtime-objects";
  const plans: ExternalCcPlan[] = [];
  const runtimeObjects: ExternalRuntimeObject[] = [];
  let runtimeDirectory: string | null = null;

  await compileC({
    ...plan.nativeBuild,
    cPath: programPath,
    outPath: outputPath,
    ...(objectDir === undefined ? {} : { externalRuntimeObjectDir: objectDir }),
    commandExecutor: async (command) => {
      runtimeDirectory = command.runtimeDirectory;
      /* A compile carries -c and writes one object; everything else is the
       * link. Reading the command rather than counting invocations keeps this
       * honest if the driver ever emits them in another order. */
      const compiling = command.arguments.includes("-c");
      const outputIndex = command.arguments.lastIndexOf("-o");
      const producedPath = command.arguments[outputIndex + 1];
      if (compiling) {
        if (objectDir === undefined || producedPath === undefined) {
          throw new Error("ScriptC emitted an unexpected external compile command");
        }
        const fileName = producedPath.slice(objectDir.length + 1);
        const id = `${artifacts.runtimeObjectIdPrefix}${fileName}`;
        runtimeObjects.push(Object.freeze({ id, fileName }));
        plans.push(planExternalCCommand(command, {
          program: { id: artifacts.program, path: programPath },
          runtime: { id: artifacts.runtime, path: command.runtimeDirectory },
          linkInputs: [],
          output: { id, path: producedPath },
        }).plan);
        return;
      }
      plans.push(planExternalCCommand(command, {
        program: { id: artifacts.program, path: programPath },
        runtime: { id: artifacts.runtime, path: command.runtimeDirectory },
        /* The objects compiled above are inputs to the link exactly as any
         * embedder-supplied one is. */
        linkInputs: [
          ...nativeLinkInputs.map((path, index) => ({
            id: artifacts.linkInputs[index]!,
            path,
          })),
          ...runtimeObjects.map(({ id, fileName }) => ({
            id,
            path: `${objectDir}/${fileName}`,
          })),
        ],
        output: { id: artifacts.output, path: outputPath },
      }).plan);
    },
  });

  const link = plans.at(-1);
  if (link === undefined || runtimeDirectory === null) {
    throw new Error("ScriptC external C build planning produced no driver command");
  }
  if (link.targetPlatform !== plan.target.platform) {
    throw new Error(
      `ScriptC compiler plan targets ${plan.target.platform}, but its native driver targets ` +
        link.targetPlatform,
    );
  }
  return Object.freeze({
    plans: Object.freeze(plans),
    runtimeObjects: Object.freeze(runtimeObjects),
    bindings: Object.freeze({ runtimeDirectory }),
  });
}
