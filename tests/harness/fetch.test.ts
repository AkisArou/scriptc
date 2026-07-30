/* fetch differential: embedded npm code AND user-code fetch (the
 * island-backed ambient — the user-fetch case) issue REAL http requests
 * against local Node servers (tests/fixtures/fetch/servers.mjs — this file
 * runs them in-process; the Linux lane runs the identical routes inside
 * its container) — never the network. Each fixture
 * program runs under Node AND compiled --dynamic with the server's base
 * URL in argv; stdout must match byte-for-byte and exit codes agree. The
 * suite covers the enumerated request-time needs of the AI-SDK graph:
 * text/json bodies, POST with implicit/explicit content-types, header
 * round trips, chunked streaming consumed through the reader protocol,
 * SSE through the real eventsource-parser (TextDecoderStream →
 * EventSourceParserStream — the exact AI-SDK shape), 404-resolves,
 * redirect following, gzip/deflate response decoding, and
 * connection-refused rejection (TypeError "fetch failed", Node's
 * message).
 *
 * SCRIPTC_SAN=1 rebuilds with ASan + the RC audit: transfer/socket handle
 * hygiene and the island's zero-live-allocations teardown audit run over
 * every case.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
// The servers live in the fixture tree (a plain .mjs): the Linux lane runs
// the IDENTICAL routes standalone inside its container.
// eslint-disable-next-line import/no-relative-packages
import { startFetchServers } from "../fixtures/fetch/servers.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/fetch");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/* ── the local servers (tests/fixtures/fetch/servers.mjs: all routes, the
 * refused port, and the counting forward proxy for the NODE_USE_ENV_PROXY
 * opt-in case) ───────────────────────────────────────────────────────── */

