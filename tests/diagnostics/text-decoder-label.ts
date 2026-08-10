const bytes = new Uint8Array([0x41]);

const runtimeLabel: string = process.argv[2] ?? "utf-8";
console.log(new TextDecoder(runtimeLabel).decode(bytes));

// WHATWG's replacement labels deliberately fail TextDecoder construction.
console.log(new TextDecoder("replacement").decode(bytes));

// Vertical tab is not WHATWG ASCII whitespace and must not be trimmed.
console.log(new TextDecoder("\vutf-8").decode(bytes));
