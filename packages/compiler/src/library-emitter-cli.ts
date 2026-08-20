#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { emitLibraryCompilationPlan } from "./library-plan.js";
import type { LibraryCompilationPlan } from "./library-plan.js";

/* The library counterpart of the executable emitter.
 *
 * Emission is a graph ACTION, not something an embedder does in its build
 * script: it is deterministic, it is expensive, and its output is exactly
 * what a content-addressed cache should hold. The executable path made that
 * choice deliberately, and a library that emitted in-process would keep its
 * program TU outside the graph that builds everything else from it. */
async function main(): Promise<void> {
  const [planPath, outputPath, ...extra] = process.argv.slice(2);
  if (planPath === undefined || outputPath === undefined || extra.length > 0) {
    throw new Error(
      "usage: library-emitter-cli <compilation-plan.json> <program.c|program.ll>",
    );
  }
  const plan = JSON.parse(
    await readFile(planPath, "utf8"),
  ) as LibraryCompilationPlan;
  /* A library profile PINS its emission — there is no fallback concept on
   * this path — so an output extension that disagrees is a build describing
   * one thing and naming another. */
  const extension = plan.emission === "llvm" ? ".ll" : ".c";
  if (!outputPath.endsWith(extension)) {
    throw new Error(`ScriptC ${plan.emission} emission requires a ${extension} output`);
  }
  await writeFile(outputPath, emitLibraryCompilationPlan(plan));
}

await main();
