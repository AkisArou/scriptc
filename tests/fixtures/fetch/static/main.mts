// The engine-free user surface: this is intentionally top-level and has
// no --dynamic directive. Both backends must compile fetch(url),
// RequestInit, and Response.json() into the native net/http/tls runtime.
const res = await fetch(`${process.argv[2]}/json`);
console.log(await res.json());

const gzipText = await (await fetch(`${process.argv[2]}/gzip`)).text();
console.log(
  "gzip:",
  gzipText.length,
  gzipText.startsWith("compressed héllo 😀"),
  gzipText.endsWith(" "),
);
console.log(
  "deflate:",
  await (await fetch(`${process.argv[2]}/deflate`)).text(),
);

const urlResponse = await fetch(new URL(`${process.argv[2]}/json`));
console.log("url:", urlResponse.status);

const headerResponse = await fetch(`${process.argv[2]}/header-echo`, {
  headers: { "x-echo-one": "1", "x-echo-two": "2" },
});
console.log(
  "headers:",
  headerResponse.headers.get("content-type"),
  headerResponse.headers.get("x-multi"),
  headerResponse.headers.get("missing") ?? "none",
  headerResponse.headers.has("x-multi"),
  headerResponse.headers.has("missing"),
  headerResponse.headers.getSetCookie().join("|"),
);
headerResponse.headers.forEach((value, name) => {
  if (name.startsWith("x-")) console.log("header walk:", name, value);
});
await headerResponse.text();

console.log(
  "request defaults:",
  await (await fetch(`${process.argv[2]}/request-defaults`)).json(),
);

const init: RequestInit = {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-user-tag": "static",
  },
  body: JSON.stringify({ q: 7 }),
};
const echoed = await fetch(`${process.argv[2]}/post-echo`, init);
console.log(await echoed.json());

const redirected = await fetch(`${process.argv[2]}/redirect`);
console.log(
  "redirect:",
  redirected.status,
  redirected.redirected,
  redirected.url.endsWith("/text"),
  await redirected.text(),
);

const statusMeta = await fetch(`${process.argv[2]}/status-meta`);
console.log("status text:", statusMeta.status, statusMeta.statusText);

const head = await fetch(`${process.argv[2]}/text`, { method: "HEAD" });
console.log(
  "head body:",
  head.body === null,
  head.bodyUsed,
  JSON.stringify(await head.text()),
  head.bodyUsed,
  JSON.stringify(await head.text()),
);
const noContent = await fetch(`${process.argv[2]}/no-content`);
try {
  await noContent.json();
} catch (error) {
  const caught = error as Error;
  console.log("no-content json:", caught.name, caught.message, noContent.bodyUsed);
}
console.log(
  "no-content body:",
  noContent.body === null,
  noContent.bodyUsed,
  JSON.stringify(await noContent.text()),
  noContent.bodyUsed,
);

try {
  await fetch(`${process.argv[2]}/json`, { method: "BAD METHOD" });
} catch (error) {
  console.log("invalid-method:", (error as Error).name);
}
try {
  await fetch("not a url", {
    signal: AbortSignal.abort(new Error("must not mask URL validation")),
  });
} catch (error) {
  console.log("aborted invalid-url:", (error as Error).name);
}
try {
  await fetch(`${process.argv[2]}/text`, { method: "TRACE" });
} catch (error) {
  const caught = error as Error;
  console.log("forbidden-method:", caught.name, caught.message);
}
