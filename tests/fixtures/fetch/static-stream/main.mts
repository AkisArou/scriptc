// Native AbortSignal + WHATWG readable-stream ownership coverage. The request body
// is produced in two turns, the response body is consumed through the
// default reader, and a timeout aborts a live native transfer.
let initialPullCalls = 0;
const initialPullStream = new ReadableStream<number>({
  pull() {
    initialPullCalls++;
  },
});
console.log("initial pull sync:", initialPullCalls);
await Promise.resolve();
console.log("initial pull checkpoint:", initialPullCalls);
void initialPullStream;

// Draining a pre-queued chunk creates demand even with no second read.
let replenishingPulls = 0;
const replenishingStream = new ReadableStream<number>({
  start(controller) {
    controller.enqueue(1);
  },
  pull(controller) {
    replenishingPulls++;
    controller.close();
  },
});
const replenishingReader = replenishingStream.getReader();
await Promise.resolve();
const replenishedPart = await replenishingReader.read();
await Promise.resolve();
console.log(
  "pull after queued read:",
  replenishedPart.value,
  replenishingPulls,
);

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
console.log("consumed request locked:", requestBody.locked);
try {
  requestBody.getReader();
  console.log("consumed request reader unexpectedly acquired");
} catch (error) {
  console.log("consumed request reader:", (error as Error).name);
}

const prelockedRequestBody = ReadableStream.from([
  Buffer.from("prelocked request"),
]);
const prelockedRequestReader = prelockedRequestBody.getReader();
try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    body: prelockedRequestBody,
    duplex: "half",
  });
  console.log("prelocked request unexpectedly sent");
} catch (error) {
  console.log("prelocked request:", (error as Error).name);
}
prelockedRequestReader.releaseLock();

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

let activeThenablePulls = 0;
let maxActiveThenablePulls = 0;
let thenablePullCount = 0;
const thenablePullSource = {
  pull(controller: ReadableStreamDefaultController<number>) {
    activeThenablePulls++;
    maxActiveThenablePulls = Math.max(
      maxActiveThenablePulls,
      activeThenablePulls,
    );
    const n = ++thenablePullCount;
    controller.enqueue(n);
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          activeThenablePulls--;
          if (n === 2) controller.close();
          resolve();
        }, 5);
      },
    };
  },
};
const thenablePulls = new ReadableStream<number>(thenablePullSource);
const thenablePullReader = thenablePulls.getReader();
async function readThenablePull(): Promise<ReadableStreamReadResult<number>> {
  return await thenablePullReader.read();
}
const firstThenableRead = readThenablePull();
const secondThenableRead = readThenablePull();
await firstThenableRead;
await secondThenableRead;
await thenablePullReader.closed;
console.log("max active thenable pulls:", maxActiveThenablePulls);

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

const temporaryRead = await new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("temporary"));
    controller.close();
  },
}).getReader().read();
console.log(
  "temporary reader:",
  temporaryRead.done ? "done" : new TextDecoder().decode(temporaryRead.value),
);

let concurrentValue = 0;
const concurrentReader = new ReadableStream<number>({
  async pull(controller) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    concurrentValue++;
    controller.enqueue(concurrentValue);
    if (concurrentValue === 2) controller.close();
  },
}).getReader();
async function readConcurrent(): Promise<ReadableStreamReadResult<number>> {
  return await concurrentReader.read();
}
const concurrentFirstPromise = readConcurrent();
const concurrentSecondPromise = readConcurrent();
const concurrentFirst = await concurrentFirstPromise;
const concurrentSecond = await concurrentSecondPromise;
console.log(
  "concurrent reads:",
  concurrentFirst.value,
  concurrentSecond.value,
);

const releasedReader = new ReadableStream<number>({
  async start() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  },
}).getReader();
const releasedRead: unknown = releasedReader.read();
const oldReleasedClosed: unknown = releasedReader.closed;
releasedReader.releaseLock();
const newReleasedClosed: unknown = releasedReader.closed;
try {
  await oldReleasedClosed;
} catch (error) {
  const caught = error as Error;
  console.log("released old closed:", caught.name, caught.message);
}
try {
  await releasedRead;
} catch (error) {
  const caught = error as Error;
  console.log("released read:", caught.name, caught.message);
}
try {
  await newReleasedClosed;
} catch (error) {
  const caught = error as Error;
  console.log("released new closed:", caught.name, caught.message);
}
const releasedCancel: unknown = releasedReader.cancel();
console.log("released cancel returned");
try {
  await releasedCancel;
} catch (error) {
  console.log("released cancel rejected:", (error as Error).name);
}

const liveValues = [1];
const liveValuesReader = ReadableStream.from(liveValues).getReader();
liveValues[0] = 2;
liveValues.push(3);
const liveFirst = await liveValuesReader.read();
const liveSecond = await liveValuesReader.read();
const liveDone = await liveValuesReader.read();
console.log(
  "stream from live array:",
  liveFirst.value,
  liveSecond.value,
  liveDone.done,
);

