import { expect, test } from "vitest";
import {
  embeddedModulesUsingGlobalFetch,
  type EmbeddedModule,
} from "../src/frontend/npm.js";

function js(key: string, source: string): EmbeddedModule {
  return { key: `/${key}.js`, source, format: "cjs" };
}

test("embedded fetch capability analysis ignores text and local bindings", () => {
  const modules = [
    js("comment", "// fetch(url)\nmodule.exports = 1;"),
    js("string", "module.exports = 'fetch(url)';"),
    js("property", "const value = { fetch: 1 }; module.exports = value.fetch;"),
    js("local", "const fetch = (x) => x; module.exports = fetch('local');"),
    js("parameter", "module.exports = function (fetch) { return fetch('local'); };"),
    js("import", "import fetch from 'a-local-package'; export default fetch('local');"),
    js("shadow-global", "module.exports = function (globalThis) { return globalThis.fetch('local'); };"),
  ];

  expect([...embeddedModulesUsingGlobalFetch(modules)]).toEqual([]);
});

test("embedded fetch capability analysis finds global reads", () => {
  const modules = [
    js("bare", "module.exports = fetch('https://example.com');"),
    js("global-this", "module.exports = globalThis.fetch('https://example.com');"),
    js("global", "module.exports = global['fetch']('https://example.com');"),
    {
      ...js("windows-path", "module.exports = fetch('https://example.com');"),
      key: "C:\\pkg\\index.js",
    },
  ];

  expect([...embeddedModulesUsingGlobalFetch(modules)]).toEqual([
    "/bare.js",
    "/global-this.js",
    "/global.js",
    "C:\\pkg\\index.js",
  ]);
});
