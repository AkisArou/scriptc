// node:module ADMITS (the builtin import carries no evaluation), and every
// member keeps a per-site fence: createRequire loads CommonJS from disk at
// RUNTIME (the config/plugin-loading pattern), which a compiled program —
// whose modules are fixed at build time — cannot do. In TS sources the
// fence is this compile-time diagnostic; in JS sources the same call
// defers to a catchable runtime error naming the member.
import { createRequire } from "node:module";

const req = createRequire("/tmp/parent.js");
console.log(String(req("./config.cjs")));