const streamIdentityBox = { value: 1 };
const streamIdentityReader =
  ReadableStream.from([streamIdentityBox]).getReader();
const streamIdentityPart = await streamIdentityReader.read();
if (!streamIdentityPart.done) {
  streamIdentityPart.value.value = 2;
}
console.log(
  "stream from record identity:",
  streamIdentityPart.done,
  streamIdentityPart.done
    ? false
    : streamIdentityPart.value === streamIdentityBox,
  streamIdentityBox.value,
);

const liveBytes = new Uint8Array([4]);
const liveBytesReader = ReadableStream.from(liveBytes).getReader();
liveBytes[0] = 5;
const liveByte = await liveBytesReader.read();
console.log("stream from live bytes:", liveByte.value);

const stringReader = ReadableStream.from("😀a").getReader();
const stringFirst = await stringReader.read();
const stringSecond = await stringReader.read();
const stringDone = await stringReader.read();
console.log(
  "stream from string:",
  stringFirst.value,
  stringSecond.value,
  stringDone.done,
);

const streamed = await fetch(`${process.argv[2]}/chunked`);
const reader = streamed.body!.getReader();
const chunks: Uint8Array[] = [];
for (;;) {
  const part = await reader.read();
  if (part.done) break;
  chunks.push(part.value);
}
console.log(new TextDecoder().decode(Buffer.concat(chunks)), streamed.bodyUsed);

const lockedCancelResponse = await fetch(`${process.argv[2]}/chunked`);
const lockedCancelBody = lockedCancelResponse.body!;
async function collectLockedCancelResponse(): Promise<string> {
  return await lockedCancelResponse.text();
}
const lockedCancelText = collectLockedCancelResponse();
try {
  await lockedCancelBody.cancel();
  console.log("locked response cancel unexpectedly resolved");
} catch (error) {
  console.log("locked response cancel:", (error as Error).name);
}
console.log("locked response text:", await lockedCancelText);

const closedCancelResponse = await fetch(
  `${process.argv[2]}/headers-source`,
);
const closedCancelBefore = closedCancelResponse.bodyUsed;
await closedCancelResponse.body!.cancel();
console.log(
  "closed response cancel:",
  closedCancelBefore,
  closedCancelResponse.bodyUsed,
);

const collected = await fetch(`${process.argv[2]}/text`);
await collected.text();
console.log("collected response locked:", collected.body!.locked);
try {
  collected.body!.getReader();
  console.log("collected response reader unexpectedly acquired");
} catch (error) {
  console.log("collected response reader:", (error as Error).name);
}

const pressureKey = process.argv[3] ?? "static-stream";
const pressured = await fetch(
  `${process.argv[2]}/backpressure?key=${pressureKey}`,
);
await new Promise<void>((resolve) => setTimeout(resolve, 250));
const pressureState = await (
  await fetch(`${process.argv[2]}/backpressure-state?key=${pressureKey}`)
).text();
console.log("response backpressure:", pressureState);
await pressured.body!.cancel();

const signal = AbortSignal.any([AbortSignal.timeout(20)]);
AbortSignal.abort().addEventListener("custom", () => {
  console.log("custom abort event unexpectedly fired");
});
console.log("custom abort listener registered");
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

