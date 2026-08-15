import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule } from "./backend/llvm/emitter.js";
import type { CcOptions } from "./backend/cc.js";
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

/** Deterministically materializes the program translation unit described by
 * a compilation plan. The IR version and structure are revalidated at this
 * process boundary before either backend sees it. */
export function emitExecutableCompilationPlan(
  plan: ExecutableCompilationPlan,
): string {
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
