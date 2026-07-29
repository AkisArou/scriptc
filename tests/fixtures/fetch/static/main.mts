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
console.log(
  "concatenated gzip:",
  await (await fetch(`${process.argv[2]}/gzip-concat`)).text(),
);

const urlResponse = await fetch(new URL(`${process.argv[2]}/json`));
console.log("url:", urlResponse.status);

const headerResponse = await fetch(`${process.argv[2]}/header-echo`, {
  headers: { "x-echo-one": "1", "x-echo-two": "2" },
});
const responseHeaders = headerResponse.headers;
console.log(
  "headers:",
  responseHeaders.get("content-type"),
  responseHeaders.get("x-multi"),
  responseHeaders.get("missing") ?? "none",
  responseHeaders.has("x-multi"),
  responseHeaders.has("missing"),
  responseHeaders.getSetCookie().join("|"),
);
responseHeaders.forEach((value, name) => {
  if (name.startsWith("x-")) console.log("header walk:", name, value);
});
await headerResponse.text();

const emptyHeaderResponse = await fetch(`${process.argv[2]}/header-empty`);
console.log(
  "empty duplicate header:",
  JSON.stringify(emptyHeaderResponse.headers.get("x-empty")),
);
await emptyHeaderResponse.text();

const headersSource = await fetch(`${process.argv[2]}/headers-source`);
const reusedHeaders = await fetch(`${process.argv[2]}/headers-reuse`, {
  headers: headersSource.headers,
});
console.log("reused headers:", await reusedHeaders.text());

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

const matchedLength = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  headers: { "content-length": "2" },
  body: "hi",
});
console.log("matched fixed content-length:", await matchedLength.json());

const redirected = await fetch(`${process.argv[2]}/redirect`);
console.log(
  "redirect:",
  redirected.status,
  redirected.redirected,
  redirected.url.endsWith("/text"),
  await redirected.text(),
);

const fragmentRedirect = await fetch(
  `${process.argv[2]}/redirect-fragment/path`,
  {
    headers: {
      "x-redirect-key": process.argv[3] ?? "static-fragment",
    },
  },
);
console.log(
  "fragment redirect:",
  fragmentRedirect.status,
  fragmentRedirect.url.endsWith("/redirect-fragment/path"),
  await fragmentRedirect.text(),
);

const manualRedirect = await fetch(`${process.argv[2]}/redirect`, {
  redirect: "manual",
});
console.log(
  "manual redirect:",
  manualRedirect.status,
  manualRedirect.redirected,
  manualRedirect.url.endsWith("/redirect"),
  manualRedirect.headers.get("location"),
  JSON.stringify(await manualRedirect.text()),
);

try {
  await fetch(`${process.argv[2]}/redirect`, { redirect: "error" });
} catch (error) {
  const caught = error as Error;
  console.log("error redirect:", caught.name, caught.message);
}

try {
  await fetch(`${process.argv[2]}/redirect-credentials`);
} catch (error) {
  const caught = error as Error;
  console.log("credential redirect:", caught.name, caught.message);
}

try {
  const credentialUrl =
    `http://user:pass@${process.argv[2].slice("http://".length)}/text`;
  await fetch(credentialUrl);
} catch (error) {
  const caught = error as Error;
  console.log("credential URL:", caught.name, caught.message);
}

console.log(
  "early hints:",
  await (await fetch(`${process.argv[2]}/early-hints`)).text(),
);
console.log(
  "invalid utf8:",
  JSON.stringify(await (await fetch(`${process.argv[2]}/invalid-utf8`)).text()),
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
try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    headers: { "content-length": "5" },
    body: "hi",
    signal: AbortSignal.timeout(200),
  });
} catch (error) {
  const caught = error as Error;
  console.log("fixed content-length mismatch:", caught.name, caught.message);
}