const mutationSignal = AbortSignal.timeout(0);
let mutationCalls = 0;
const selfRemovingListener = () => {
  mutationCalls++;
  mutationSignal.removeEventListener("abort", selfRemovingListener);
};
mutationSignal.addEventListener("abort", selfRemovingListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("self-removing abort listener:", mutationCalls);

const eventSignal = AbortSignal.timeout(0);
eventSignal.addEventListener("abort", (event: Event) => {
  console.log(
    "abort event:",
    event.type,
    event.target === eventSignal,
    event.currentTarget === eventSignal,
    event.srcElement === eventSignal,
    event.bubbles,
    event.cancelable,
    event.composed,
    event.defaultPrevented,
    event.eventPhase,
    event.isTrusted,
    event.timeStamp >= 0,
    event.cancelBubble,
    event.returnValue,
    event.composedPath().length,
  );
  event.preventDefault();
  event.stopPropagation();
  console.log(
    "abort event propagation:",
    event.defaultPrevented,
    event.cancelBubble,
    event.returnValue,
  );
  setTimeout(() => {
    console.log(
      "abort event after dispatch:",
      event.target === eventSignal,
      event.currentTarget === null,
      event.srcElement === eventSignal,
      event.eventPhase,
      event.cancelBubble,
      event.composedPath().length,
    );
  }, 0);
});
eventSignal.addEventListener("abort", () => {
  console.log("abort listener after stopPropagation");
});
eventSignal.addEventListener("abort", null);
await new Promise<void>((resolve) => setTimeout(resolve, 5));

const immediateSignal = AbortSignal.timeout(0);
const immediateHandlers: string[] = [];
immediateSignal.addEventListener("abort", (event: Event) => {
  immediateHandlers.push("first");
  event.stopImmediatePropagation();
});
immediateSignal.addEventListener("abort", () => {
  immediateHandlers.push("second");
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("abort stop immediate:", immediateHandlers.join(","));

const captureSignal = AbortSignal.timeout(0);
let captureCalls = 0;
const captureListener = () => {
  captureCalls++;
};
captureSignal.addEventListener("abort", captureListener, false);
captureSignal.addEventListener("abort", captureListener, true);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("capture listener identity:", captureCalls);

const objectSignal = AbortSignal.timeout(0);
let objectCalls = 0;
const objectListener = {
  handleEvent(event: Event) {
    if (event.type === "abort") objectCalls++;
  },
};
objectSignal.addEventListener("abort", objectListener);
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("object abort listener:", objectCalls);

const orderedSignal = AbortSignal.timeout(0);
const orderedHandlers: string[] = [];
orderedSignal.addEventListener("abort", () => {
  orderedHandlers.push("listener");
});
orderedSignal.onabort = () => {
  orderedHandlers.push("onabort");
};
await new Promise<void>((resolve) => setTimeout(resolve, 5));
console.log("abort handler order:", orderedHandlers.join(","));

const listenerGate = AbortSignal.timeout(0);
const gatedTarget = AbortSignal.timeout(10);
let gatedCalls = 0;
gatedTarget.addEventListener(
  "abort",
  () => {
    gatedCalls++;
  },
  { signal: listenerGate },
);
const preAbortedTarget = AbortSignal.timeout(0);
preAbortedTarget.addEventListener(
  "abort",
  () => {
    gatedCalls++;
  },
  { signal: AbortSignal.abort() },
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
console.log("abort listener signal:", gatedCalls);

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

let startReady = false;
const asyncStart = new ReadableStream<Uint8Array>({
  async start() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    startReady = true;
  },
  pull(controller) {
    console.log("pull after start:", startReady);
    controller.close();
  },
});
await asyncStart.getReader().read();

let thenableStartReady = false;
const thenableStart = new ReadableStream<Uint8Array>({
  start() {
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          thenableStartReady = true;
          resolve();
        }, 5);
      },
    };
  },
  pull(controller) {
    console.log("pull after thenable start:", thenableStartReady);
    controller.close();
  },
});
await thenableStart.getReader().read();

let cancelFinished = false;
const asyncCancel = new ReadableStream<Uint8Array>({
  async cancel() {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    cancelFinished = true;
  },
});
await asyncCancel.cancel();
console.log("cancel awaited:", cancelFinished);

let thenableCancelFinished = false;
const thenableCancelSource = {
  cancel() {
    return {
      then(resolve: () => void) {
        setTimeout(() => {
          thenableCancelFinished = true;
          resolve();
        }, 5);
      },
    };
  },
};
const thenableCancel = new ReadableStream<Uint8Array>(thenableCancelSource);
await thenableCancel.cancel();
console.log("thenable cancel awaited:", thenableCancelFinished);

const queued = ReadableStream.from([
  Buffer.from("one"),
  Buffer.from("two"),
]);
const queuedReader = queued.getReader();
let queuedClosed = false;
async function watchQueuedClose(): Promise<void> {
  await queuedReader.closed;
  queuedClosed = true;
}
void watchQueuedClose();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("closed before drain:", queuedClosed);
await queuedReader.read();
await queuedReader.read();
await queuedReader.read();
await queuedReader.closed;
console.log("closed after drain:", queuedClosed);

// A pull that schedules its enqueue for later must not be re-entered merely
// because a reader is waiting. Node makes one follow-up pull after the
// delayed enqueue drains into that reader.
let delayedPullCount = 0;
const delayedReader = new ReadableStream<number>({
  pull(controller) {
    const call = ++delayedPullCount;
    if (call === 1) {
      setTimeout(() => {
        controller.enqueue(7);
        controller.close();
      }, 5);
    } else if (call === 3) {
      controller.error(new Error("pull re-entered before enqueue"));
    }
  },
}).getReader();
const delayedRead = await delayedReader.read();
console.log("delayed pull:", delayedRead.value, delayedPullCount);

let closedCancelCalls = 0;
const alreadyClosed = new ReadableStream<number>({
  start(controller) {
    controller.close();
  },
  cancel() {
    closedCancelCalls++;
  },
});
await alreadyClosed.cancel();
console.log("closed cancel:", closedCancelCalls);