let servers: Awaited<ReturnType<typeof startFetchServers>>;
let baseUrl = "";
let refusedUrl = "";
let proxyUrl = "";
let authenticatedProxyUrl = "";
const expectedProxyAuthorization =
  `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;

beforeAll(async () => {
  servers = await startFetchServers();
  ({ baseUrl, refusedUrl, proxyUrl } = servers);
  authenticatedProxyUrl =
    proxyUrl.replace("http://", "http://proxy-user:proxy-pass@");

  // Every child below inherits POISONED proxy env pointing at the refused
  // port: Node's fetch ignores http_proxy/https_proxy without the
  // NODE_USE_ENV_PROXY=1 opt-in, and the embedded runtime must match
  // (libcurl's default is to honor them) — so every case in this file
  // doubles as the regression test for that parity, and any fixture that
  // DID consult the env would fail loudly instead of leaving the machine.
  process.env["http_proxy"] = refusedUrl;
  process.env["https_proxy"] = refusedUrl;
  process.env["HTTP_PROXY"] = refusedUrl;
  process.env["HTTPS_PROXY"] = refusedUrl;
});

afterAll(async () => {
  delete process.env["http_proxy"];
  delete process.env["https_proxy"];
  delete process.env["HTTP_PROXY"];
  delete process.env["HTTPS_PROXY"];
  await servers.close();
});

/* ── build + run (the npm.test.ts pattern) ───────────────────────────── */

interface RunResult {
  stdout: Buffer;
  exitCode: number;
}

async function runBinary(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout?: number,
): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "buffer",
      env,
      timeout,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout)) throw err;
    return { stdout: e.stdout, exitCode: e.code };
  }
}

async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(join(fixturesRoot, "node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `fetch-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: true,
    // Pinned: real-socket fixtures — the compiled lane stays the C
    // reference so a diff is fetch behavior, never a backend-lane change
    // (npm.test.ts rides the default and covers the fallback at scale).
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "fetch fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function buildStatic(
  entry: string,
  backend: "c" | "llvm",
  flavor = "",
): Promise<string> {
  const hash = createHash("sha256");
  const key = hash
    .update(entry)
    .update(readFileSync(entry))
    .update(`static-${backend}-${sanitize ? "san" : "plain"}-${flavor}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `fetch-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    dynamic: false,
    backend,
  });
  if (!result.ok) {
    throw new Error(
      "static fetch fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

const cases = globSync(join(fixturesRoot, "cases/*/main.ts"))
  .sort()
  .map((entry) => ({ name: entry.split("/").at(-2)!, entry }));

describe(`static fetch differential${sanitize ? " (sanitized)" : ""}`, () => {
  const staticCases = ["static", "static-stream", "static-abort-throw"] as const;
  test.for(
    staticCases.flatMap((name) =>
      (["c", "llvm"] as const).map((backend) => [name, backend] as const),
    ),
  )("%s / %s backend", async ([name, backend]) => {
    const entry = join(fixturesRoot, `${name}/main.mts`);
    const binary = await buildStatic(entry, backend);
    const redirectKey = `${name}-${backend}`;
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, baseUrl, `${redirectKey}-node`]),
      runBinary(binary, [baseUrl, `${redirectKey}-native`]),
    ]);
    expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);

  test.for(["c", "llvm"] as const)(
    "static fetch / %s backend settles an abandoned compressed response",
    async (backend) => {
      const entry = join(fixturesRoot, "static-abandon/main.mts");
      const binary = await buildStatic(entry, backend);
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], undefined, 3_000),
        runBinary(binary, [baseUrl], undefined, 3_000),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    },
    120_000,
  );

  test.for(["c", "llvm"] as const)(
    "static fetch / %s backend trusts NODE_EXTRA_CA_CERTS",
    async (backend) => {
      const certs = join(fixturesRoot, "../server/certs");
      const server = createHttpsServer(
        {
          key: readFileSync(join(certs, "localhost-key.pem")),
          cert: readFileSync(join(certs, "localhost.pem")),
        },
        (_request, response) => response.end("secure"),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, () => {
          server.off("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing HTTPS address");
        const entry = join(fixturesRoot, "static-network/main.mts");
        const binary = await buildStatic(entry, backend, "https-extra-ca");
        const argv = [`https://localhost:${address.port}`];
        const env = {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(certs, "ca.pem"),
        };
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, ...argv], env),
          runBinary(binary, argv, env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(
          nodeRes.stdout.toString("utf8"),
        );
        expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
    120_000,
  );

  test.for(["c", "llvm"] as const)(
    "static fetch / %s backend supports IPv6 URL literals and NO_PROXY",
    async (backend) => {
      const server = createHttpServer(
        (_request, response) => response.end("ipv6"),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing HTTP address");
        const entry = join(fixturesRoot, "static-network/main.mts");
        const binary = await buildStatic(entry, backend, "ipv6");
        const argv = [`http://[::1]:${address.port}`];
        const env = {
          ...process.env,
          NODE_USE_ENV_PROXY: "1",
          http_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          no_proxy: "[::1]",
          NO_PROXY: "[::1]",
        };
        const before = servers.proxiedRequests();
        const [nodeRes, nativeRes] = await Promise.all([
          runBinary("node", [entry, ...argv], env),
          runBinary(binary, argv, env),
        ]);
        expect(nativeRes.stdout.toString("utf8")).toBe(
          nodeRes.stdout.toString("utf8"),
        );
        expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
        expect(servers.proxiedRequests() - before).toBe(0);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
    120_000,
  );

  test("the dynamic curl comparison switch leaves static fetch native", async () => {
    const previous = process.env["SCRIPTC_FETCH_CURL"];
    process.env["SCRIPTC_FETCH_CURL"] = "1";
    try {
      const entry = join(fixturesRoot, "static/main.mts");
      await buildStatic(entry, "c", "curl-env");
    } finally {
      if (previous === undefined) {
        delete process.env["SCRIPTC_FETCH_CURL"];
      } else {
        process.env["SCRIPTC_FETCH_CURL"] = previous;
      }
    }
  }, 120_000);
});

describe(`proxy env opt-in (NODE_USE_ENV_PROXY${sanitize ? ", sanitized" : ""})`, () => {
  // The other half of the proxy parity: WITH NODE_USE_ENV_PROXY=1 both
  // lanes honor http_proxy and route through the local forward proxy —
  // outputs stay byte-identical AND the proxy sees exactly one relayed
  // request per lane.
  test("both lanes authenticate to http_proxy when opted in", async () => {
    const entry = join(fixturesRoot, "cases/proxy-optin/main.ts");
    const binary = await build(entry);
    const argv = [baseUrl, refusedUrl];
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      http_proxy: authenticatedProxyUrl,
      HTTP_PROXY: authenticatedProxyUrl,
      no_proxy: "",
      NO_PROXY: "",
    };
    const before = servers.proxiedRequests();
    const authBefore = servers.proxyAuthorizations().length;
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv], env),
      runBinary(binary, argv, env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    expect(servers.proxiedRequests() - before).toBe(2);
    expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
      expectedProxyAuthorization,
      expectedProxyAuthorization,
    ]);
  }, 120_000);

  test.for(["c", "llvm"] as const)(
    "static fetch / %s backend authenticates to http_proxy",
    async (backend) => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary = await buildStatic(entry, backend, "proxy-optin");
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: authenticatedProxyUrl,
        HTTP_PROXY: authenticatedProxyUrl,
        no_proxy: "",
        NO_PROXY: "",
      };
      const before = servers.proxiedRequests();
      const authBefore = servers.proxyAuthorizations().length;
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      expect(servers.proxiedRequests() - before).toBe(2);
      expect(servers.proxyAuthorizations().slice(authBefore)).toEqual([
        expectedProxyAuthorization,
        expectedProxyAuthorization,
      ]);
    },
    120_000,
  );

  test.for(["dynamic", "c", "llvm"] as const)(
    "%s fetch rejects an invalid opted-in proxy instead of dialing directly",
    async (lane) => {
      const entry = join(fixturesRoot, "static-proxy/main.mts");
      const binary =
        lane === "dynamic"
          ? await build(entry)
          : await buildStatic(entry, lane, "proxy-invalid");
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: "not a valid proxy URL",
        HTTP_PROXY: "not a valid proxy URL",
        no_proxy: "",
        NO_PROXY: "",
      };
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, baseUrl], env),
        runBinary(binary, [baseUrl], env),
      ]);
      expect(nativeRes.stdout.equals(nodeRes.stdout)).toBe(true);
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      expect(nativeRes.exitCode).not.toBe(0);
    },
    120_000,
  );

  test("dynamic fetch honors wildcard no_proxy exclusions", async () => {
    const entry = join(fixturesRoot, "cases/proxy-optin/main.ts");
    const binary = await build(entry);
    const argv = ["http://sub.example.invalid", refusedUrl];
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      http_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      no_proxy: "*.example.invalid",
      NO_PROXY: "*.example.invalid",
    };
    const before = servers.proxiedRequests();
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [entry, ...argv], env),
      runBinary(binary, argv, env),
    ]);
    expect(nativeRes.stdout.toString("utf8")).toBe(
      nodeRes.stdout.toString("utf8"),
    );
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    expect(servers.proxiedRequests() - before).toBe(0);
  }, 120_000);

  test.for(["c", "llvm"] as const)(
    "static fetch / %s backend honors wildcard no_proxy exclusions",
    async (backend) => {
      const entry = join(fixturesRoot, "static-network/main.mts");
      const binary = await buildStatic(entry, backend, "proxy-wildcard");
      const argv = ["http://sub.example.invalid/path"];
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        http_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        no_proxy: "*.example.invalid",
        NO_PROXY: "*.example.invalid",
      };
      const before = servers.proxiedRequests();
      const [nodeRes, nativeRes] = await Promise.all([
        runBinary("node", [entry, ...argv], env),
        runBinary(binary, argv, env),
      ]);
      expect(nativeRes.stdout.toString("utf8")).toBe(
        nodeRes.stdout.toString("utf8"),
      );
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
      expect(servers.proxiedRequests() - before).toBe(0);
    },
    120_000,
  );
});

describe(`fetch differential (${cases.length} programs${sanitize ? ", sanitized" : ""})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    const argv = [baseUrl, refusedUrl];
    const nodeArgv =
      c.name === "redirect-resolution"
        ? [...argv, "redirect-resolution-node"]
        : argv;
    const nativeArgv =
      c.name === "redirect-resolution"
        ? [...argv, "redirect-resolution-native"]
        : argv;
    const [nodeRes, nativeRes] = await Promise.all([
      runBinary("node", [c.entry, ...nodeArgv]),
      runBinary(binary, nativeArgv),
    ]);
    if (!nodeRes.stdout.equals(nativeRes.stdout)) {
      expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
      expect.unreachable("stdout differed at byte level but not after utf8 decode");
    }
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);
});
