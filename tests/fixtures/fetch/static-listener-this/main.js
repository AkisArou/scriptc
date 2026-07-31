let observed = "not-called";
let listener;
const signal = AbortSignal.timeout(0);

function handleAbort() {
  observed =
    this === listener ? "listener" : this === signal ? "signal" : "other";
}

listener = { handleEvent: handleAbort };
signal.addEventListener("abort", listener);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("object abort listener this:", observed);

export {};
