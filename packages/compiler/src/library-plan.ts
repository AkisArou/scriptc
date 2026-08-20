import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule } from "./backend/llvm/emitter.js";
import {
  compileLibArchive,
  planExternalCCommand,
  type ExternalCcPlan,
  type LibArchiveOptions,
} from "./backend/cc.js";
import { deserializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";

/**
 * The archive settings a library implies, with every path and every piece of
 * translation-unit content removed.
 *
 * `programSource` and `identityCSource` are omitted rather than carried:
 * both are derived from the emitted translation unit at archive time, when
 * the volatile build id is split into its own tiny unit, so a plan carrying
 * them would duplicate the very unit it already describes.
 */
export type LibraryNativeBuildPlan = Readonly<
  Omit<
    LibArchiveOptions,
    "cPath" | "outPath" | "commandExecutor" | "programSource" | "identityCSource"
  >
>;

/**
 * A path-free, serializable boundary between ScriptC's library lowering and
 * the archive that carries it — the executable plan's counterpart, and
 * deliberately its mirror rather than its variation.
 *
 * The product is a STATIC ARCHIVE. Turning one into a shared object is the
 * embedding target's business, because how a library is packaged for a host
 * platform is where the platform knowledge lives; the compiler's product
 * stays one kind.
 *
 * Its objects are position-independent unconditionally. That is a property of
 * this product rather than an option on it: a library exists to be embedded,
 * and a non-PIC archive cannot become a shared object on x86_64 or aarch64 —
 * the embedder would discover the compiler's decision as a relocation error
 * at its own link step, which is the plan/execute split violated in spirit.
 * A flag no caller sets to false is a field with no information in it.
 */
export interface LibraryCompilationPlan {
  readonly schema: "scriptc.library-compilation-plan";
  readonly schemaVersion: 1;
  readonly emission: "c" | "llvm";
  readonly target: {
    readonly platform: string;
    readonly pointerBits: 32 | 64;
  };
  readonly ir: string;
  readonly entrySource: string;
  readonly nativeBuild: LibraryNativeBuildPlan;
  /**
   * The contract JSON a profile's `sidecar` section declares, or null.
   *
   * Carried as CONTENT rather than produced by a command: it is computed
   * from the profile and the lowered module, so the embedder writes it as an
   * ordinary artifact beside the archive instead of the compiler reaching
   * for a path.
   */
  readonly sidecar: string | null;
}

/** One compiled object, named so the embedder can declare it. */
export interface LibraryExternalObject {
  readonly id: string;
  readonly fileName: string;
}

export interface LibraryExternalBuildArtifacts {
  readonly program: string;
  readonly runtime: string;
  readonly output: string;
  /** Prefix for the artifact IDs of the per-source objects the archive holds. */
  readonly objectIdPrefix: string;
}

export interface LibraryExternalBuild {
  /** Every object compiles first, then the archive that collects them. */
  readonly plans: readonly ExternalCcPlan[];
  readonly objects: readonly LibraryExternalObject[];
  readonly bindings: { readonly runtimeDirectory: string };
}

function freezeNativeBuild(
  nativeBuild: LibraryNativeBuildPlan,
): LibraryNativeBuildPlan {
  return Object.freeze({
    ...nativeBuild,
    ...(nativeBuild.localizeSymbols === undefined
      ? {}
      : { localizeSymbols: Object.freeze([...nativeBuild.localizeSymbols]) }),
  });
}

export function defineLibraryCompilationPlan(
  input: Omit<LibraryCompilationPlan, "schema" | "schemaVersion">,
): LibraryCompilationPlan {
  return Object.freeze({
    schema: "scriptc.library-compilation-plan",
    schemaVersion: 1,
    emission: input.emission,
    target: Object.freeze({ ...input.target }),
    ir: input.ir,
    entrySource: input.entrySource,
    nativeBuild: freezeNativeBuild(input.nativeBuild),
    sidecar: input.sidecar,
  });
}

function validateLibraryCompilationPlan(plan: LibraryCompilationPlan): void {
  if (
    plan.schema !== "scriptc.library-compilation-plan" ||
    plan.schemaVersion !== 1
  ) {
    throw new Error("Unsupported ScriptC library compilation plan schema");
  }
  if (plan.emission !== "c" && plan.emission !== "llvm") {
    throw new Error("ScriptC library compilation plan has an invalid emission");
  }
  if (
    typeof plan.target !== "object" ||
    plan.target === null ||
    typeof plan.target.platform !== "string" ||
    plan.target.platform.length === 0
  ) {
    throw new Error("ScriptC library compilation plan has an invalid target");
  }
  if (plan.target.pointerBits !== 32 && plan.target.pointerBits !== 64) {
    throw new Error("ScriptC library compilation plan has an invalid pointer width");
  }
  if (typeof plan.ir !== "string" || typeof plan.entrySource !== "string") {
    throw new Error("ScriptC library compilation plan has invalid source payloads");
  }
  if (plan.sidecar !== null && typeof plan.sidecar !== "string") {
    throw new Error("ScriptC library compilation plan has an invalid sidecar");
  }
}

/** Deterministically materializes the library translation unit a plan
 * describes. The IR is revalidated at this process boundary before either
 * backend sees it, exactly as the executable plan's emission does. */
export function emitLibraryCompilationPlan(plan: LibraryCompilationPlan): string {
  validateLibraryCompilationPlan(plan);
  const module = deserializeModule(plan.ir);
  const diagnostics = validateModule(module);
  if (diagnostics.length > 0) {
    throw new Error(
      `ScriptC library compilation plan contains invalid IR\n${diagnostics
        .map(({ message }) => message)
        .join("\n")}`,
    );
  }
  return plan.emission === "c"
    ? emitModule(module, plan.entrySource)
    : emitLlvmModule(module);
}

/** Produces ScriptC's exact uncached archive-building actions without
 * emitting or materializing any program, runtime, or output artifact. */
export async function planLibraryExternalCBuild(
  plan: LibraryCompilationPlan,
  artifacts: LibraryExternalBuildArtifacts,
): Promise<LibraryExternalBuild> {
  validateLibraryCompilationPlan(plan);
  const extension = plan.emission === "llvm" ? ".ll" : ".c";
  const programPath = `/__scriptc_external__/program${extension}`;
  const outputPath = "/__scriptc_external__/output.lib.a";
  const plans: ExternalCcPlan[] = [];
  const objects: LibraryExternalObject[] = [];
  let runtimeDirectory: string | null = null;

  await compileLibArchive({
    ...plan.nativeBuild,
    cPath: programPath,
    outPath: outputPath,
    commandExecutor: async (command) => {
      runtimeDirectory = command.runtimeDirectory;
      /* A compile carries -c and writes one object; the archiver is what
       * remains. Reading the command rather than counting invocations keeps
       * this honest if the driver ever emits them in another order. */
      const compiling = command.arguments.includes("-c");
      if (compiling) {
        const outputIndex = command.arguments.lastIndexOf("-o");
        const producedPath = command.arguments[outputIndex + 1];
        if (producedPath === undefined) {
          throw new Error("ScriptC emitted an unexpected external compile command");
        }
        const fileName = producedPath.slice(producedPath.lastIndexOf("/") + 1);
        const id = `${artifacts.objectIdPrefix}${fileName}`;
        objects.push(Object.freeze({ id, fileName }));
        plans.push(planExternalCCommand(command, {
          program: { id: artifacts.program, path: programPath },
          runtime: { id: artifacts.runtime, path: command.runtimeDirectory },
          linkInputs: [],
          output: { id, path: producedPath },
        }).plan);
        return;
      }
      /* The archive collects exactly the objects compiled above, which are
       * its inputs the same way a link's are. */
      plans.push(planExternalCCommand(command, {
        program: { id: artifacts.program, path: programPath },
        runtime: { id: artifacts.runtime, path: command.runtimeDirectory },
        linkInputs: objects.map(({ id, fileName }) => ({
          id,
          path: command.arguments.find((argument) =>
            argument.endsWith(`/${fileName}`)
          ) ?? fileName,
        })),
        output: { id: artifacts.output, path: outputPath },
      }).plan);
    },
  });

  const archive = plans.at(-1);
  if (archive === undefined || runtimeDirectory === null) {
    throw new Error("ScriptC external library build planning produced no command");
  }
  if (archive.targetPlatform !== plan.target.platform) {
    throw new Error(
      `ScriptC compiler plan targets ${plan.target.platform}, but its native driver targets ` +
        archive.targetPlatform,
    );
  }
  return Object.freeze({
    plans: Object.freeze(plans),
    objects: Object.freeze(objects),
    bindings: Object.freeze({ runtimeDirectory }),
  });
}
