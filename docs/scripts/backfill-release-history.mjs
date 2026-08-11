import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const corpusRoot = resolve(process.argv[2] ?? "");
const casesDir = join(corpusRoot, "cases");
const concurrency = Number.parseInt(process.env.BACKFILL_CONCURRENCY ?? "8", 10);

function execute(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32_000_000,
    ...options,
  });
}

function aliasFor(version) {
  return `scriptc-v${version.replaceAll(".", "")}`;
}

function runCoverage(cliPath, source) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, "coverage", source, "--dynamic"], {
      cwd: corpusRoot,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const analyzed = stdout.match(/statements analyzed\s+(\d+)/);
      const staticMatch = stdout.match(/compile statically\s+(\d+)/);
      const dynamicMatch = stdout.match(/compile dynamically\s+(\d+)/);
      if (!analyzed || !staticMatch) {
        resolveResult({
          exitCode,
          analyzable: false,
          stdout,
          stderr,
        });
        return;
      }
      const statements = Number.parseInt(analyzed[1], 10);
      const staticStatements = Number.parseInt(staticMatch[1], 10);
      const dynamicStatements = dynamicMatch ? Number.parseInt(dynamicMatch[1], 10) : 0;
      resolveResult({
        exitCode,
        analyzable: true,
        hasProgramBlocker: /\n\s*blockers:/.test(stdout),
        statements,
        staticStatements,
        dynamicStatements,
        blockedStatements: statements - staticStatements - dynamicStatements,
      });
    });
  });
}

async function runPool(tasks, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function consume() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(tasks[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => consume()));
  return results;
}

const versions = execute("git", ["tag", "--sort=version:refname"])
  .trim()
  .split("\n")
  .map((tag) => tag.slice(1));
const releases = JSON.parse(
  execute("gh", [
    "release",
    "list",
    "--repo",
    "vercel-labs/scriptc",
    "--limit",
    "100",
    "--json",
    "tagName,publishedAt",
  ]),
);
const releaseDates = new Map(releases.map((release) => [release.tagName, release.publishedAt]));
const caseNames = (await readdir(casesDir)).filter((name) => name.endsWith(".ts")).sort();
const installRoot = await mkdtemp(join(tmpdir(), "scriptc-release-history-"));

try {
  const packages = versions.map(
    (version) => `${aliasFor(version)}@npm:scriptc@${version}`,
  );
  execute(
    "pnpm",
    ["add", "--dir", installRoot, "--ignore-workspace", "--silent", ...packages],
    { cwd: corpusRoot },
  );

  const tasks = versions.flatMap((version) =>
    caseNames.map((caseName) => ({
      version,
      caseName,
      cliPath: join(installRoot, "node_modules", aliasFor(version), "dist", "main.js"),
      source: join(casesDir, caseName),
    })),
  );
  const coverageResults = await runPool(tasks, async (task) => ({
    version: task.version,
    caseName: task.caseName,
    coverage: await runCoverage(task.cliPath, task.source),
  }));
  const latestVersion = versions.at(-1);
  const statementBaseline = new Map(
    coverageResults
      .filter((result) => result.version === latestVersion && result.coverage.analyzable)
      .map((result) => [result.caseName, result.coverage.statements]),
  );
  const corpusByVersion = new Map();
  for (const result of coverageResults) {
    const group = corpusByVersion.get(result.version) ?? [];
    const statements = result.coverage.analyzable
      ? result.coverage.statements
      : statementBaseline.get(result.caseName);
    if (statements === undefined) {
      throw new Error(`No statement baseline for ${result.caseName}`);
    }
    group.push(
      result.coverage.analyzable
        ? result.coverage
        : {
            ...result.coverage,
            statements,
            staticStatements: 0,
            dynamicStatements: 0,
            blockedStatements: statements,
            hasProgramBlocker: true,
          },
    );
    corpusByVersion.set(result.version, group);
  }

  let previousManifest = null;
  const history = versions.map((version) => {
    const tag = `v${version}`;
    const manifestTag = version === "0.0.2" ? "v0.0.3" : tag;
    const manifest = JSON.parse(
      execute("git", ["show", `${manifestTag}:packages/compiler/surface-manifest.json`]),
    );
    const entries = new Map(manifest.entries.map((entry) => [entry.id, entry.status]));
    const count = (status) => manifest.entries.filter((entry) => entry.status === status).length;
    let promotedToStatic = 0;
    let newStatic = 0;
    let newEntries = 0;
    if (previousManifest) {
      for (const [id, status] of entries) {
        if (!previousManifest.has(id)) {
          newEntries += 1;
          if (status === "static") newStatic += 1;
        } else if (status === "static" && previousManifest.get(id) !== "static") {
          promotedToStatic += 1;
        }
      }
    }
    previousManifest = entries;
    const cases = corpusByVersion.get(version);
    const sum = (key) => cases.reduce((total, item) => total + item[key], 0);
    const staticPrograms = cases.filter(
      (item) =>
        item.analyzable &&
        !item.hasProgramBlocker &&
        item.staticStatements === item.statements &&
        item.dynamicStatements === 0,
    ).length;
    const dynamicPrograms = cases.filter(
      (item) => item.analyzable && !item.hasProgramBlocker,
    ).length;
    return {
      version,
      publishedAt: releaseDates.get(tag),
      source: version === "0.0.2" ? "reconstructed" : "manifest",
      surface: {
        total: manifest.entries.length,
        staticEntries: count("static"),
        dynamicEntries: count("dynamic-only"),
        unsupportedEntries: count("unsupported"),
        promotedToStatic,
        newStatic,
        newEntries,
      },
      corpus: {
        statements: sum("statements"),
        staticStatements: sum("staticStatements"),
        dynamicStatements: sum("dynamicStatements"),
        blockedStatements: sum("blockedStatements"),
        staticPrograms,
        dynamicPrograms,
        totalPrograms: cases.length,
        unanalyzablePrograms: cases.filter((item) => !item.analyzable).length,
      },
    };
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        corpusRoot,
        policy:
          "Programs rejected by the typecheck gate use their latest known statement count and count every statement as blocked.",
        history,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(installRoot, { recursive: true, force: true });
}
