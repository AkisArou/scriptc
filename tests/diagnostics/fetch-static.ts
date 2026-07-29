// fetch(url), RequestInit, AbortSignal, readable bodies, and Response body
// readers are native static surface. Constructing Headers remains in the
// broader dynamic web tier and diagnoses cleanly at its use site.
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
const headers = new Headers();
// Headers remains the dynamic-tier fence above.
