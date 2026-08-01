let startThis = "not-called";
let pullThis = "not-called";
let cancelThis = "not-called";

function start(controller) {
  startThis = this && this.marker;
  controller.enqueue("chunk");
}

function pull(controller) {
  pullThis = this && this.marker;
  controller.close();
}

function cancel() {
  cancelThis = this && this.marker;
}

const source = { marker: "source", start, pull };
const reader = new ReadableStream(source).getReader();
const first = await reader.read();
const done = await reader.read();

const cancelSource = { marker: "cancel-source", cancel };
const cancelStream = new ReadableStream(cancelSource);
await cancelStream.cancel();

function mutatingStart() {
  this.marker = "changed";
}

const mutatingSource = { marker: "original", start: mutatingStart };
new ReadableStream(mutatingSource);

console.log(
  "stream source callback this:",
  startThis,
  pullThis,
  cancelThis,
  first.value,
  done.done,
);
console.log("stream source callback mutation:", mutatingSource.marker);

let surplusEffects = "";
function ignoredCompanionArgument(label) {
  surplusEffects += label;
  return "ignored";
}

const surplusAbort = AbortSignal.abort(
  undefined,
  ignoredCompanionArgument("abort "),
);
const surplusTimeout = AbortSignal.timeout(
  10000,
  ignoredCompanionArgument("timeout "),
);
const surplusAny = AbortSignal.any(
  [],
  ignoredCompanionArgument("any "),
);
const surplusStreamPart = await ReadableStream.from(
  ["surplus"],
  ignoredCompanionArgument("stream"),
).getReader().read();
console.log(
  "companion surplus arguments:",
  surplusEffects,
  surplusAbort.aborted,
  surplusTimeout.aborted,
  surplusAny.aborted,
  surplusStreamPart.value,
);

export {};
