import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule } from "./backend/llvm/emitter.js";
import {
  compileC,
  planExternalCCommand,
  type CcOptions,
  type ExternalCcPlanResolution,
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
): Promise<ExternalCcPlanResolution> {
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
  const result: { value: ExternalCcPlanResolution | null } = { value: null };
  await compileC({
    ...plan.nativeBuild,
    cPath: programPath,
    outPath: outputPath,
    commandExecutor: async (command) => {
      result.value = planExternalCCommand(command, {
        program: { id: artifacts.program, path: programPath },
        runtime: { id: artifacts.runtime, path: command.runtimeDirectory },
        linkInputs: nativeLinkInputs.map((path, index) => ({
          id: artifacts.linkInputs[index]!,
          path,
        })),
        output: { id: artifacts.output, path: outputPath },
      });
    },
  });
  if (result.value === null) {
    throw new Error("ScriptC external C build planning produced no driver command");
  }
  if (result.value.plan.targetPlatform !== plan.target.platform) {
    throw new Error(
      `ScriptC compiler plan targets ${plan.target.platform}, but its native driver targets ` +
        result.value.plan.targetPlatform,
    );
  }
  return result.value;
}
