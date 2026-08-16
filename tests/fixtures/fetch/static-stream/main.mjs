"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _a, _b, _c;
// Native AbortSignal + WHATWG readable-stream ownership coverage. The request body
// is produced in two turns, the response body is consumed through the
// default reader, and a timeout aborts a live native transfer.
function effectfulResponseMember() {
    console.log("computed response key evaluated");
    return "text";
}
function callComputedResponseMember(response) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, response[effectfulResponseMember()]()];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
try {
    await callComputedResponseMember(null);
}
catch (_d) {
    console.log("computed response receiver rejected");
}
function effectfulHeadersMember() {
    console.log("computed headers key evaluated");
    return "get";
}
function effectfulHeadersArgument() {
    console.log("computed headers argument evaluated");
    return "x-kind";
}
function callComputedHeadersMember(headers) {
    headers[effectfulHeadersMember()](effectfulHeadersArgument());
}
try {
    callComputedHeadersMember(null);
}
catch (_e) {
    console.log("computed headers receiver rejected");
}
try {
    new ReadableStream(null);
    console.log("null source unexpectedly accepted");
}
catch (error) {
    console.log("null source:", error.name);
}
var initialPullCalls = 0;
var initialPullStream = new ReadableStream({
    pull: function () {
        initialPullCalls++;
    },
});
console.log("initial pull sync:", initialPullCalls);
await Promise.resolve();
console.log("initial pull checkpoint:", initialPullCalls);
void initialPullStream;
var enqueuedIdentityBox = { value: 1 };
var enqueuedIdentityStream = new ReadableStream({
    start: function (controller) {
        controller.enqueue(enqueuedIdentityBox);
        controller.close();
    },
});
var enqueuedIdentityPart = await enqueuedIdentityStream.getReader().read();
if (!enqueuedIdentityPart.done)
    enqueuedIdentityPart.value.value = 2;
console.log("controller enqueue record identity:", enqueuedIdentityPart.done
    ? false
    : enqueuedIdentityPart.value === enqueuedIdentityBox, enqueuedIdentityBox.value);
function checkEnqueuedUnionIdentity(value, original) {
    return __awaiter(this, void 0, void 0, function () {
        var stream, part;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    stream = new ReadableStream({
                        start: function (controller) {
                            controller.enqueue(value);
                            controller.close();
                        },
                    });
                    return [4 /*yield*/, stream.getReader().read()];
                case 1:
                    part = _a.sent();
                    if (!part.done && typeof part.value !== "string") {
                        part.value.value = 3;
                    }
                    console.log("controller enqueue union identity:", part.done ? false : part.value === original, original.value);
                    return [2 /*return*/];
            }
        });
    });
}
var enqueuedUnionBox = { value: 1 };
await checkEnqueuedUnionIdentity(enqueuedUnionBox, enqueuedUnionBox);
var streamCancelState = { observed: "missing" };
var directCancelStream = new ReadableStream({
    cancel: function (reason) {
        streamCancelState.observed = reason;
    },
});
var directStreamCancelReason = { value: 1 };
await directCancelStream.cancel(directStreamCancelReason);
var streamCancelObserved = streamCancelState.observed;
if (typeof streamCancelObserved !== "string")
    streamCancelObserved.value = 2;
console.log("stream cancel reason identity:", streamCancelObserved === directStreamCancelReason, directStreamCancelReason.value);
var readerCancelState = { observed: "missing" };
var directReaderCancelStream = new ReadableStream({
    cancel: function (reason) {
        readerCancelState.observed = reason;
    },
});
var directReader = directReaderCancelStream.getReader();
var directReaderCancelReason = { value: 3 };
await directReader.cancel(directReaderCancelReason);
var readerCancelObserved = readerCancelState.observed;
if (typeof readerCancelObserved !== "string")
    readerCancelObserved.value = 4;
console.log("reader cancel reason identity:", readerCancelObserved === directReaderCancelReason, directReaderCancelReason.value);
function checkComputedControllerIdentity(select) {
    return __awaiter(this, void 0, void 0, function () {
        var controller, stream, box, member, part;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    stream = new ReadableStream({
                        start: function (value) {
                            controller = value;
                        },
                    });
                    box = { value: 1 };
                    member = select ? "enqueue" : "error";
                    controller[member](box);
                    box.value = 5;
                    controller.close();
                    return [4 /*yield*/, stream.getReader().read()];
                case 1:
                    part = _a.sent();
                    console.log("computed controller identity:", part.done ? false : part.value === box, part.done ? -1 : part.value.value);
                    return [2 /*return*/];
            }
        });
    });
}
await checkComputedControllerIdentity(true);
function checkAbortUnionIdentity(value, original) {
    var reason = AbortSignal.abort(value).reason;
    if (typeof reason !== "string")
        reason.value = 4;
    console.log("abort reason union identity:", reason === original, original.value);
}
var abortUnionBox = { value: 1 };
checkAbortUnionIdentity(abortUnionBox, abortUnionBox);
var enqueuedIdentityBytes = Buffer.from([1]);
var enqueuedBytesStream = new ReadableStream({
    start: function (controller) {
        controller.enqueue(enqueuedIdentityBytes);
        controller.close();
    },
});
var enqueuedBytesPart = await enqueuedBytesStream.getReader().read();
if (!enqueuedBytesPart.done)
    enqueuedBytesPart.value[0] = 2;
console.log("controller enqueue bytes identity:", enqueuedBytesPart.done
    ? false
    : enqueuedBytesPart.value === enqueuedIdentityBytes, enqueuedIdentityBytes[0]);
