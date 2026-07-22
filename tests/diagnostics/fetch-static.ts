// USER-code fetch is island-backed ambient surface (the engine's own
// fetch executes): in a static build every call site is its own SC2012
// naming the flag — never an ICE, never a link error — and a bare
// Response-typed value points at the same choice.
async function probe(url: string): Promise<number> {
  const r = await fetch(url);
  return r.status;
}
function inspect(r: Response): boolean {
  return r.ok;
}
const sig = AbortSignal.timeout(100);
async function timed(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(100) });
  return r.text();
}
probe("http://localhost/a");
timed("http://localhost/b");
