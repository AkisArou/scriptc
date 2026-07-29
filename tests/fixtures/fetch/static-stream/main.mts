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

// A promised pull stays serialized until that promise settles. The
// second read queues demand while the first pull is still awaiting.
let activePulls = 0;
let maxActivePulls = 0;
let pullCount = 0;
const promisedPulls = new ReadableStream<Uint8Array>({
  async pull(controller) {
    activePulls++;
    maxActivePulls = Math.max(maxActivePulls, activePulls);
    const n = ++pullCount;
    controller.enqueue(Buffer.from([n]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    activePulls--;
    if (n === 2) controller.close();
  },
});
const pullReader = promisedPulls.getReader();
await pullReader.read();
await pullReader.read();
await pullReader.closed;
console.log("max active pulls:", maxActivePulls);

let requestPull = 0;
const promisedRequestBody = new ReadableStream<Uint8Array>({
  async pull(controller) {
    requestPull++;
    controller.enqueue(
      Buffer.from(requestPull === 1 ? "promised-" : "request"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    if (requestPull === 2) controller.close();
  },
});
const promisedPost = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: promisedRequestBody,
  duplex: "half",
});
console.log(await promisedPost.json());

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
  console.log("abort-first");
}, { once: true });
signal.addEventListener("abort", () => {
  console.log("abort-second");
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

const identitySignal = AbortSignal.timeout(0);
let identityCalls = 0;
const identityListener = () => {
  identityCalls++;
};
identitySignal.addEventListener("abort", identityListener);
identitySignal.addEventListener("abort", identityListener);
identitySignal.removeEventListener("abort", identityListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("removed abort listener:", identityCalls);

for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 4294967296]) {
  try {
    AbortSignal.timeout(delay);
  } catch (error) {
    const caught = error as Error;
    console.log("invalid timeout:", caught.name, caught.message);
  }
}

try {
  const missingDuplex = ReadableStream.from([Buffer.from("no-duplex")]);
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    body: missingDuplex,
  });
} catch (error) {
  const caught = error as Error;
  console.log("missing duplex:", caught.name, caught.message);
}