var undefinedOptionsStream = ReadableStream.from([3]);
var undefinedOptionsPart = await undefinedOptionsStream.getReader(undefined).read();
var emptyOptionsStream = ReadableStream.from([4]);
var emptyOptionsPart = await emptyOptionsStream.getReader({}).read();
console.log("default reader options:", undefinedOptionsPart.value, emptyOptionsPart.value);
// Draining a pre-queued chunk creates demand even with no second read.
var replenishingPulls = 0;
var replenishingStream = new ReadableStream({
    start: function (controller) {
        controller.enqueue(1);
    },
    pull: function (controller) {
        replenishingPulls++;
        controller.close();
    },
});
var replenishingReader = replenishingStream.getReader();
await Promise.resolve();
var replenishedPart = await replenishingReader.read();
await Promise.resolve();
console.log("pull after queued read:", replenishedPart.value, replenishingPulls);
var requestBody = new ReadableStream({
    start: function (controller) {
        controller.enqueue(Buffer.from("stream-"));
        setTimeout(function () {
            controller.enqueue(Buffer.from("body"));
            controller.close();
        }, 5);
    },
});
var posted = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    body: requestBody,
    duplex: "half",
});
console.log(await posted.json());
console.log("consumed request locked:", requestBody.locked);
var arrayRequestBody = ["array", "body"];
var arrayPosted = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    body: arrayRequestBody,
    duplex: "half",
});
var arrayPostResult = (await arrayPosted.json());
console.log("array request body:", arrayPostResult.body, arrayPostResult.contentType);
try {
    requestBody.getReader();
    console.log("consumed request reader unexpectedly acquired");
}
catch (error) {
    console.log("consumed request reader:", error.name);
}
var prelockedRequestBody = ReadableStream.from([
    Buffer.from("prelocked request"),
]);
var prelockedRequestReader = prelockedRequestBody.getReader();
try {
    await fetch("".concat(process.argv[2], "/post-echo"), {
        method: "POST",
        body: prelockedRequestBody,
        duplex: "half",
    });
    console.log("prelocked request unexpectedly sent");
}
catch (error) {
    console.log("prelocked request:", error.name);
}
prelockedRequestReader.releaseLock();
// A promised pull stays serialized until that promise settles. The
// second read queues demand while the first pull is still awaiting.
var activePulls = 0;
var maxActivePulls = 0;
var pullCount = 0;
var promisedPulls = new ReadableStream({
    pull: function (controller) {
        return __awaiter(this, void 0, void 0, function () {
            var n;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        activePulls++;
                        maxActivePulls = Math.max(maxActivePulls, activePulls);
                        n = ++pullCount;
                        controller.enqueue(Buffer.from([n]));
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 10); })];
                    case 1:
                        _a.sent();
                        activePulls--;
                        if (n === 2)
                            controller.close();
                        return [2 /*return*/];
                }
            });
        });
    },
});
var pullReader = promisedPulls.getReader();
await pullReader.read();
await pullReader.read();
await pullReader.closed;
console.log("max active pulls:", maxActivePulls);
var activeThenablePulls = 0;
var maxActiveThenablePulls = 0;
var thenablePullCount = 0;
var thenablePullSource = {
    pull: function (controller) {
        activeThenablePulls++;
        maxActiveThenablePulls = Math.max(maxActiveThenablePulls, activeThenablePulls);
        var n = ++thenablePullCount;
        controller.enqueue(n);
        return {
            then: function (resolve) {
                setTimeout(function () {
                    activeThenablePulls--;
                    if (n === 2)
                        controller.close();
                    resolve();
                }, 5);
            },
        };
    },
};
var thenablePulls = new ReadableStream(thenablePullSource);
var thenablePullReader = thenablePulls.getReader();
function readThenablePull() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, thenablePullReader.read()];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
var firstThenableRead = readThenablePull();
var secondThenableRead = readThenablePull();
await firstThenableRead;
await secondThenableRead;
await thenablePullReader.closed;
console.log("max active thenable pulls:", maxActiveThenablePulls);
var requestPull = 0;
var promisedRequestBody = new ReadableStream({
    pull: function (controller) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        requestPull++;
                        controller.enqueue(Buffer.from(requestPull === 1 ? "promised-" : "request"));
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 5); })];
                    case 1:
                        _a.sent();
                        if (requestPull === 2)
                            controller.close();
                        return [2 /*return*/];
                }
            });
        });
    },
});
var promisedPost = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    body: promisedRequestBody,
    duplex: "half",
});
console.log(await promisedPost.json());
var abortedRequestPulls = 0;
var abortedRequestCancels = 0;
var abortedRequestBody = new ReadableStream({
    pull: function (controller) {
        return __awaiter(this, void 0, void 0, function () {
            var call;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        call = ++abortedRequestPulls;
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 30); })];
                    case 1:
                        _a.sent();
                        controller.enqueue(Buffer.from("late"));
                        if (call === 2)
                            controller.close();
                        return [2 /*return*/];
                }
            });
        });
    },
    cancel: function () {
        abortedRequestCancels++;
    },
});
try {
    await fetch("".concat(process.argv[2], "/slow"), {
        method: "POST",
        body: abortedRequestBody,
        duplex: "half",
        signal: AbortSignal.timeout(5),
    });
}
catch (error) {
    console.log("aborted request:", error.name);
}
await new Promise(function (resolve) { return setTimeout(resolve, 70); });
console.log("aborted request source:", abortedRequestPulls, abortedRequestCancels, abortedRequestBody.locked);
var temporaryRead = await new ReadableStream({
    start: function (controller) {
        controller.enqueue(Buffer.from("temporary"));
        controller.close();
    },
}).getReader().read();
console.log("temporary reader:", temporaryRead.done ? "done" : new TextDecoder().decode(temporaryRead.value));
var concurrentValue = 0;
var concurrentReader = new ReadableStream({
    pull: function (controller) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 5); })];
                    case 1:
                        _a.sent();
                        concurrentValue++;
                        controller.enqueue(concurrentValue);
                        if (concurrentValue === 2)
                            controller.close();
                        return [2 /*return*/];
                }
            });
        });
    },
}).getReader();
function readConcurrent() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, concurrentReader.read()];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
var concurrentFirstPromise = readConcurrent();
var concurrentSecondPromise = readConcurrent();
var concurrentFirst = await concurrentFirstPromise;
var concurrentSecond = await concurrentSecondPromise;
console.log("concurrent reads:", concurrentFirst.value, concurrentSecond.value);
var releasedReader = new ReadableStream({
    start: function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 5); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    },
}).getReader();
var releasedRead = releasedReader.read();
var oldReleasedClosed = releasedReader.closed;
releasedReader.releaseLock();
var newReleasedClosed = releasedReader.closed;
try {
    await oldReleasedClosed;
}
catch (error) {
    var caught_1 = error;
    console.log("released old closed:", caught_1.name, caught_1.message);
}
try {
    await releasedRead;
}
catch (error) {
    var caught_2 = error;
    console.log("released read:", caught_2.name, caught_2.message);
}
try {
    await newReleasedClosed;
}
catch (error) {
    var caught_3 = error;
    console.log("released new closed:", caught_3.name, caught_3.message);
}
var releasedCancel = releasedReader.cancel();
console.log("released cancel returned");
try {
    await releasedCancel;
}
catch (error) {
    console.log("released cancel rejected:", error.name);
}
var liveValues = [1];
var liveValuesReader = ReadableStream.from(liveValues).getReader();
liveValues[0] = 2;
liveValues.push(3);
var liveFirst = await liveValuesReader.read();
var liveSecond = await liveValuesReader.read();
var liveDone = await liveValuesReader.read();
console.log("stream from live array:", liveFirst.value, liveSecond.value, liveDone.done);
var tupleValues = [6, 7];
var tupleReader = ReadableStream.from(tupleValues).getReader();
var tupleFirst = await tupleReader.read();
var tupleSecond = await tupleReader.read();
var tupleDone = await tupleReader.read();
console.log("stream from readonly tuple:", tupleFirst.value, tupleSecond.value, tupleDone.done);
var streamIdentityBox = { value: 1 };
var streamIdentityReader = ReadableStream.from([streamIdentityBox]).getReader();
var streamIdentityPart = await streamIdentityReader.read();
if (!streamIdentityPart.done) {
    streamIdentityPart.value.value = 2;
}
console.log("stream from record identity:", streamIdentityPart.done, streamIdentityPart.done
    ? false
    : streamIdentityPart.value === streamIdentityBox, streamIdentityBox.value);
