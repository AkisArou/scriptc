import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("frontend preserves static handle identity while rejecting unsupported dyn handles", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-dyncheck-"));
  const file = join(dir, "main.ts");
  writeFileSync(file, `
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { connect as http2Connect } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
const value: unknown = JSON.parse("1");
const errorOrNumber = value as Error | number;
const requestOrNumber = value as IncomingMessage | number;
const requests = value as IncomingMessage[];
const sessions = value as ClientHttp2Session[];
const session = value as ClientHttp2Session;
const stream = value as ClientHttp2Stream;
const client = value as ClientRequest;
const cloned: undefined = structuredClone(undefined);
const staticClient = httpRequest("http://127.0.0.1/");
const staticSession = http2Connect("http://127.0.0.1/");
const staticStream = staticSession.request();
console.log(cloned, staticClient === staticClient, staticSession === staticSession, staticStream !== staticStream);
`);

  const diagnostics = analyze(file).coverage.diagnostics;
  expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
    "SC2009: values of type 'IncomingMessage[]' cannot be compiled: the array shape is supported, but 'IncomingMessage' elements have no array representation yet",
    "SC1090: a checked cast of 'unknown' to 'number | Error' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
    "SC1090: a checked cast of 'unknown' to 'number | IncomingMessage' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
    "SC2009: values of type 'IncomingMessage[]' cannot be compiled: the array shape is supported, but 'IncomingMessage' elements have no array representation yet",
    "SC1090: a checked cast of 'unknown' to 'Http2Session[]' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
    "SC1090: a checked cast of 'unknown' to 'Http2Session' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
    "SC1090: a checked cast of 'unknown' to 'Http2Stream' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
    "SC1090: a checked cast of 'unknown' to 'ClientRequest' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet",
  ]);

  const identityFile = join(dir, "identity.ts");
  writeFileSync(identityFile, `
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { watch } from "node:fs";
import test from "node:test";
const child = spawn("true", [], { stdio: ["ignore", "pipe", "pipe"] });
const socket = createSocket("udp4");
const watcher = watch(".");
console.log(child === child, socket === socket, watcher !== watcher);
if (child.stdout) console.log(child.stdout === child.stdout);
test("identity", (t) => console.log(t === t));
`);
  const identityDiagnostics = analyze(identityFile).coverage.diagnostics;
  expect(identityDiagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);

  const excludedSources = [
    `console.log(process.stdout === process.stdout);`,
    `import { statSync } from "node:fs"; const value = statSync("."); console.log(value === value);`,
    `import { spawnSync } from "node:child_process"; const value = spawnSync("true"); console.log(value === value);`,
  ];
  for (const [i, source] of excludedSources.entries()) {
    const excludedFile = join(dir, `excluded-${i}.ts`);
    writeFileSync(excludedFile, source);
    const excludedDiagnostics = analyze(excludedFile).coverage.diagnostics;
    expect(excludedDiagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC1043: comparing non-number, non-string values are not supported yet",
    ]);
  }
});
