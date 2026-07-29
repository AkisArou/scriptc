// Native AbortSignal + WHATWG readable-stream ownership coverage. The request body
// is produced in two turns, the response body is consumed through the
// default reader, and a timeout aborts a live native transfer.
const requestBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("stream-"));
    setTimeout(() => {
      controller.enqueue(Buffer.from("body"));
      controller.close();
    }, 5);
  },
});

const posted = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: requestBody,
  duplex: "half",
});
console.log(await posted.json());

const streamed = await fetch(`${process.argv[2]}/chunked`);
const reader = streamed.body!.getReader();
const chunks: Uint8Array[] = [];
for (;;) {
  const part = await reader.read();
  if (part.done) break;
  chunks.push(part.value);
}
console.log(new TextDecoder().decode(Buffer.concat(chunks)), streamed.bodyUsed);

const signal = AbortSignal.any([AbortSignal.timeout(20)]);
let abortEvent = false;
signal.addEventListener("abort", () => {
  abortEvent = true;
}, { once: true });
try {
  await fetch(`${process.argv[2]}/slow`, { signal });
} catch (error) {
  const caught = error as Error;
  console.log(abortEvent, signal.aborted, caught.name, caught.message);
}

try {
  AbortSignal.abort(new Error("manual stop")).throwIfAborted();
} catch (error) {
  const caught = error as Error;
  console.log(caught.name, caught.message);
}
