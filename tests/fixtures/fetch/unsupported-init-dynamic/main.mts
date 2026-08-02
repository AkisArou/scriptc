// @dynamic
// Runtime-computed RequestInit dictionaries cannot be source-profiled. The
// dynamic fetch bridge must reject recognized unsupported members rather than
// silently weakening their cache, credential, or integrity behavior.
declare global {
  interface RequestInit {
    cache?: string;
  }
}

function indirect(init: RequestInit): Promise<Response> {
  return fetch("http://127.0.0.1:1", init);
}

try {
  await indirect({ cache: "no-store" });
  console.log("unsupported RequestInit unexpectedly accepted");
} catch (error) {
  const caught = error as Error;
  console.log(caught.name, caught.message);
}
