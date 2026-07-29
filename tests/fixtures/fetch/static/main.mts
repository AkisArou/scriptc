// The engine-free user surface: this is intentionally top-level and has
// no --dynamic directive. Both backends must compile fetch(url),
// RequestInit, and Response.json() into the native net/http/tls runtime.
const res = await fetch(`${process.argv[2]}/json`);
console.log(await res.json());

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

try {
  await fetch(`${process.argv[2]}/json`, { method: "BAD METHOD" });
} catch (error) {
  console.log("invalid-method:", (error as Error).name);
}
