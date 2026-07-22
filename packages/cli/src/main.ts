#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze, compile, compileC, renderAll, renderCoverage, resolveProvenanceSources, setProvenanceSources } from "@scriptc/compiler";

const USAGE = `scriptc — TypeScript/JavaScript to native executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to a native executable
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --dynamic  what a --dynamic build compiles, and what still blocks it

Options:
  -o, --out <path>   output executable path (default: .scriptc/<name>)
      --backend <b>  code generator: llvm (default — emits LLVM IR text,
                     compiled by the same clang) or c (the readable reference
                     backend). The default falls back to the C backend when a
                     program is outside the LLVM tier (a one-line stderr note
                     says so; program behavior is identical); an explicit
                     --backend llvm fails loudly instead of falling back
      --from-c       treat input as a C (or .ll) file (toolchain plumbing/debugging)
      --keep-c       keep the generated program TU next to the executable
                     (default; the .ll — or the .c under --backend=c or
                     when the build fell back)
      --no-keep-c    delete the generated program TU after compiling
      --emit-ir      also write the IR as JSON next to the executable
      --sanitize     build with ASan + runtime RC audit
      --dynamic      embed the dynamic engine (adds ~620KB; static stays the default)
      --npm-static <pkg[,pkg…]|auto>
                     compile the named npm packages' shipped JS statically as
                     program modules (repeatable; "auto" opts in every eligible
                     direct import: own .d.ts, unminified JS, no build-transform
                     markers). A package preflight refuses falls back to the
                     island (--dynamic) with a coverage-report note — opt-in,
                     experimental
      --provenance-sources
                     EXPERIMENTAL: compile npm dependencies from their
                     provenance-attested SOURCE (fetched at the attested
                     commit) as static program modules; packages without a
                     usable attestation keep the island path (a note, never
                     a failure)
  -h, --help         show this help
`;

/* The exit discipline: NEVER process.exit() after writing output. stdout/
 * stderr to a PIPE are async streams — process.exit() drops whatever libuv
 * hasn't flushed yet, which truncates large diagnostic renders at the pipe
 * buffer (observed: 64KB cut mid-code-frame). Every path sets
 * process.exitCode and returns instead; Node exits naturally once the
 * streams drain. */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  throw new CliExit(1);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string", short: "o" },
      // No parseArgs default: unset means the compiler's default lane
      // (LLVM with the transparent C fallback); an explicit value pins.
      backend: { type: "string" },
      "from-c": { type: "boolean", default: false },
      "keep-c": { type: "boolean", default: true },
      "emit-ir": { type: "boolean", default: false },
      sanitize: { type: "boolean", default: false },
      dynamic: { type: "boolean", default: false },
      "npm-static": { type: "string", multiple: true },
      "provenance-sources": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const [command, inputArg] = positionals;
  if (command !== "build" && command !== "run" && command !== "coverage") {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
  if (!inputArg) fail(`missing input file\n\n${USAGE}`);
  const input = resolve(inputArg);
  const backend = values.backend;
  if (backend !== undefined && backend !== "c" && backend !== "llvm") {
    fail(`unknown backend "${backend}" (supported: c, llvm)\n\n${USAGE}`);
  }

  // --npm-static: repeatable and comma-splittable; the literal "auto"
  // switches to eligibility-based detection (mixing "auto" with names
  // is rejected — the shapes answer different questions).
  const npmStaticRaw = (values["npm-static"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1) fail(`--npm-static auto cannot be combined with package names\n\n${USAGE}`);
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  // --provenance-sources resolves BEFORE the program loads (tsgo needs the
  // source "paths" at creation): attestations and source trees fetch (or
  // ride the content-addressed cache / the offline manifest), the registry
  // installs, and every fallback prints as a note — never a failure.
  const provenance = values["provenance-sources"] ? await resolveProvenanceSources(input) : null;
  if (provenance !== null) {
    setProvenanceSources(provenance);
    for (const pkg of provenance.packages) {
      process.stderr.write(
        `provenance: ${pkg.name}@${pkg.version} ← ${pkg.repo.replace(/^git\+/, "")} @ ${pkg.commit.slice(0, 12)} (source compiles statically)\n`,
      );
    }
    for (const note of provenance.notes) process.stderr.write(`provenance: ${note}\n`);
  }

  if (command === "coverage") {
    const { coverage } = analyze(input, { dynamic: values.dynamic, ...(npmStatic !== undefined ? { npmStatic } : {}) });
    const color = process.stdout.isTTY ?? false;
    process.stdout.write(renderCoverage(coverage, { color }) + "\n");
    return coverage.preflightFailed ? 1 : 0;
  }

  const outDir = values.out ? dirname(resolve(values.out)) : join(dirname(input), ".scriptc");
  const stem = basename(input).replace(/\.(ts|js|mjs|cjs|c|ll)$/, "");
  const outPath = values.out ? resolve(values.out) : join(outDir, stem);

  const build = async (): Promise<string> => {
    if (values["from-c"]) {
      await compileC({ cPath: input, outPath, sanitize: values.sanitize, dynamic: values.dynamic });
      return outPath;
    }
    const result = await compile(input, {
      outPath,
      outDir,
      emitIr: values["emit-ir"],
      sanitize: values.sanitize,
      dynamic: values.dynamic,
      ...(backend !== undefined ? { backend } : {}),
      ...(npmStatic !== undefined ? { npmStatic } : {}),
    });
    if (!result.ok) {
      const color = process.stderr.isTTY ?? false;
      process.stderr.write(renderAll(result.diagnostics, result.sourceTexts, { color }) + "\n");
      const n = result.diagnostics.length;
      process.stderr.write(`\n${n} error${n === 1 ? "" : "s"}.\n`);
      throw new CliExit(1);
    }
    // The lane-change note: the ONLY case where silence would be dishonest
    // is the default lane quietly building through C — one stderr line
    // names the refusal. A successful LLVM build is the documented default
    // (and the kept .ll next to the binary is the durable record), and an
    // explicit --backend was the user's own choice — neither gets a line.
    if (result.llvmRefusal !== undefined) {
      process.stderr.write(`scriptc: backend c (llvm refused: ${result.llvmRefusal})\n`);
    }
    if (!values["keep-c"]) rmSync(result.cPath, { force: true });
    return result.binaryPath;
  };

  const binary = await build();

  if (command === "run") {
    return new Promise<number>((resolveExit) => {
      const child = spawn(binary, [], { stdio: "inherit" });
      child.on("exit", (code, signal) => {
        if (signal) {
          process.stderr.write(`scriptc: program killed by ${signal}\n`);
          resolveExit(1);
        } else {
          resolveExit(code ?? 0);
        }
      });
    });
  }
  process.stdout.write(`${binary}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CliExit) process.exitCode = err.code;
  else throw err;
}
