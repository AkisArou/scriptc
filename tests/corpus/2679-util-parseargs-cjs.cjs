// CommonJS namespace/member plumbing reaches the same static parseArgs spoke.
const util = require("node:util");
const parse = require("util").parseArgs;

console.log(JSON.stringify(util.parseArgs({
  args: ["-f", "one", "two"],
  options: { force: { type: "boolean", short: "f" } },
  allowPositionals: true,
})));
console.log(JSON.stringify(parse({ args: ["--x=1"], strict: false, tokens: true })));

for (const config of [
  null,
  { args: [], strict: 1 },
  { args: [], options: { x: {} } },
  { args: [], options: { x: { type: "boolean", short: "xx" } } },
  { args: [], options: { x: { type: "string", default: false } } },
]) {
  try {
    parse(config);
  } catch (error) {
    console.log("config-error", `${error.code}`, error.message);
  }
}
