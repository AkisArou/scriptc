#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { sandboxImageConfig } from "./sandbox-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const vcpus = process.env.SCRIPTC_SANDBOX_VCPUS ?? "8";
const testWorkers = process.env.SCRIPTC_TEST_WORKERS ?? "4";
const localTestWorkers = process.env.SCRIPTC_LOCAL_TEST_WORKERS ?? "2";
const sandboxTimeout = process.env.SCRIPTC_SANDBOX_TIMEOUT ?? "45m";
const corpusFiles = [
  "tests/harness/differential.test.ts",
  "tests/harness/llvm-differential.test.ts",
  "tests/harness/npm.test.ts",
  "tests/harness/server.test.ts",
];

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    keep: { type: "boolean" },
    lane: { type: "string", default: "both" },
    "remote-only": { type: "boolean" },
    shards: { type: "string", default: "3" },
  },
});

if (values.help) {
  console.log(`Run the scriptc test suite across Vercel Sandboxes.

Usage:
  pnpm test:sandbox [--lane plain|san|both] [--shards 3] [--remote-only] [--keep]

Environment:
  SCRIPTC_SANDBOX_IMAGE     Fully qualified VCR image (required; may be in .env.local)
  SCRIPTC_SANDBOX_VCPUS     vCPUs per sandbox (default: 8)
  SCRIPTC_SANDBOX_TIMEOUT   sandbox and command timeout (default: 45m)
  SCRIPTC_TEST_WORKERS      Vitest workers per sandbox (default: 4)
  SCRIPTC_LOCAL_TEST_WORKERS Vitest workers per local lane (default: 2)`);
  process.exit(0);
}

const { project, sandboxImage: image, team } = sandboxImageConfig();

if (!["plain", "san", "both"].includes(values.lane)) {
  throw new Error(`--lane must be plain, san, or both (got ${values.lane})`);
}
const shardCount = Number(values.shards);
if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 10) {
  throw new Error(`--shards must be an integer from 1 to 10 (got ${values.shards})`);
}

const lanes = values.lane === "both" ? ["plain", "san"] : [values.lane];
const nonce = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const workers = lanes.flatMap((lane) =>
  Array.from({ length: shardCount }, (_, offset) => {
    const shard = offset + 1;
    return {
      lane,
      shard,
      label: `${lane} ${shard}/${shardCount}`,
      name: `scriptc-${lane}-${shard}-${nonce}`,
    };
  }),
);
const created = new Set();
const children = new Set();
let cleanupPromise;
let handlingSignal = false;

function lineWriter(destination, prefix, handleLine) {
  let buffered = "";
  return {
    write(chunk) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!handleLine?.(line)) destination.write(`${prefix}${line}\n`);
      }
    },
    end() {
      if (buffered && !handleLine?.(buffered)) destination.write(`${prefix}${buffered}\n`);
    },
  };
}

function run(command, args, { env = {}, exitMarker, label, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", ...env },
      stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const prefix = label ? `[${label}] ` : "";
    let remoteExitCode;
    const stdout = lineWriter(process.stdout, prefix, (line) => {
      if (!exitMarker) return false;
      const match = new RegExp(`^${exitMarker}(\\d+)$`).exec(line);
      if (!match) return false;
      remoteExitCode = Number(match[1]);
      return true;
    });
    const stderr = lineWriter(process.stderr, prefix);
    if (!quiet) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => stdout.write(chunk));
      child.stderr.on("data", (chunk) => stderr.write(chunk));
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      children.delete(child);
      stdout.end();
      stderr.end();
      if (code !== 0) {
        reject(new Error(`${label ?? command} exited ${signal ?? code}`));
      } else if (exitMarker && remoteExitCode === undefined) {
        reject(new Error(`${label ?? command} did not report its remote exit status`));
      } else if (remoteExitCode !== undefined && remoteExitCode !== 0) {
        reject(new Error(`${label ?? command} remote command exited ${remoteExitCode}`));
      } else {
        resolve();
      }
    });
  });
}

const scopeArgs = ["--scope", team, "--project", project];
const vercel = ([group, command, ...args], options) =>
  run("vercel", [group, command, ...scopeArgs, ...args], options);
// `vercel sandbox exec` does not propagate the remote process's exit code.
// Print a per-command nonce after it finishes and enforce that status here.
const shellQuote = (value) => `'${value.replaceAll("'", `'\"'\"'`)}'`;
const execIn = (worker, command, args, env = {}) => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const exitMarker = `__SCRIPTC_REMOTE_EXIT_${randomBytes(12).toString("hex")}__`;
  const script = `${[command, ...args].map(shellQuote).join(" ")}; scriptc_status=$?; printf '\\n${exitMarker}%s\\n' "$scriptc_status"`;
  return vercel(
    [
      "sandbox",
      "exec",
      "--timeout",
      sandboxTimeout,
      "--workdir",
      "/workspace",
      ...envArgs,
      worker.name,
      "sh",
      "-c",
      script,
    ],
    { exitMarker, label: worker.label },
  );
};