let cancelCloseController!: ReadableStreamDefaultController<number>;
let cancelCloseCalls = 0;
const cancelCloseRequested = new ReadableStream<number>({
  start(controller) {
    cancelCloseController = controller;
    controller.enqueue(1);
    controller.close();
  },
  cancel() {
    cancelCloseCalls++;
  },
});
await cancelCloseRequested.cancel();
const cancelCloseReader = cancelCloseRequested.getReader();
let cancelCloseReaderClosed = false;
async function watchCancelCloseReader(): Promise<void> {
  await cancelCloseReader.closed;
  cancelCloseReaderClosed = true;
}
void watchCancelCloseReader();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log(
  "cancel close-requested:",
  cancelCloseController.desiredSize,
  cancelCloseCalls,
  cancelCloseReaderClosed,
);

let erroredCancelCalls = 0;
const alreadyErrored = new ReadableStream<number>({
  start(controller) {
    controller.error(new Error("cancel boom"));
  },
  cancel() {
    erroredCancelCalls++;
  },
});
try {
  await alreadyErrored.cancel();
} catch (error) {
  const caught = error as Error;
  console.log(
    "errored cancel:",
    caught.name,
    caught.message,
    erroredCancelCalls,
  );
}

const desiredSizes: Array<number | null> = [];
const desiredSizeStream = new ReadableStream<number>({
  start(controller) {
    desiredSizes.push(controller.desiredSize);
    controller.enqueue(1);
    desiredSizes.push(controller.desiredSize);
    controller.enqueue(2);
    desiredSizes.push(controller.desiredSize);
    controller.close();
    desiredSizes.push(controller.desiredSize);
  },
});
console.log(
  "desired sizes:",
  JSON.stringify(desiredSizes),
  desiredSizeStream.locked,
);

const omittedChunk = new ReadableStream<undefined>({
  start(controller) {
    controller.enqueue();
    controller.close();
  },
});
const omittedPart = await omittedChunk.getReader().read();
console.log("omitted enqueue:", omittedPart.done, omittedPart.value === undefined);

try {
  new ReadableStream<number>({
    start(controller) {
      controller.close();
      controller.close();
    },
  });
} catch (error) {
  const caught = error as Error;
  console.log("double close:", caught.name, caught.message);
}

let delayedRequestPullCount = 0;
const delayedRequestBody = new ReadableStream<Uint8Array>({
  async start() {
    // Let fetch attach as the consumer before the first pull.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  },
  pull(controller) {
    const call = ++delayedRequestPullCount;
    if (call === 1) {
      setTimeout(() => {
        controller.enqueue(Buffer.from("delayed request"));
        controller.close();
      }, 5);
    } else if (call === 3) {
      controller.error(new Error("request pull re-entered before enqueue"));
    }
  },
});
const delayedRequestResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: delayedRequestBody,
  duplex: "half",
});
console.log(
  "delayed request pull:",
  await delayedRequestResponse.json(),
  delayedRequestPullCount,
);

try {
  await fetch(`${process.argv[2]}/redirect-stream-302`, {
    method: "POST",
    body: ReadableStream.from([Buffer.from("redirected stream")]),
    duplex: "half",
  });
  console.log("stream 302 redirect unexpectedly followed");
} catch (error) {
  const caught = error as Error;
  console.log("stream 302 redirect:", caught.name, caught.message);
}

const stream303 = await fetch(`${process.argv[2]}/redirect-stream-303`, {
  method: "POST",
  body: ReadableStream.from([Buffer.from("redirected stream")]),
  duplex: "half",
});
console.log("stream 303 redirect:", await stream303.json());

const matchedStreamLength = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  headers: { "content-length": "2" },
  body: ReadableStream.from([Buffer.from("hi")]),
  duplex: "half",
});
console.log(
  "matched stream content-length:",
  await matchedStreamLength.json(),
);

try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    headers: { "content-length": "5" },
    body: ReadableStream.from([Buffer.from("hi")]),
    duplex: "half",
    signal: AbortSignal.timeout(200),
  });
} catch (error) {
  const caught = error as Error;
  console.log("stream content-length mismatch:", caught.name, caught.message);
}

let selfCapturingStream: ReadableStream<number>;
selfCapturingStream = new ReadableStream<number>({
  pull(controller) {
    console.log("self-capturing stream:", selfCapturingStream.locked);
    controller.close();
  },
});
await selfCapturingStream.getReader().read();

const selfCapturingSignal = AbortSignal.timeout(0);
selfCapturingSignal.addEventListener("abort", () => {
  console.log("self-capturing abort:", selfCapturingSignal.aborted);
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));

// Dropping the only Response/body reference must not strand the transfer
// behind the native stream's one-chunk backpressure pause.
await fetch(
  `${process.argv[2]}/backpressure?key=${pressureKey}-abandoned`,
);
console.log("abandoned response");
