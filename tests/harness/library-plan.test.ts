/* The library compilation plan — the archive's counterpart to the executable
 * plan, and the surface an embedding build graph uses instead of
 * `compileLibrary`.
 *
 * What these prove is agreement rather than mere function: a planner that
 * prepared its module differently from the builder would produce a plan
 * describing a program the builder never makes, and nothing downstream could
 * notice. So the plan's emitted translation unit is compared BYTE FOR BYTE
 * against the one `compileLibrary` writes for the same profile. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileLibrary,
  emitLibraryCompilationPlan,
  planLibraryCompilation,
  planLibraryExternalCBuild,
} from "@scriptc/compiler";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(repoRoot, "tests/library-mode");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-plan");

/** Writes the fixture's profile with an absolute entry, as the mode suite
 * does, and returns its path. */
function stageProfile(
  fixture: string,
  emission: "c" | "llvm",
  profileName = "profile.json",
): { profilePath: string; outDir: string } {
  const dir = join(fixtureRoot, fixture);
  const outDir = join(cacheDir, `${fixture}-${profileName}-${emission}`);
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(
    readFileSync(join(dir, profileName), "utf8"),
  ) as { entry: string; emission: string };
  profile.emission = emission;
  profile.entry = join(dir, profile.entry);
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  return { profilePath, outDir };
}

describe("library compilation plan", () => {
  for (const emission of ["c", "llvm"] as const) {
    it(`emits the same translation unit compileLibrary writes (${emission})`, async () => {
      const { profilePath, outDir } = stageProfile("scalars", emission);

      const planned = await planLibraryCompilation({ profilePath });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      const built = await compileLibrary({ profilePath, outDir });
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      /* The whole point: one preparation, so one program. */
      expect(emitLibraryCompilationPlan(planned.plan)).toBe(
        readFileSync(built.cPath, "utf8"),
      );
      expect(planned.plan.emission).toBe(emission);
    }, 120_000);
  }

  it("carries no output location and no source path in its native build", async () => {
    const { profilePath } = stageProfile("scalars", "c");
    const planned = await planLibraryCompilation({ profilePath });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    /* An embedder supplies every path. A plan that named one would make two
     * builds of the same program differ by where they ran. */
    const nativeBuild = planned.plan.nativeBuild as Record<string, unknown>;
    expect(nativeBuild["cPath"]).toBeUndefined();
    expect(nativeBuild["outPath"]).toBeUndefined();
    expect(nativeBuild["commandExecutor"]).toBeUndefined();
    expect(Object.keys(planned.plan)).not.toContain("outDir");
  }, 120_000);

  it("plans one compile per object and one archive that collects them", async () => {
    const { profilePath } = stageProfile("scalars", "c");
    const planned = await planLibraryCompilation({ profilePath });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const build = await planLibraryExternalCBuild(planned.plan, {
      program: "program.c",
      runtime: "scriptc-runtime",
      output: "library.a",
      objectIdPrefix: "obj/",
    });

    /* Every object the archive holds is declared, and the archive is the
     * last command — an embedder that ran the compiles and then let ScriptC
     * run `ar` itself would have an artifact its graph never saw. */
    expect(build.objects.length).toBeGreaterThan(0);
    expect(build.plans.length).toBe(build.objects.length + 1);
    const archive = build.plans.at(-1)!;
    expect(archive.output).toBe("library.a");
    for (const object of build.objects) {
      expect(object.id.startsWith("obj/")).toBe(true);
      expect(archive.inputs).toContain(object.id);
    }
    /* The program's own object is among them, so the archive carries the
     * compiled TypeScript and not only the runtime. */
    expect(build.plans[0]!.inputs).toContain("program.c");
  }, 120_000);

  it("includes runtime services the embedder requires but the program never reaches", async () => {
    const { profilePath } = stageProfile("scalars", "c");

    /* The `scalars` fixture retains no callback, so nothing in the module
     * selects the retained-callback runtime. A HOST runtime that calls
     * scr_retained_callbacks_* or scr_loop_set_attached still needs it, and
     * only the embedder knows that.
     *
     * Getting this wrong is invisible until load. An executable fails at LINK
     * with an undefined symbol; a shared object defers it, so a library that
     * built and archived cleanly dies inside the host with `symbol lookup
     * error` — one layer further from the cause. */
    const withoutRequires = await planLibraryCompilation({ profilePath });
    expect(withoutRequires.ok).toBe(true);
    if (!withoutRequires.ok) return;
    expect(withoutRequires.plan.nativeBuild.retainedCallbacks).toBe(false);

    const withRequires = await planLibraryCompilation({
      profilePath,
      nativeRuntimeRequires: ["retained-callbacks"],
    });
    expect(withRequires.ok).toBe(true);
    if (!withRequires.ok) return;
    expect(withRequires.plan.nativeBuild.retainedCallbacks).toBe(true);

    /* And the requirement reaches the objects the archive actually holds,
     * rather than only the plan that describes them. */
    const build = await planLibraryExternalCBuild(withRequires.plan, {
      program: "program.c",
      runtime: "scriptc-runtime",
      output: "library.a",
      objectIdPrefix: "obj/",
    });
    const objects = build.objects.map(({ fileName }) => fileName);
    expect(objects.some((name) => name.includes("callback"))).toBe(true);
  }, 120_000);

  it("produces an archive that can become a shared object", async () => {
    const { profilePath, outDir } = stageProfile("scalars", "c");
    const built = await compileLibrary({ profilePath, outDir });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    /* The property the plan CLAIMS, checked by the only consumer that can
     * see it. Every other suite links an archive into an EXECUTABLE, where a
     * non-PIC object links happily — which is exactly why the archive shipped
     * without -fPIC while its contract said otherwise. A shared-object link
     * is the first thing that notices, and it notices immediately:
     * `relocation R_X86_64_PC32 ... can not be used when making a shared
     * object`.
     *
     * --whole-archive because the point is that EVERY member is embeddable,
     * not only the ones a link happens to reference. */
    const shared = join(outDir, "library.so");
    expect(() =>
      execFileSync("clang", [
        "-shared",
        "-o",
        shared,
        "-Wl,--whole-archive",
        built.archivePath,
        "-Wl,--no-whole-archive",
        "-lm",
      ], { stdio: "pipe" })
    ).not.toThrow();
  }, 180_000);

  it("refuses to plan an archive whose producers it cannot describe", async () => {
    const { profilePath } = stageProfile("multi", "c", "profile_a.json");
    const planned = await planLibraryCompilation({ profilePath });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    /* `multi`'s profile declares localize_runtime, which rewrites objects
     * through the driver and the archiver. Those are artifacts of their own; until they
     * are planned too, saying so is the only honest answer. */
    await expect(
      planLibraryExternalCBuild(planned.plan, {
        program: "program.c",
        runtime: "scriptc-runtime",
        output: "library.a",
        objectIdPrefix: "obj/",
      }),
    ).rejects.toThrow(/symbol localization/u);
  }, 120_000);
});
