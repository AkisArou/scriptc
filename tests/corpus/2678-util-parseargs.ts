// Static node:util.parseArgs — Node is the oracle for grammar, defaults,
// negative booleans, tokens, and coded error paths.
import { parseArgs } from "node:util";

const full = parseArgs({
  args: ["-v", "--output=result.txt", "--tag", "a", "--tag=b", "file", "--", "--literal"],
  options: {
    verbose: { type: "boolean", short: "v" },
    output: { type: "string", short: "o" },
    tag: { type: "string", short: "t", multiple: true },
    color: { type: "boolean", default: true },
  },
  allowPositionals: true,
  tokens: true,
});
console.log("full", JSON.stringify(full));
const { values: fullValues, positionals: fullPositionals } = full;
console.log("destructured", fullValues.verbose, fullPositionals.length);
const { values: { output: nestedOutput } } = full;
console.log("nested", nestedOutput);
if (full.tokens !== undefined) {
  const firstToken = full.tokens[0];
  if (firstToken !== undefined && firstToken.kind === "option") {
    console.log("first-token", firstToken.name, firstToken.rawName);
    const { name: tokenName, rawName: tokenRawName } = firstToken;
    console.log("token-pattern", tokenName, tokenRawName);
  }
}

const clustered = parseArgs({
  args: ["-abVALUE", "--color", "--no-color", "tail"],
  options: {
    all: { type: "boolean", short: "a" },
    build: { type: "string", short: "b" },
    color: { type: "boolean", multiple: true },
  },
  allowNegative: true,
  allowPositionals: true,
  tokens: true,
});
console.log("cluster", JSON.stringify(clustered));

const loose = parseArgs({
  args: ["--mystery=x", "-qz", "--=odd", "pos"],
  strict: false,
  tokens: true,
});
console.log("loose", JSON.stringify(loose));

const typedConfig: import("node:util").ParseArgsConfig = {
  args: ["--mode", "fast"],
  options: { mode: { type: "string" } },
  tokens: true,
};
console.log("typed", JSON.stringify(parseArgs(typedConfig)));
console.log("undefined", JSON.stringify(parseArgs(undefined)));

for (const run of [
  (): void => { parseArgs({ args: ["--name"], options: { name: { type: "string" } } }); },
  (): void => { parseArgs({ args: ["--wat"] }); },
  (): void => { parseArgs({ args: ["position"] }); },
  (): void => { parseArgs({ args: ["--name", "--next"], options: { name: { type: "string" } } }); },
  (): void => { parseArgs({ args: ["-n", "-1"], options: { name: { type: "string", short: "n" } } }); },
]) {
  try {
    run();
  } catch (error) {
    if (error instanceof TypeError) {
      console.log("error", `${(error as NodeJS.ErrnoException).code}`, error.message);
    }
  }
}
