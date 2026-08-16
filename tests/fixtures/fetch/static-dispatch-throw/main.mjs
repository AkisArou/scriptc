"use strict";
var abortEvent;
var source = AbortSignal.timeout(0);
source.addEventListener("abort", function (event) {
    abortEvent = event;
}, { once: true });
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
var target = AbortSignal.abort();
target.addEventListener("abort", function () {
    console.log("throwing dispatch listener");
    throw new Error("dispatch listener failed");
});
target.addEventListener("abort", function () {
    console.log("later dispatch listener");
});
try {
    console.log("returned", target.dispatchEvent(abortEvent));
}
catch (error) {
    console.log("caught", error instanceof Error ? error.message : String(error));
}
console.log("after dispatch");
export {};