async function createArchive(path) {
  const git = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarArgs = [
    ...(process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : []),
    "--null",
    "-T",
    "-",
    "-czf",
    path,
  ];
  const tar = spawn("tar", tarArgs, {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["pipe", "inherit", "inherit"],
  });
  children.add(git);
  children.add(tar);
  git.stdout.pipe(tar.stdin);
  const wait = (child, name) =>
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`${name} exited ${signal ?? code}`));
      });
    });
  await Promise.all([wait(git, "git ls-files"), wait(tar, "tar")]);
}

async function allWorkers(phase, task) {
  const started = Date.now();
  console.log(`\n${phase} (${workers.length} sandboxes)...`);
  const results = await Promise.allSettled(workers.map(task));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    for (const failure of failures) console.error(failure.reason);
    throw new Error(`${phase} failed for ${failures.length} sandbox${failures.length === 1 ? "" : "es"}`);
  }
  console.log(`${phase} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function cleanup() {
  if (values.keep || created.size === 0) return;
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      console.log(`\nRemoving ${created.size} disposable sandbox${created.size === 1 ? "" : "es"}...`);
      const results = await Promise.allSettled(
        [...created].map((name) =>
          vercel(["sandbox", "remove", name], { label: name, quiet: true }).then(() => created.delete(name)),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        console.error(`Failed to remove ${failures.length} sandbox${failures.length === 1 ? "" : "es"}.`);
      }
    })();
  }
  await cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    for (const child of children) child.kill("SIGTERM");
    if (!values.keep && created.size) {
      console.log(`\nRemoving ${created.size} disposable sandbox${created.size === 1 ? "" : "es"}...`);
      spawnSync(
        "vercel",
        ["sandbox", "remove", ...scopeArgs, ...created],
        {
          cwd: root,
          env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
          stdio: "inherit",
          timeout: 30_000,
        },
      );
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const temp = await mkdtemp(join(tmpdir(), "scriptc-sandbox-test-"));
const archive = join(temp, "worktree.tar.gz");
const suiteStarted = Date.now();
let failure;

try {
  console.log(
    `Running ${lanes.join("+")} corpus lanes in ${workers.length} ${vcpus}-vCPU sandboxes from ${image} (${shardCount} shards/lane).`,
  );
  console.log("Packing the exact tracked + untracked, non-ignored worktree...");
  await createArchive(archive);

  const remote = (async () => {
    await allWorkers("Creating", async (worker) => {
      created.add(worker.name);
      await vercel(
        [
          "sandbox",
          "create",
          "--name",
          worker.name,
          "--image",
          image,
          "--timeout",
          sandboxTimeout,
          "--vcpus",
          vcpus,
          "--non-persistent",
        ],
        { label: worker.label },
      );
    });

    await allWorkers("Uploading worktree", (worker) =>
      vercel(["sandbox", "copy", archive, `${worker.name}:/tmp/worktree.tar.gz`], { label: worker.label }),
    );

    await allWorkers("Preparing worktree", async (worker) => {
      await execIn(worker, "tar", ["-xzf", "/tmp/worktree.tar.gz", "-C", "/workspace"]);
      await execIn(worker, "pnpm", ["install", "--frozen-lockfile"]);
      await execIn(worker, "pnpm", ["build"]);
    });

    await allWorkers("Testing corpus", async (worker) => {
      const testEnv = {
        CI: "1",
        SCRIPTC_TEST_SHARD: `${worker.shard}/${shardCount}`,
        SCRIPTC_TEST_WORKERS: testWorkers,
        ...(worker.lane === "san"
          ? {
              SCRIPTC_SAN: "1",
              // Match the macOS shipping lane: Apple ASan has no
              // LeakSanitizer, while scriptc's RC audit owns leak
              // detection (including its intentional-abandonment rules).
              ASAN_OPTIONS: "detect_leaks=0",
            }
          : {}),
      };
      await execIn(worker, "pnpm", ["test", ...corpusFiles], testEnv);
    });
  })();

  const local = values["remote-only"]
    ? Promise.resolve()
    : (async () => {
        console.log("\nBuilding and testing platform-sensitive files locally...");
        await run("pnpm", ["build"], { label: "local build" });
        const results = await Promise.allSettled(
          lanes.map((lane) =>
            run(
              "pnpm",
              [
                "test",
                ...corpusFiles.map((file) => `--exclude=${file}`),
              ],
              {
                env: {
                  CI: "1",
                  SCRIPTC_TEST_WORKERS: localTestWorkers,
                  ...(lane === "san" ? { SCRIPTC_SAN: "1" } : {}),
                },
                label: `local ${lane}`,
              },
            ),
          ),
        );
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) {
          for (const result of failures) console.error(result.reason);
          throw new Error(`${failures.length} local test lane${failures.length === 1 ? "" : "s"} failed`);
        }
      })();

  const results = await Promise.allSettled([remote, local]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    for (const result of failures) console.error(result.reason);
    throw new Error(`${failures.length} test path${failures.length === 1 ? "" : "s"} failed`);
  }

  console.log(
    `\n${lanes.length === 2 ? "Both test lanes" : `${lanes[0]} test lane`} passed in ${((Date.now() - suiteStarted) / 60_000).toFixed(1)} minutes.`,
  );
} catch (error) {
  failure = error;
} finally {
  await cleanup();
  await rm(temp, { recursive: true, force: true });
  if (values.keep && created.size) {
    console.log(`Kept sandboxes:\n${[...created].map((name) => `  ${name}`).join("\n")}`);
  }
}

if (failure) throw failure;
