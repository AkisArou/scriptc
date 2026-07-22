// URL.host — the WHATWG host serialization: lowercased hostname, ":port"
// exactly when a non-default port is present, "" for opaque paths.
const a = new URL("https://Example.COM:443/path");
const b = new URL("http://localhost:3000/x");
const c = new URL("https://api.test:8443/y?q=1");
const d = new URL("file:///tmp/x");
const e = new URL("data:text/plain,hi");
const f = new URL("http://example.com/");
console.log(a.host);
console.log(b.host);
console.log(c.host);
console.log(`<${d.host}>`);
console.log(`<${e.host}>`);
console.log(f.host);
// Composes with the other getters and unions.
const maybe: URL | undefined = c;
console.log(maybe !== undefined ? maybe.host : "none");
console.log(a.protocol, a.host, a.pathname);
