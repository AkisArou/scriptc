"use strict";
var controller = new AbortController();
var signal = controller.signal;
console.log("controller initial:", signal.aborted, controller.signal === signal);
var reason = { value: 1 };
var eventCalls = 0;
signal.addEventListener("abort", function (event) {
    eventCalls++;
    console.log("controller event:", event.type, event.target === signal, signal.reason === reason);
});
controller.abort(reason);
controller.abort(new Error("ignored"));
var observedReason = signal.reason;
observedReason.value = 2;
console.log("controller final:", signal.aborted, eventCalls, observedReason === reason, reason.value);
var computedController = new AbortController();
var abortMember = "abort";
computedController[abortMember]("computed reason");
console.log("computed abort:", computedController.signal.reason);
var surplusEffects = "";
function constructorSurplus() {
    surplusEffects += "ctor ";
    return 1;
}
function abortSurplus() {
    surplusEffects += "abort";
    return 2;
}
// @ts-expect-error JavaScript accepts and evaluates surplus constructor arguments.
var surplusController = new AbortController(constructorSurplus());
// @ts-expect-error JavaScript also evaluates surplus abort() arguments.
surplusController.abort(undefined, abortSurplus());
console.log("controller surplus:", surplusEffects);
var ignoredMapEffect = "";
function ignoredMapSurplus() {
    ignoredMapEffect = "map";
    return new Map();
}
var mapSurplusController = new AbortController();
// @ts-expect-error JavaScript evaluates and ignores every surplus argument.
mapSurplusController.abort(undefined, ignoredMapSurplus());
console.log("controller map surplus:", ignoredMapEffect, mapSurplusController.signal.aborted);
var selfReasonController = new AbortController();
selfReasonController.abort(selfReasonController);
console.log("controller self reason:", selfReasonController.signal.reason === selfReasonController);
var signalReasonController = new AbortController();
var ownSignalReason = signalReasonController.signal;
signalReasonController.abort(ownSignalReason);
console.log("controller signal reason:", ownSignalReason.reason === ownSignalReason);
var leftReasonController = new AbortController();
var rightReasonController = new AbortController();
leftReasonController.abort(rightReasonController);
rightReasonController.abort(leftReasonController);
console.log("controller mutual reasons:", leftReasonController.signal.reason === rightReasonController, rightReasonController.signal.reason === leftReasonController);
var watchedReasonController = new AbortController();
var watchedReasonSignal = AbortSignal.any([watchedReasonController.signal]);
watchedReasonController.abort(watchedReasonController);
var watchedThrowMatches = false;
try {
    watchedReasonSignal.throwIfAborted();
}
catch (error) {
    watchedThrowMatches = error === watchedReasonController;
}
console.log("controller propagated reason:", watchedReasonSignal.reason === watchedReasonController, watchedThrowMatches);
try {
    await fetch("".concat(process.argv[2], "/slow"), {
        signal: selfReasonController.signal,
    });
    console.log("controller pre-aborted fetch unexpectedly resolved");
}
catch (error) {
    console.log("controller pre-aborted fetch reason:", error === selfReasonController);
}
var fetchController = new AbortController();
setTimeout(function () { return fetchController.abort(new Error("manual timeout")); }, 20);
try {
    await fetch("".concat(process.argv[2], "/slow"), {
        signal: fetchController.signal,
    });
    console.log("controller fetch unexpectedly resolved");
}
catch (error) {
    var caught_1 = error;
    console.log("controller fetch:", caught_1.name, caught_1.message);
}
export {};
