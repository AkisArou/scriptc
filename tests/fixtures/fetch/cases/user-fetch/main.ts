// @dynamic
// USER-code fetch — the island-backed ambient in the program's OWN
// TypeScript (no npm package in sight): `await fetch(url)` bridges the
// engine promise to a static one, the Response is an island handle whose
// members are engine ops (ok/status/statusText probe reads, json() through
// a checked cast, text() into a string slot), init literals build natively
// in the island (method/headers/body/signal), AbortSignal.timeout cancels,
// and network failure rejects catchably. Byte-exact vs Node.

async function main(baseUrl: string, refusedUrl: string): Promise<void> {
  // ok + status through the handle; json() exits through a checked cast.
  const r = await fetch(`${baseUrl}/json`);
  console.log("ok:", r.ok ? "yes" : "no", "status:", `${r.status}`);
  const j = (await r.json()) as { n: number; s: string; arr: (number | string)[] };
  console.log("json:", j.n, j.s, j.arr.length);

  // text() lands in a string slot through the validated exit.
  const t = await fetch(`${baseUrl}/text`);
  const body: string = await t.text();
  console.log("text:", body);

  // HTTP errors RESOLVE: 404 probes read ok/status/statusText.
  const nf = await fetch(baseUrl + "/nope");
  if (!nf.ok) {
    console.log("nf:", `${nf.status}`, `${nf.statusText}`);
    const nfBody: string = await nf.text();
    console.log("nf-body:", nfBody);
  }

  // POST with an init literal: method, headers, body cross the boundary.
  const echoed = await fetch(`${baseUrl}/post-echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-tag": "native" },
    body: JSON.stringify({ q: 7 }),
  });
  const ej = (await echoed.json()) as {
    method: string;
    contentType: string | null;
    body: string;
  };
  console.log("post:", ej.method, ej.contentType ?? "none", ej.body);

  // A stored Response promise awaits later like any static promise.
  const pending: Promise<Response> = fetch(`${baseUrl}/json`);
  const again = await pending;
  console.log("again:", again.ok ? "ok" : "not-ok");

  // AbortSignal.timeout: the slow route loses the race to the timer.
  try {
    await fetch(`${baseUrl}/slow`, { signal: AbortSignal.timeout(50) });
    console.log("timeout: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("timeout:", e.name, e.message);
  }

  // Connection refused: fetch REJECTS (TypeError, Node's message).
  try {
    await fetch(refusedUrl);
    console.log("refused: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("refused:", e.name, e.message);
  }
}

main(process.argv[2], process.argv[3]);
