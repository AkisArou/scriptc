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
  await fetch(`${process.argv[2]}/text`, { method: "TRACE" });
} catch (error) {
  const caught = error as Error;
  console.log("forbidden-method:", caught.name, caught.message);
}