var bracketReader = ReadableStream.from(["bracket"]).getReader();
var bracketPart = await bracketReader["read"]();
console.log("bracket reader read:", bracketPart.done, bracketPart.value);
var surplusReader = ReadableStream.from([11]).getReader();
console.log("reader surplus argument:", JSON.stringify(await surplusReader.read("ignored")));
var surplusSignal = AbortSignal.any([]);
console.log("throwIfAborted surplus argument:", surplusSignal.throwIfAborted("ignored"));
var streamUnionBox = { value: 9 };
var streamUnionValues = [streamUnionBox];
var streamUnionPart = await ReadableStream.from(streamUnionValues).getReader().read();
if (streamUnionPart.done) {
    console.log("stream from union identity:", true, false, -1);
}
else {
    console.log("stream from union identity:", false, streamUnionPart.value === streamUnionBox, (_b = (_a = streamUnionPart.value) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : -1);
}
var dynamicStreamReader = ReadableStream.from([{ value: 10 }]).getReader();
var dynamicStreamPart = await dynamicStreamReader.read();
console.log("dynamic stream result:", String(dynamicStreamPart.value), JSON.stringify(dynamicStreamPart));
console.log("dynamic stream record predicates:", typeof dynamicStreamPart.value === "object", !!dynamicStreamPart.value);
var dynamicPredicateArrayReader = ReadableStream.from([[1]]).getReader();
var dynamicPredicateArrayPart = await dynamicPredicateArrayReader.read();
console.log("dynamic stream array predicates:", typeof dynamicPredicateArrayPart.value === "object", !!dynamicPredicateArrayPart.value, Array.isArray(dynamicPredicateArrayPart.value));
var widenedRecordStream = ReadableStream.from([{ value: 7 }]);
var widenedRecordPart = await widenedRecordStream.getReader().read();
console.log("stream from widened record:", widenedRecordPart.done, widenedRecordPart.done
    ? "done"
    : JSON.stringify(widenedRecordPart.value));
var structurallyDerived = { value: 8, extra: 9 };
var structurallyWidenedStream = ReadableStream.from([structurallyDerived]);
var structurallyWidenedPart = await structurallyWidenedStream.getReader().read();
console.log("stream from structurally widened record:", structurallyWidenedPart.done, structurallyWidenedPart.done ? "done" : structurallyWidenedPart.value.value);
var repeatedStructuralValue = { value: 12, extra: 13 };
var repeatedStructuralReader = ReadableStream.from([
    repeatedStructuralValue,
    repeatedStructuralValue,
]).getReader();
var repeatedStructuralFirst = await repeatedStructuralReader.read();
repeatedStructuralValue.value = 19;
var repeatedStructuralSecond = await repeatedStructuralReader.read();
console.log("stream widened repeated identity:", repeatedStructuralFirst.done || repeatedStructuralSecond.done
    ? false
    : repeatedStructuralFirst.value === repeatedStructuralSecond.value, repeatedStructuralSecond.done ? -1 : repeatedStructuralSecond.value.value);
var nestedStructuralValue = [
    { value: 25, extra: 26 },
];
var nestedStructuralReader = ReadableStream.from([
    nestedStructuralValue,
    nestedStructuralValue,
]).getReader();
var nestedStructuralFirst = await nestedStructuralReader.read();
nestedStructuralValue[0].value = 27;
var nestedStructuralSecond = await nestedStructuralReader.read();
console.log("stream nested array widening:", nestedStructuralFirst.done || nestedStructuralSecond.done
    ? false
    : nestedStructuralFirst.value === nestedStructuralSecond.value, nestedStructuralSecond.done
    ? -1
    : nestedStructuralSecond.value[0].value);
var repeatedDynamicValue = { value: 14 };
var repeatedDynamicReader = ReadableStream.from([
    repeatedDynamicValue,
    repeatedDynamicValue,
]).getReader();
var repeatedDynamicFirst = await repeatedDynamicReader.read();
var repeatedDynamicSecond = await repeatedDynamicReader.read();
repeatedDynamicFirst.value.value = 15;
console.log("dynamic stream repeated identity:", repeatedDynamicFirst.value === repeatedDynamicSecond.value, repeatedDynamicSecond.value.value);
var liveDynamicValue = { value: 16 };
var liveDynamicReader = ReadableStream.from([
    liveDynamicValue,
    liveDynamicValue,
]).getReader();
var liveDynamicFirst = await liveDynamicReader.read();
console.log("dynamic stream live first:", JSON.stringify(liveDynamicFirst.value));
liveDynamicValue.value = 17;
var liveDynamicSecond = await liveDynamicReader.read();
console.log("dynamic stream live refresh:", JSON.stringify(liveDynamicSecond.value));
liveDynamicSecond.value.value = 18;
console.log("dynamic stream live commit:", liveDynamicValue.value);
var dynamicArrayValue = [21];
var dynamicArrayReader = ReadableStream.from([
    dynamicArrayValue,
    dynamicArrayValue,
]).getReader();
var dynamicArrayFirst = await dynamicArrayReader.read();
dynamicArrayFirst.value[0] = 22;
var dynamicArraySecond = await dynamicArrayReader.read();
console.log("dynamic stream array commit:", dynamicArrayValue[0], dynamicArraySecond.value[0], dynamicArrayFirst.value === dynamicArraySecond.value);
var dynamicArrayMethodValue = [31];
var dynamicArrayMethodReader = ReadableStream.from([
    dynamicArrayMethodValue,
]).getReader();
var dynamicArrayMethodPart = await dynamicArrayMethodReader.read();
var dynamicArrayMethodResult = dynamicArrayMethodPart.value.push(32);
console.log("dynamic stream array method:", dynamicArrayMethodResult, dynamicArrayMethodValue.join(","));
var dynamicArrayCallbackValue = [33];
var dynamicArrayCallbackReader = ReadableStream.from([
    dynamicArrayCallbackValue,
]).getReader();
var dynamicArrayCallbackPart = await dynamicArrayCallbackReader.read();
var dynamicArrayCallbackCalls = 0;
dynamicArrayCallbackPart.value.forEach(function (_value, _index, array) {
    dynamicArrayCallbackCalls++;
    array.push(34);
});
console.log("dynamic stream array callback:", dynamicArrayCallbackCalls, dynamicArrayCallbackValue.join(","));
var dynamicNestedValue = { nested: { value: 23 } };
var dynamicNestedReader = ReadableStream.from([
    dynamicNestedValue,
    dynamicNestedValue,
]).getReader();
var dynamicNestedFirst = await dynamicNestedReader.read();
var retainedDynamicNested = dynamicNestedFirst.value.nested;
retainedDynamicNested.value = 24;
var dynamicNestedSecond = await dynamicNestedReader.read();
console.log("dynamic stream nested commit:", dynamicNestedValue.nested.value, dynamicNestedSecond.value.nested.value, retainedDynamicNested === dynamicNestedSecond.value.nested);
var widenedStringStream = ReadableStream.from([
    "same",
    ["sa", "me"].join(""),
]);
var widenedStringReader = widenedStringStream.getReader();
var widenedStringFirst = await widenedStringReader.read();
var widenedStringSecond = await widenedStringReader.read();
console.log("stream widened string primitives:", widenedStringFirst.done ? "done" : typeof widenedStringFirst.value, widenedStringFirst.done || widenedStringSecond.done
    ? false
    : widenedStringFirst.value === widenedStringSecond.value);
var unionStringValues = [
    "same",
    ["sa", "me"].join(""),
];
var widenedUnionStringStream = ReadableStream.from(unionStringValues);
var widenedUnionStringReader = widenedUnionStringStream.getReader();
var widenedUnionStringFirst = await widenedUnionStringReader.read();
var widenedUnionStringSecond = await widenedUnionStringReader.read();
console.log("stream widened union string primitives:", widenedUnionStringFirst.done
    ? "done"
    : typeof widenedUnionStringFirst.value, widenedUnionStringFirst.done || widenedUnionStringSecond.done
    ? false
    : widenedUnionStringFirst.value === widenedUnionStringSecond.value);
var liveBytes = new Uint8Array([4]);
var liveBytesReader = ReadableStream.from(liveBytes).getReader();
liveBytes[0] = 5;
var liveByte = await liveBytesReader.read();
console.log("stream from live bytes:", liveByte.value);
var stringReader = ReadableStream.from("😀a").getReader();
var stringFirst = await stringReader.read();
var stringSecond = await stringReader.read();
var stringDone = await stringReader.read();
console.log("stream from string:", stringFirst.value, stringSecond.value, stringDone.done);
var streamed = await fetch("".concat(process.argv[2], "/chunked"));
var reader = streamed.body.getReader();
var chunks = [];
for (;;) {
    var part = await reader.read();
    if (part.done)
        break;
    chunks.push(part.value);
}
console.log(new TextDecoder().decode(Buffer.concat(chunks)), streamed.bodyUsed);
var lockedCancelResponse = await fetch("".concat(process.argv[2], "/chunked"));
var lockedCancelBody = lockedCancelResponse.body;
function collectLockedCancelResponse() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, lockedCancelResponse.text()];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
var lockedCancelText = collectLockedCancelResponse();
try {
    await lockedCancelBody.cancel();
    console.log("locked response cancel unexpectedly resolved");
}
catch (error) {
    console.log("locked response cancel:", error.name);
}
console.log("locked response text:", await lockedCancelText);
var closedCancelResponse = await fetch("".concat(process.argv[2], "/headers-source"));
var closedCancelBefore = closedCancelResponse.bodyUsed;
await closedCancelResponse.body.cancel();
console.log("closed response cancel:", closedCancelBefore, closedCancelResponse.bodyUsed);
var collected = await fetch("".concat(process.argv[2], "/text"));
await collected.text();
console.log("collected response locked:", collected.body.locked);
try {
    collected.body.getReader();
    console.log("collected response reader unexpectedly acquired");
}
catch (error) {
    console.log("collected response reader:", error.name);
}
var pressureKey = (_c = process.argv[3]) !== null && _c !== void 0 ? _c : "static-stream";
var pressured = await fetch("".concat(process.argv[2], "/backpressure?key=").concat(pressureKey));
await new Promise(function (resolve) { return setTimeout(resolve, 250); });
var pressureState = await (await fetch("".concat(process.argv[2], "/backpressure-state?key=").concat(pressureKey))).text();
console.log("response backpressure:", pressureState);
await pressured.body.cancel();
var gzipPressureBefore = process.resourceUsage().maxRSS;
var gzipPressured = await fetch("".concat(process.argv[2], "/gzip-pressure"));
await new Promise(function (resolve) { return setTimeout(resolve, 250); });
var gzipPressureGrowth = process.resourceUsage().maxRSS - gzipPressureBefore;
console.log("compressed response backpressure:", gzipPressureGrowth < 32 * 1024);
await gzipPressured.body.cancel();
var signal = AbortSignal.any([AbortSignal.timeout(20)]);
AbortSignal.abort().addEventListener("custom", function () {
    console.log("custom abort event unexpectedly fired");
});
console.log("custom abort listener registered");
var abortEvent = false;
signal.addEventListener("abort", function () {
    abortEvent = true;
    console.log("abort-first");
}, { once: true });
signal.addEventListener("abort", function () {
    console.log("abort-second");
}, { once: true });
try {
    await fetch("".concat(process.argv[2], "/slow"), { signal: signal });
}
catch (error) {
    var caught_4 = error;
    console.log(abortEvent, signal.aborted, caught_4.name, caught_4.message);
}
try {
    AbortSignal.abort(new Error("manual stop")).throwIfAborted();
}
catch (error) {
    var caught_5 = error;
    console.log(caught_5.name, caught_5.message);
}
var abortIdentityReason = { value: 1 };
var abortIdentitySignal = AbortSignal.abort(abortIdentityReason);
var observedAbortReason = abortIdentitySignal.reason;
observedAbortReason.value = 2;
console.log("abort reason identity:", observedAbortReason === abortIdentityReason, abortIdentityReason.value);
var abortIdentityBytes = Buffer.from([5]);
var observedAbortBytes = AbortSignal.abort(abortIdentityBytes).reason;
observedAbortBytes[0] = 6;
console.log("abort reason bytes identity:", observedAbortBytes === abortIdentityBytes, abortIdentityBytes[0]);
var identitySignal = AbortSignal.timeout(0);
var identityCalls = 0;
var identityListener = function () {
    identityCalls++;
};
identitySignal.addEventListener("abort", identityListener);
identitySignal.addEventListener("abort", identityListener);
identitySignal.removeEventListener("abort", identityListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("removed abort listener:", identityCalls);
function addComputedAbortListener(target, listener, select) {
    var member = select
        ? "addEventListener"
        : "removeEventListener";
    target[member]("abort", listener);
}
var computedIdentitySignal = AbortSignal.timeout(0);
var computedIdentityCalls = 0;
var computedIdentityListener = {
    handleEvent: function (_event) {
        computedIdentityCalls++;
    },
};
addComputedAbortListener(computedIdentitySignal, computedIdentityListener, true);
computedIdentitySignal.removeEventListener("abort", computedIdentityListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("computed removed abort listener:", computedIdentityCalls);
var mutationSignal = AbortSignal.timeout(0);
var mutationCalls = 0;
var selfRemovingListener = function () {
    mutationCalls++;
    mutationSignal.removeEventListener("abort", selfRemovingListener);
};
mutationSignal.addEventListener("abort", selfRemovingListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("self-removing abort listener:", mutationCalls);
var dispatchSignal = AbortSignal.timeout(0);
var dispatchEvent;
var dispatchCalls = 0;
dispatchSignal.addEventListener("abort", function (event) {
    dispatchEvent = event;
    dispatchCalls++;
});
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("manual abort dispatch:", dispatchSignal.dispatchEvent(dispatchEvent), dispatchCalls);
var truthyOptionsSignal = AbortSignal.timeout(0);
var truthyOptionsEvent;
var truthyOptionsCalls = 0;
var truthyOptionsListener = function (event) {
    truthyOptionsEvent = event;
    truthyOptionsCalls++;
};
var truthyListenerOptions = JSON.parse('{"capture":1,"once":1}');
truthyOptionsSignal.addEventListener("abort", truthyOptionsListener, truthyListenerOptions);
truthyOptionsSignal.addEventListener("abort", truthyOptionsListener, true);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
truthyOptionsSignal.dispatchEvent(truthyOptionsEvent);
console.log("truthy abort listener options:", truthyOptionsCalls);
var stoppedDispatchSignal = AbortSignal.timeout(0);
var stoppedDispatchEvent;
var stoppedDispatchCalls = [];
stoppedDispatchSignal.addEventListener("abort", function (event) {
    stoppedDispatchEvent = event;
    stoppedDispatchCalls.push("first");
    event.stopImmediatePropagation();
}, { once: true });
stoppedDispatchSignal.addEventListener("abort", function () {
    stoppedDispatchCalls.push("second");
});
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
stoppedDispatchSignal.dispatchEvent(stoppedDispatchEvent);
console.log("stopped abort redispatch:", stoppedDispatchCalls.join(","));
var eventSignal = AbortSignal.timeout(0);
eventSignal.addEventListener("abort", function (event) {
    console.log("abort event:", event.type, event.target === eventSignal, event.currentTarget === eventSignal, event.srcElement === eventSignal, event.bubbles, event.cancelable, event.composed, event.defaultPrevented, event.eventPhase, event.isTrusted, event.timeStamp >= 0, event.cancelBubble, event.returnValue, event.composedPath().length);
    event.preventDefault();
    event.stopPropagation();
    console.log("abort event propagation:", event.defaultPrevented, event.cancelBubble, event.returnValue);
    setTimeout(function () {
        console.log("abort event after dispatch:", event.target === eventSignal, event.currentTarget === null, event.srcElement === eventSignal, event.eventPhase, event.cancelBubble, event.composedPath().length);
    }, 0);
});
eventSignal.addEventListener("abort", function () {
    console.log("abort listener after stopPropagation");
});
eventSignal.addEventListener("abort", null);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
var immediateSignal = AbortSignal.timeout(0);
var immediateHandlers = [];
immediateSignal.addEventListener("abort", function (event) {
    immediateHandlers.push("first");
    event.stopImmediatePropagation();
});
immediateSignal.addEventListener("abort", function () {
    immediateHandlers.push("second");
});
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("abort stop immediate:", immediateHandlers.join(","));
var captureSignal = AbortSignal.timeout(0);
var captureCalls = 0;
var captureListener = function () {
    captureCalls++;
};
captureSignal.addEventListener("abort", captureListener, false);
captureSignal.addEventListener("abort", captureListener, true);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("capture listener identity:", captureCalls);
var objectSignal = AbortSignal.timeout(0);
var objectCalls = 0;
var objectListener = {
    handleEvent: function (event) {
        if (event.type === "abort")
            objectCalls++;
    },
};
objectSignal.addEventListener("abort", objectListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("object abort listener:", objectCalls);
var updatedObjectSignal = AbortSignal.timeout(0);
var updatedObjectCalls = "";
var updatedObjectListener = {
    handleEvent: function (_event) {
        updatedObjectCalls += "old";
    },
};
updatedObjectSignal.addEventListener("abort", updatedObjectListener);
updatedObjectListener.handleEvent = function (_event) {
    updatedObjectCalls += "new";
};
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("updated object abort listener:", updatedObjectCalls);
var removedObjectSignal = AbortSignal.timeout(0);
var removedObjectCalls = 0;
var removedObjectListener = {
    handleEvent: function () {
        removedObjectCalls++;
    },
};
removedObjectSignal.addEventListener("abort", removedObjectListener);
removedObjectSignal.addEventListener("abort", removedObjectListener);
removedObjectSignal.removeEventListener("abort", removedObjectListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("removed object abort listener:", removedObjectCalls);
var distinctObjectSignal = AbortSignal.timeout(0);
var distinctObjectCalls = 0;
var sharedObjectHandler = function () {
    distinctObjectCalls++;
};
var firstObjectListener = { handleEvent: sharedObjectHandler };
var secondObjectListener = { handleEvent: sharedObjectHandler };
distinctObjectSignal.addEventListener("abort", firstObjectListener);
distinctObjectSignal.addEventListener("abort", secondObjectListener);
distinctObjectSignal.removeEventListener("abort", firstObjectListener);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("distinct object abort listener:", distinctObjectCalls);
var orderedSignal = AbortSignal.timeout(0);
var orderedHandlers = [];
orderedSignal.addEventListener("abort", function () {
    orderedHandlers.push("listener");
});
orderedSignal.onabort = function () {
    orderedHandlers.push("onabort");
};
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("abort handler order:", orderedHandlers.join(","));
var noncallableOnabortSignal = AbortSignal.timeout(0);
noncallableOnabortSignal.onabort = 42;
console.log("noncallable onabort value:", noncallableOnabortSignal.onabort);
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("noncallable onabort ignored:", noncallableOnabortSignal.aborted);
var listenerGate = AbortSignal.timeout(0);
var gatedTarget = AbortSignal.timeout(10);
var gatedCalls = 0;
gatedTarget.addEventListener("abort", function () {
    gatedCalls++;
}, { signal: listenerGate });
var preAbortedTarget = AbortSignal.timeout(0);
preAbortedTarget.addEventListener("abort", function () {
    gatedCalls++;
}, { signal: AbortSignal.abort() });
await new Promise(function (resolve) { return setTimeout(resolve, 20); });
console.log("abort listener signal:", gatedCalls);
for (var _i = 0, _f = [-1, Number.NaN, Number.POSITIVE_INFINITY, 4294967296]; _i < _f.length; _i++) {
    var delay_1 = _f[_i];
    try {
        AbortSignal.timeout(delay_1);
    }
    catch (error) {
        var caught_6 = error;
        console.log("invalid timeout:", caught_6.name, caught_6.message);
    }
}
try {
    var missingDuplex = ReadableStream.from([Buffer.from("no-duplex")]);
    await fetch("".concat(process.argv[2], "/post-echo"), {
        method: "POST",
        body: missingDuplex,
    });
}
catch (error) {
    var caught_7 = error;
    console.log("missing duplex:", caught_7.name, caught_7.message);
}
var startReady = false;
var asyncStart = new ReadableStream({
    start: function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 5); })];
                    case 1:
                        _a.sent();
                        startReady = true;
                        return [2 /*return*/];
                }
            });
        });
    },
    pull: function (controller) {
        console.log("pull after start:", startReady);
        controller.close();
    },
});
await asyncStart.getReader().read();
var releaseQueuedStart = function () { };
var queuedDuringStart = new ReadableStream({
    start: function (controller) {
        controller.enqueue("queued");
        return new Promise(function (resolve) {
            releaseQueuedStart = resolve;
        });
    },
});
var queuedStartObserved = "pending";
var queuedStartRead = queuedDuringStart.getReader().read();
void queuedStartRead.then(function (part) {
    queuedStartObserved = part.done ? "done" : "read:".concat(part.value);
});
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
console.log("queued during pending start:", queuedStartObserved);
releaseQueuedStart();
await queuedStartRead;
var thenableStartReady = false;
var thenableStart = new ReadableStream({
    start: function () {
        return {
            then: function (resolve) {
                setTimeout(function () {
                    thenableStartReady = true;
                    resolve();
                }, 5);
            },
        };
    },
    pull: function (controller) {
        console.log("pull after thenable start:", thenableStartReady);
        controller.close();
    },
});
await thenableStart.getReader().read();
var cancelFinished = false;
var asyncCancel = new ReadableStream({
    cancel: function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 5); })];
                    case 1:
                        _a.sent();
                        cancelFinished = true;
                        return [2 /*return*/];
                }
            });
        });
    },
});
await asyncCancel.cancel();
console.log("cancel awaited:", cancelFinished);
var thenableCancelFinished = false;
var thenableCancelSource = {
    cancel: function () {
        return {
            then: function (resolve) {
                setTimeout(function () {
                    thenableCancelFinished = true;
                    resolve();
                }, 5);
            },
        };
    },
};
var thenableCancel = new ReadableStream(thenableCancelSource);
await thenableCancel.cancel();
console.log("thenable cancel awaited:", thenableCancelFinished);
var queued = ReadableStream.from([
    Buffer.from("one"),
    Buffer.from("two"),
]);
var queuedReader = queued.getReader();
var queuedClosed = false;
function watchQueuedClose() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, queuedReader.closed];
                case 1:
                    _a.sent();
                    queuedClosed = true;
                    return [2 /*return*/];
            }
        });
    });
}
void watchQueuedClose();
await new Promise(function (resolve) { return setTimeout(resolve, 0); });
console.log("closed before drain:", queuedClosed);
await queuedReader.read();
await queuedReader.read();
await queuedReader.read();
await queuedReader.closed;
console.log("closed after drain:", queuedClosed);
// A pull that schedules its enqueue for later must not be re-entered merely
// because a reader is waiting. Node makes one follow-up pull after the
// delayed enqueue drains into that reader.
var delayedPullCount = 0;
var delayedReader = new ReadableStream({
    pull: function (controller) {
        var call = ++delayedPullCount;
        if (call === 1) {
            setTimeout(function () {
                controller.enqueue(7);
                controller.close();
            }, 5);
        }
        else if (call === 3) {
            controller.error(new Error("pull re-entered before enqueue"));
        }
    },
}).getReader();
var delayedRead = await delayedReader.read();
console.log("delayed pull:", delayedRead.value, delayedPullCount);
var closedCancelCalls = 0;
var alreadyClosed = new ReadableStream({
    start: function (controller) {
        controller.close();
    },
    cancel: function () {
        closedCancelCalls++;
    },
});
await alreadyClosed.cancel();
console.log("closed cancel:", closedCancelCalls);
var cancelCloseController;
var cancelCloseCalls = 0;
var cancelCloseRequested = new ReadableStream({
    start: function (controller) {
        cancelCloseController = controller;
        controller.enqueue(1);
        controller.close();
    },
    cancel: function () {
        cancelCloseCalls++;
    },
});
await cancelCloseRequested.cancel();
var cancelCloseReader = cancelCloseRequested.getReader();
var cancelCloseReaderClosed = false;
function watchCancelCloseReader() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, cancelCloseReader.closed];
                case 1:
                    _a.sent();
                    cancelCloseReaderClosed = true;
                    return [2 /*return*/];
            }
        });
    });
}
void watchCancelCloseReader();
await new Promise(function (resolve) { return setTimeout(resolve, 0); });
console.log("cancel close-requested:", cancelCloseController.desiredSize, cancelCloseCalls, cancelCloseReaderClosed);
var erroredCancelCalls = 0;
var alreadyErrored = new ReadableStream({
    start: function (controller) {
        controller.error(new Error("cancel boom"));
    },
    cancel: function () {
        erroredCancelCalls++;
    },
});
try {
    await alreadyErrored.cancel();
}
catch (error) {
    var caught_8 = error;
    console.log("errored cancel:", caught_8.name, caught_8.message, erroredCancelCalls);
}
var desiredSizes = [];
var desiredSizeStream = new ReadableStream({
    start: function (controller) {
        desiredSizes.push(controller.desiredSize);
        controller.enqueue(1);
        desiredSizes.push(controller.desiredSize);
        controller.enqueue(2);
        desiredSizes.push(controller.desiredSize);
        controller.close();
        desiredSizes.push(controller.desiredSize);
    },
});
console.log("desired sizes:", JSON.stringify(desiredSizes), desiredSizeStream.locked);
var omittedChunk = new ReadableStream({
    start: function (controller) {
        controller.enqueue();
        controller.close();
    },
});
var omittedPart = await omittedChunk.getReader().read();
console.log("omitted enqueue:", omittedPart.done, omittedPart.value === undefined);
try {
    new ReadableStream({
        start: function (controller) {
            controller.close();
            controller.close();
        },
    });
}
catch (error) {
    var caught_9 = error;
    console.log("double close:", caught_9.name, caught_9.message);
}
var delayedRequestPullCount = 0;
var delayedRequestBody = new ReadableStream({
    start: function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: 
                    // Let fetch attach as the consumer before the first pull.
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1); })];
                    case 1:
                        // Let fetch attach as the consumer before the first pull.
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    },
    pull: function (controller) {
        var call = ++delayedRequestPullCount;
        if (call === 1) {
            setTimeout(function () {
                controller.enqueue(Buffer.from("delayed request"));
                controller.close();
            }, 5);
        }
        else if (call === 3) {
            controller.error(new Error("request pull re-entered before enqueue"));
        }
    },
});
var delayedRequestResponse = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    body: delayedRequestBody,
    duplex: "half",
});
console.log("delayed request pull:", await delayedRequestResponse.json(), delayedRequestPullCount);
try {
    await fetch("".concat(process.argv[2], "/redirect-stream-302"), {
        method: "POST",
        body: ReadableStream.from([Buffer.from("redirected stream")]),
        duplex: "half",
    });
    console.log("stream 302 redirect unexpectedly followed");
}
catch (error) {
    var caught_10 = error;
    console.log("stream 302 redirect:", caught_10.name, caught_10.message);
}
var stream303 = await fetch("".concat(process.argv[2], "/redirect-stream-303"), {
    method: "POST",
    body: ReadableStream.from([Buffer.from("redirected stream")]),
    duplex: "half",
});
console.log("stream 303 redirect:", await stream303.json());
var matchedStreamLength = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    headers: { "content-length": "2" },
    body: ReadableStream.from([Buffer.from("hi")]),
    duplex: "half",
});
console.log("matched stream content-length:", await matchedStreamLength.json());
try {
    await fetch("".concat(process.argv[2], "/post-echo"), {
        method: "POST",
        headers: { "content-length": "5" },
        body: ReadableStream.from([Buffer.from("hi")]),
        duplex: "half",
        signal: AbortSignal.timeout(200),
    });
}
catch (error) {
    var caught_11 = error;
    console.log("stream content-length mismatch:", caught_11.name, caught_11.message);
}
var failingRequestPulls = 0;
var failingRequestBody = new ReadableStream({
    pull: function (controller) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        failingRequestPulls++;
                        controller.enqueue(Buffer.from("partial upload"));
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 25); })];
                    case 1:
                        _a.sent();
                        throw new Error("late upload failure");
                }
            });
        });
    },
});
try {
    await fetch("".concat(process.argv[2], "/upload-failure"), {
        method: "POST",
        body: failingRequestBody,
        duplex: "half",
    });
    console.log("failing request unexpectedly resolved");
}
catch (error) {
    var caught_12 = error;
    console.log("failing request:", caught_12.name, caught_12.message, caught_12 instanceof TypeError, failingRequestPulls);
}
var truncatedResponse = await fetch("".concat(process.argv[2], "/truncated-response"));
try {
    await truncatedResponse.text();
    console.log("truncated response unexpectedly read");
}
catch (error) {
    var caught_13 = error;
    console.log("truncated response:", caught_13.name, caught_13.message, caught_13 instanceof TypeError, caught_13 instanceof DOMException);
}
var selfCapturingStream;
selfCapturingStream = new ReadableStream({
    pull: function (controller) {
        console.log("self-capturing stream:", selfCapturingStream.locked);
        controller.close();
    },
});
await selfCapturingStream.getReader().read();
var selfCapturingSignal = AbortSignal.timeout(0);
selfCapturingSignal.addEventListener("abort", function () {
    console.log("self-capturing abort:", selfCapturingSignal.aborted);
});
await new Promise(function (resolve) { return setTimeout(resolve, 5); });
// These callbacks deliberately leave their owners open and capture the
// owner handles. The native teardown must sever both callback cycles before
// the sanitized RC audit runs.
function leaveOpenStreamCycle() {
    var openStream;
    openStream = new ReadableStream({
        pull: function () {
            void openStream.locked;
        },
    });
}
function leaveNeverAbortingSignalCycle() {
    var openSignal = AbortSignal.any([]);
    openSignal.addEventListener("abort", function () {
        void openSignal.aborted;
    });
}
leaveOpenStreamCycle();
leaveNeverAbortingSignalCycle();
await Promise.resolve();
// Dropping the only Response/body reference must not strand the transfer
// behind the native stream's one-chunk backpressure pause.
await fetch("".concat(process.argv[2], "/backpressure?key=").concat(pressureKey, "-abandoned"));
console.log("abandoned response");
export {};
