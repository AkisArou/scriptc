#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { emitExecutableCompilationPlan } from "./executable-plan.js";
import type { ExecutableCompilationPlan } from "./executable-plan.js";

async function main(): Promise<void> {
  const [planPath, outputPath, ...extra] = process.argv.slice(2);
  if (planPath === undefined || outputPath === undefined || extra.length > 0) {
    throw new Error(
      "usage: executable-emitter-cli <compilation-plan.json> <program.c|program.ll>",
    );
  }
  const plan = JSON.parse(
    await readFile(planPath, "utf8"),
  ) as ExecutableCompilationPlan;
  const extension = plan.backend === "llvm" ? ".ll" : ".c";
  if (!outputPath.endsWith(extension)) {
    throw new Error(`ScriptC ${plan.backend} emission requires a ${extension} output`);
  }
  await writeFile(outputPath, emitExecutableCompilationPlan(plan));
}

await main();
