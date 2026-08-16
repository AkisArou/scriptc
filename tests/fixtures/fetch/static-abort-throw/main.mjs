"use strict";
var keepAlive = setInterval(function () { }, 1000);
var signal = AbortSignal.timeout(0);
signal.addEventListener("abort", function () {
    clearInterval(keepAlive);
    console.log("throwing abort listener");
    throw new Error("abort listener failed");
});
signal.addEventListener("abort", function () {
    console.log("later abort listener");
});
export {};
