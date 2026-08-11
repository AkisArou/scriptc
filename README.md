# scriptc

scriptc compiles TypeScript and JavaScript to native executables. It uses the TypeScript compiler for parsing and type checking, then emits LLVM IR or C for clang to compile.

Static builds include a small native runtime, but no Node or JavaScript engine. Code that cannot compile statically is reported as a diagnostic. For npm packages and `any`-typed code, `--dynamic` embeds [quickjs-ng](https://github.com/quickjs-ng/quickjs) explicitly.

scriptc is experimental and targets macOS, Linux, and Windows.

## Installation

The compiler requires Node.js 20 or newer and clang. The executables it produces do not require Node.

```console
$ npm install -g scriptc
```

## Build a program

Create `hello.ts`:

```ts
const who = process.argv.length > 2 ? process.argv[2] : "world";
console.log(`hello, ${who}`);
```

Compile and run it in one step:

```console
$ scriptc run hello.ts
hello, world
```

Or write a standalone executable:

```console
$ scriptc build hello.ts -o hello
$ ./hello Ada
hello, Ada
```

## Use Node APIs

Supported Node APIs compile to the native runtime. For example, `server.ts`:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url }));
});

server.listen(8080, () => {
  console.log("listening on http://localhost:8080");
});
```

```console
$ scriptc build server.ts -o server
$ ./server
listening on http://localhost:8080
```

## Check static coverage

`scriptc coverage` shows how much of a program can compile statically and gives a coded diagnostic for every dynamic or unsupported site.

```console
$ scriptc coverage hello.ts

  statements analyzed   2
  compile statically    2  (100%)

  fully static — this program has no dynamic remainder.
```

## Use npm packages

Pass `--dynamic` to embed an npm package's JavaScript in the executable. The result does not read `node_modules` at runtime.

```ts
import pc from "picocolors";

console.log(pc.green("hello from scriptc"));
```

```console
$ npm install picocolors
$ scriptc build cli.ts --dynamic -o cli
$ ./cli
hello from scriptc
```

## Documentation

See the [quickstart](https://scriptc.dev/quickstart) and [CLI reference](https://scriptc.dev/cli) for the complete workflow. The docs also describe [npm dependencies](https://scriptc.dev/dependencies), [native FFI](https://scriptc.dev/ffi), [platform support](https://scriptc.dev/platforms), and the current [limitations](https://scriptc.dev/limitations).

## Development

```console
$ pnpm install && pnpm -r build
$ pnpm test:sandbox
```

The test corpus runs each program under Node and as a compiled native binary, then compares stdout, stderr, and exit codes byte for byte. The full gate also runs the corpus with AddressSanitizer and the runtime reference-count audit.
