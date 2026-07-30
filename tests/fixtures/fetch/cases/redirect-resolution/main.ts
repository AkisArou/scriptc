// @dynamic
// Redirect URL resolution must remain byte-identical in the island-backed
// transport: fragments preserve the current resource, while backslashes in
// special URLs behave as forward slashes.
async function main(baseUrl: string, redirectKey: string): Promise<void> {
  const fragment = await fetch(`${baseUrl}/redirect-fragment/path`, {
    headers: { "x-redirect-key": redirectKey },
  });
  const fragmentBody: string = await fragment.text();
  console.log(
    "fragment:",
    `${fragment.status}`,
    `${fragment.url.endsWith("/redirect-fragment/path")}`,
    fragmentBody,
  );

  const backslash = await fetch(`${baseUrl}/redirect-backslash`);
  const backslashBody: string = await backslash.text();
  console.log(
    "backslash:",
    `${backslash.status}`,
    `${backslash.url.endsWith("/text")}`,
    backslashBody,
  );
}

main(process.argv[2], process.argv[4]);
