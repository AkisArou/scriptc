"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var _a, _b;
// The engine-free user surface: this is intentionally top-level and has
// no --dynamic directive. Both backends must compile fetch(url),
// RequestInit, and Response.json() into the native net/http/tls runtime.
var constructed = new Response("1");
console.log("constructed response:", constructed.status, constructed.ok, JSON.stringify(constructed.statusText), JSON.stringify(constructed.url), constructed.redirected, constructed.headers.get("content-type"), constructed.body !== null, constructed.bodyUsed, await constructed.text(), constructed.bodyUsed);
var configuredResponse = new Response(new Uint8Array([104, 105]), {
    status: 201,
    statusText: "Made",
    headers: { "x-one": "one", connection: "custom" },
});
configuredResponse.headers.append("x-one", "two");
configuredResponse.headers.set("x-two", "set");
configuredResponse.headers.delete("x-two");
console.log("configured response:", configuredResponse.status, configuredResponse.statusText, configuredResponse.headers.get("x-one"), configuredResponse.headers.get("connection"), configuredResponse.headers.has("x-two"), await configuredResponse.text());
var responseAsInitSource = new Response("source", {
    status: 203,
    statusText: "Copied",
    headers: { "x-response-init": "yes" },
});
var responseAsInit = new Response(null, responseAsInitSource);
console.log("response as init:", responseAsInit.status, responseAsInit.statusText, responseAsInit.headers.get("x-response-init"));
var bodyMutatedResponseInit = {
    status: 201,
    headers: { "x-body-mutated": "before" },
};
var responseInitMutatingBody = {
    toString: function () {
        bodyMutatedResponseInit.status = 202;
        bodyMutatedResponseInit.headers["x-body-mutated"] = "after";
        return "mutated";
    },
};
var responseAfterBodyInitMutation = new Response(responseInitMutatingBody, bodyMutatedResponseInit);
console.log("response init after body conversion:", responseAfterBodyInitMutation.status, responseAfterBodyInitMutation.headers.get("x-body-mutated"));
var spreadResponseHeaders = { "x-spread-live": "before" };
var spreadResponseInit = { headers: spreadResponseHeaders };
var spreadResponseBody = {
    toString: function () {
        spreadResponseHeaders["x-spread-live"] = "after";
        return "spread";
    },
};
var responseWithSpreadInit = new Response(spreadResponseBody, __assign({}, spreadResponseInit));
console.log("response spread init after body conversion:", responseWithSpreadInit.headers.get("x-spread-live"));
var responseHandleBody = new Response();
console.log("response handle body:", await new Response(responseHandleBody).text());
var ClassResponseInit = /** @class */ (function () {
    function ClassResponseInit() {
        this.status = 202;
        this.statusText = "Class Made";
        this.headers = { "x-class-init": "yes" };
    }
    return ClassResponseInit;
}());
var classConfiguredResponse = new Response(null, new ClassResponseInit());
console.log("class response init:", classConfiguredResponse.status, classConfiguredResponse.statusText, classConfiguredResponse.headers.get("x-class-init"));
var normalizedResponseHeaders = new Response(null, {
    headers: { "X-Mixed-Case": "yes" },
}).headers;
console.log("response header name normalization:", normalizedResponseHeaders.get("x-mixed-case"), normalizedResponseHeaders.has("X-MIXED-CASE"));
var latin1Response = new Response(null, {
    statusText: "é",
    headers: { "x-latin": "é" },
});
latin1Response.headers.append("x-latin", "é");
console.log("response latin1 metadata:", JSON.stringify(latin1Response.statusText), JSON.stringify(latin1Response.headers.get("x-latin")));
var cookieResponseHeaders = new Response().headers;
cookieResponseHeaders.append("cookie", "a");
cookieResponseHeaders.append("cookie", "b");
console.log("response cookie append:", cookieResponseHeaders.get("cookie"));
var deleteDuringForEachHeaders = new Response(null, {
    headers: { a: "1", b: "2", c: "3" },
}).headers;
var deleteDuringForEachSeen = [];
deleteDuringForEachHeaders.forEach(function (value, name) {
    deleteDuringForEachSeen.push("".concat(name, "=").concat(value));
    if (name === "a")
        deleteDuringForEachHeaders.delete("b");
});
console.log("response header forEach delete:", deleteDuringForEachSeen.join(","));
var appendDuringForEachHeaders = new Response(null, {
    headers: { a: "1", c: "3" },
}).headers;
var appendDuringForEachSeen = [];
appendDuringForEachHeaders.forEach(function (value, name) {
    appendDuringForEachSeen.push("".concat(name, "=").concat(value));
    if (name === "a")
        appendDuringForEachHeaders.append("b", "2");
});
console.log("response header forEach append:", appendDuringForEachSeen.join(","));
var responseHeaderMutationOrder = [];
var responseHeaderNameCalls = 0;
var responseHeaderName = {
    toString: function () {
        responseHeaderMutationOrder.push("name".concat(++responseHeaderNameCalls));
        return "x-atomic";
    },
};
var responseHeaderValue = {
    toString: function () {
        responseHeaderMutationOrder.push("value");
        throw new Error("response header value conversion");
    },
};
var atomicResponseHeaders = new Response(null, {
    headers: { "x-atomic": "old" },
}).headers;
try {
    atomicResponseHeaders.set(responseHeaderName, responseHeaderValue);
}
catch (_c) { }
console.log("response header set failure:", responseHeaderMutationOrder.join(","), atomicResponseHeaders.get("x-atomic"));
var nullResponseHeadersInit = { headers: null };
try {
    new Response(null, nullResponseHeadersInit);
    console.log("response null headers unexpectedly accepted");
}
catch (error) {
    console.log("response null headers:", error.name, JSON.stringify(error.message));
}
try {
    new Response(null, { headers: { "bad name": "x" } });
}
catch (error) {
    console.log("response invalid header name:", error.name, JSON.stringify(error.message));
}
try {
    new Response(null, { headers: { x: "bad\nvalue" } });
}
catch (error) {
    console.log("response invalid header value:", error.name, JSON.stringify(error.message));
}
try {
    new Response(null, { headers: { x: "bad\0value" } });
}
catch (error) {
    console.log("response nul header value:", error.name, JSON.stringify(error.message));
}
var shortHeaderPairInit = { headers: [["x"]] };
try {
    new Response(null, shortHeaderPairInit);
}
catch (error) {
    console.log("response short header pair:", error.name, JSON.stringify(error.message));
}
try {
    new Response().headers.append("bad name", "x");
}
catch (error) {
    console.log("response header mutation validation:", error.name, JSON.stringify(error.message));
}
var nullResponse = new Response(null, { status: 204 });
console.log("null response:", nullResponse.body === null, nullResponse.bodyUsed, JSON.stringify(await nullResponse.text()), nullResponse.bodyUsed);
var streamResponse = new Response(ReadableStream.from([
    new Uint8Array([65]),
    new Uint8Array([66]),
]));
console.log("stream response:", await streamResponse.text());
try {
    new Response("bad", { status: 204 });
}
catch (error) {
    console.log("response null-body status:", error.name);
}
try {
    new Response(null, { status: 199 });
}
catch (error) {
    console.log("response status range:", error.name);
}
try {
    new Response(null, { status: -1e100 });
}
catch (error) {
    console.log("response negative status range:", error.name);
}
console.log("response status conversion:", new Response(null, { status: 65736 }).status);
var stringStatusInit = { status: "201" };
console.log("response string status conversion:", new Response(null, stringStatusInit).status);
var responseConversionOrder = [];
var coercibleResponseBody = {
    toString: function () {
        responseConversionOrder.push("body");
        return "ordered";
    },
};
var coercibleResponseInit = {
    status: {
        valueOf: function () {
            responseConversionOrder.push("status");
            return "202";
        },
    },
};
var coercionResponse = new Response(coercibleResponseBody, coercibleResponseInit);
console.log("response coercion order:", responseConversionOrder.join(","), coercionResponse.status, await coercionResponse.text());
var responseInitConversionOrder = [];
var orderedResponseBody = {
    toString: function () {
        responseInitConversionOrder.push("body");
        return "ordered metadata";
    },
};
var orderedResponseHeader = {
    toString: function () {
        responseInitConversionOrder.push("headers");
        return "value";
    },
};
var orderedResponseStatus = {
    valueOf: function () {
        responseInitConversionOrder.push("status");
        return 202;
    },
};
var orderedResponseStatusText = {
    toString: function () {
        responseInitConversionOrder.push("statusText");
        return "Ordered";
    },
};
var orderedResponseInit = JSON.parse("{}");
orderedResponseInit.headers = JSON.parse("{}");
orderedResponseInit.headers.x = orderedResponseHeader;
orderedResponseInit.status = orderedResponseStatus;
orderedResponseInit.statusText = orderedResponseStatusText;
new Response(orderedResponseBody, orderedResponseInit);
console.log("response init conversion order:", responseInitConversionOrder.join(","));
var deferredResponseInit = { status: 201, headers: { x: "before" } };
var deferredResponse = new Response(null, deferredResponseInit, 
// @ts-ignore WebIDL ignores surplus constructor arguments.
(function () {
    deferredResponseInit.status = 202;
    deferredResponseInit.headers.x = "after";
    return "ignored";
})());
console.log("response deferred init snapshot:", deferredResponse.status, deferredResponse.headers.get("x"));
var lockedResponseBody = new ReadableStream();
void lockedResponseBody.getReader();
try {
    new Response(lockedResponseBody, {
        headers: { "bad name": "x" },
        status: 199,
        statusText: "bad\ntext",
    });
}
catch (error) {
    console.log("response locked body precedence:", error.name, error.message);
}
var lockedHeaderConversionBody = new ReadableStream();
void lockedHeaderConversionBody.getReader();
var throwingResponseHeader = {
    toString: function () {
        throw new Error("response header conversion");
    },
};
var throwingResponseHeaderInit = JSON.parse("{}");
throwingResponseHeaderInit.headers = JSON.parse("{}");
throwingResponseHeaderInit.headers.x = throwingResponseHeader;
try {
    new Response(lockedHeaderConversionBody, throwingResponseHeaderInit);
}
catch (error) {
    console.log("response header conversion precedence:", error.name, error.message);
}
try {
    new Response(null, {
        headers: { "bad name": "x" },
        status: 199,
        statusText: "bad\ntext",
    });
}
catch (error) {
    console.log("response status precedence:", error.name);
}
try {
    new Response(null, {
        headers: { "bad name": "x" },
        statusText: "bad\ntext",
    });
}
catch (error) {
    console.log("response status text precedence:", error.message);
}
try {
    new Response(null, { statusText: "bad\ntext" });
}
catch (error) {
    console.log("response status text:", error.name);
}
var res = await fetch("".concat(process.argv[2], "/json"));
console.log(await res.json());
var bracketJson = (await (await fetch("".concat(process.argv[2], "/json")))["json"]());
console.log("bracket json:", bracketJson.n);
console.log("bracket text:", await (await fetch("".concat(process.argv[2], "/text")))["text"]());
var bracketBytes = await (await fetch("".concat(process.argv[2], "/text")))["bytes"]();
console.log("bracket bytes:", bracketBytes.length, bracketBytes[0]);
function readTextLater(response) {
    return response.text();
}
var pendingText = readTextLater(await fetch("".concat(process.argv[2], "/text")));
console.log("stored text promise:", await pendingText);
var pendingBytes = (await fetch("".concat(process.argv[2], "/text"))).bytes();
var storedBytes = await pendingBytes;
console.log("stored bytes promise:", storedBytes.length, storedBytes[0]);
function readComputedBody(response, asBytes) {
    return __awaiter(this, void 0, void 0, function () {
        var member, value;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    member = asBytes ? "bytes" : "text";
                    return [4 /*yield*/, response[member]()];
                case 1:
                    value = _a.sent();
                    return [2 /*return*/, typeof value === "string"
                            ? "text:".concat(value)
                            : "bytes:".concat(value.length, ":").concat(value[0])];
            }
        });
    });
}
console.log("computed response body:", await readComputedBody(await fetch("".concat(process.argv[2], "/text")), false), await readComputedBody(await fetch("".concat(process.argv[2], "/text")), true));
var arityHeaders = (await fetch("".concat(process.argv[2], "/text"))).headers;
try {
    arityHeaders.get();
}
catch (error) {
    console.log("headers get arity:", error.name);
}
try {
    arityHeaders.has();
}
catch (error) {
    console.log("headers has arity:", error.name);
}
var extraArgResponse = await fetch("".concat(process.argv[2], "/text"));
console.log("response text extra arg:", await extraArgResponse.text("ignored"));
var gzipText = await (await fetch("".concat(process.argv[2], "/gzip"))).text();
console.log("gzip:", gzipText.length, gzipText.startsWith("compressed héllo 😀"), gzipText.endsWith(" "));
console.log("deflate:", await (await fetch("".concat(process.argv[2], "/deflate"))).text());
console.log("concatenated gzip:", await (await fetch("".concat(process.argv[2], "/gzip-concat"))).text());
console.log("truncated gzip:", JSON.stringify(await (await fetch("".concat(process.argv[2], "/gzip-truncated"))).text()));
var urlResponse = await fetch(new URL("".concat(process.argv[2], "/json")));
console.log("url:", urlResponse.status);
var headerResponse = await fetch("".concat(process.argv[2], "/header-echo"), {
    headers: { "x-echo-one": "1", "x-echo-two": "2" },
});
var responseHeaders = headerResponse.headers;
console.log("headers:", responseHeaders.get("content-type"), responseHeaders.get("x-multi"), responseHeaders.get("x-latin"), (_a = responseHeaders.get("missing")) !== null && _a !== void 0 ? _a : "none", responseHeaders.has("x-multi"), responseHeaders.has("missing"), responseHeaders.getSetCookie().join("|"));
responseHeaders.forEach(function (value, name) {
    if (name.startsWith("x-"))
        console.log("header walk:", name, value);
});
responseHeaders.forEach(function (value, name) {
    if (name === "x-kind")
        console.log("header walk thisArg:", name, value);
}, { label: "ignored by the arrow callback" });
try {
    var computedHeaderMember = function () { return "missing"; };
    var member = computedHeaderMember();
    responseHeaders[member]("x-kind");
    console.log("computed header member unexpectedly accepted");
}
catch (error) {
    console.log("computed header member:", error.name);
}
await headerResponse.text();
var latin1HeaderResponse = await fetch("".concat(process.argv[2], "/header-echo"), {
    headers: { "x-echo-one": "é", "x-echo-two": "latin1" },
});
console.log("latin1 request header:", await latin1HeaderResponse.text());
var coercedRecordHeaders = {
    "x-echo-one": 123,
    "x-echo-two": false,
};
console.log("coerced record headers:", await (await fetch("".concat(process.argv[2], "/header-echo"), {
    headers: coercedRecordHeaders,
})).text());
var coercedSequenceHeaders = [
    ["x-echo-one", 456],
    ["x-echo-two", true],
];
console.log("coerced sequence headers:", await (await fetch("".concat(process.argv[2], "/header-echo"), {
    headers: coercedSequenceHeaders,
})).text());
try {
    await fetch("".concat(process.argv[2], "/header-echo"), {
        headers: { "x-echo-one": "😀" },
    });
    console.log("wide request header unexpectedly sent");
}
catch (error) {
    var caught_1 = error;
    console.log("wide request header:", caught_1.name);
}
var emptyHeaderResponse = await fetch("".concat(process.argv[2], "/header-empty"));
console.log("empty duplicate header:", JSON.stringify(emptyHeaderResponse.headers["get"]("x-empty")));
await emptyHeaderResponse.text();
var headersSource = await fetch("".concat(process.argv[2], "/headers-source"));
var reusedHeaders = await fetch("".concat(process.argv[2], "/headers-reuse"), {
    headers: headersSource.headers,
});
console.log("reused headers:", await reusedHeaders.text());
console.log("normalized request headers:", await (await fetch("".concat(process.argv[2], "/header-init-echo"), {
    headers: [
        ["X-Duplicate", " one "],
        ["x-duplicate", "\ttwo\t"],
        ["Cookie", "a=1"],
        ["cookie", "b=2"],
    ],
})).json());
try {
    await fetch("".concat(process.argv[2], "/text"), {
        headers: [
            ["connection", "close"],
            ["Connection", "keep-alive"],
        ],
    });
    console.log("duplicate connection unexpectedly sent");
}
catch (error) {
    var caught_2 = error;
    console.log("duplicate connection:", caught_2.name, caught_2.message);
}
console.log("request defaults:", await (await fetch("".concat(process.argv[2], "/request-defaults"))).json());
var forcedFetchMode = (await (await fetch("".concat(process.argv[2], "/request-defaults"), {
    headers: { "sec-fetch-mode": "navigate" },
})).json());
console.log("forced sec-fetch-mode:", forcedFetchMode.secFetchMode);
var forcedHost = (await (await fetch("".concat(process.argv[2], "/request-defaults"), {
    headers: { host: "custom.invalid" },
})).json());
console.log("transport-controlled host:", forcedHost.host === new URL(process.argv[2]).host);
console.log("raw request headers:", await (await fetch("".concat(process.argv[2], "/raw-headers"))).text());
var forbiddenRequestHeaders = [
    ["connection", { connection: "x" }],
    ["transfer-encoding", { "transfer-encoding": "chunked" }],
    ["keep-alive", { "keep-alive": "timeout=5" }],
    ["upgrade", { upgrade: "websocket" }],
    ["expect", { expect: "100-continue" }],
];
for (var _i = 0, forbiddenRequestHeaders_1 = forbiddenRequestHeaders; _i < forbiddenRequestHeaders_1.length; _i++) {
    var _d = forbiddenRequestHeaders_1[_i], name_1 = _d[0], headers_1 = _d[1];
    try {
        await fetch("".concat(process.argv[2], "/text"), { headers: headers_1 });
        console.log("forbidden request header unexpectedly sent:", name_1);
    }
    catch (error) {
        var caught_3 = error;
        console.log("forbidden request header:", name_1, caught_3.name, caught_3.message);
    }
}
var init = {
    method: "POST",
    headers: {
        "content-type": "application/json",
        "x-user-tag": "static",
    },
    body: JSON.stringify({ q: 7 }),
};
var echoed = await fetch("".concat(process.argv[2], "/post-echo"), init);
console.log(await echoed.json());
var scalarBodyInit = JSON.parse('{"method":"POST","body":123}');
var scalarBodyEcho = await (await fetch("".concat(process.argv[2], "/post-echo"), scalarBodyInit)).json();
console.log("coerced scalar body:", scalarBodyEcho.method, scalarBodyEcho.contentType, scalarBodyEcho.body);
var scalarMethodInit = JSON.parse('{"method":null}');
var scalarMethodEcho = await (await fetch("".concat(process.argv[2], "/post-echo"), scalarMethodInit)).json();
console.log("coerced scalar method:", scalarMethodEcho.method);
// A runtime-computed dictionary cannot be source-profiled, so the native
// RequestInit validator remains the defensive backstop for unsupported keys.
var unsupportedInit = JSON.parse('{"method":"GET","integrity":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}');
try {
    await fetch("".concat(process.argv[2], "/text"), unsupportedInit);
    console.log("unsupported request init unexpectedly accepted");
}
catch (error) {
    var caught_4 = error;
    console.log("unsupported request init:", caught_4.name, caught_4.message);
}
var unsupportedThenUndefined = { cache: "no-store" };
var overwrittenUnsupportedInit = __assign(__assign({}, unsupportedThenUndefined), { cache: undefined });
var overwrittenUnsupported = await fetch("".concat(process.argv[2], "/text"), overwrittenUnsupportedInit);
console.log("overwritten unsupported request init:", await overwrittenUnsupported.text());
var matchedLength = await fetch("".concat(process.argv[2], "/post-echo"), {
    method: "POST",
    headers: { "content-length": "2" },
    body: "hi",
});
console.log("matched fixed content-length:", await matchedLength.json());
var redirected = await fetch("".concat(process.argv[2], "/redirect"));
console.log("redirect:", redirected.status, redirected.redirected, redirected.url.endsWith("/text"), await redirected.text());
var backslashRedirect = await fetch("".concat(process.argv[2], "/redirect-backslash"));
console.log("backslash redirect:", backslashRedirect.status, backslashRedirect.url.endsWith("/text"), await backslashRedirect.text());
var sameSchemeRedirect = await fetch("".concat(process.argv[2], "/redirect-same-scheme/dir/start"));
console.log("same-scheme redirect:", sameSchemeRedirect.status, sameSchemeRedirect.url.endsWith("/redirect-same-scheme/dir/next"), await sameSchemeRedirect.text());
var invalidUtf8Redirect = await fetch("".concat(process.argv[2], "/redirect-invalid-utf8"));
console.log("invalid utf8 redirect:", invalidUtf8Redirect.url.endsWith("/caf%EF%BF%BD"), await invalidUtf8Redirect.text());
var fragmentRedirect = await fetch("".concat(process.argv[2], "/redirect-fragment/path"), {
    headers: {
        "x-redirect-key": (_b = process.argv[3]) !== null && _b !== void 0 ? _b : "static-fragment",
    },
});
console.log("fragment redirect:", fragmentRedirect.status, fragmentRedirect.url.endsWith("/redirect-fragment/path"), await fragmentRedirect.text());
var manualRedirect = await fetch("".concat(process.argv[2], "/redirect"), {
    redirect: "manual",
});
console.log("manual redirect:", manualRedirect.status, manualRedirect.redirected, manualRedirect.url.endsWith("/redirect"), manualRedirect.headers.get("location"), JSON.stringify(await manualRedirect.text()));
try {
    await fetch("".concat(process.argv[2], "/redirect"), { redirect: "error" });
}
catch (error) {
    var caught_5 = error;
    console.log("error redirect:", caught_5.name, caught_5.message);
}
try {
    await fetch("".concat(process.argv[2], "/redirect-credentials"));
}
catch (error) {
    var caught_6 = error;
    console.log("credential redirect:", caught_6.name, caught_6.message);
}
try {
    var credentialUrl = "http://user:pass@".concat(process.argv[2].slice("http://".length), "/text");
    await fetch(credentialUrl);
}
catch (error) {
    var caught_7 = error;
    console.log("credential URL:", caught_7.name, caught_7.message);
}
console.log("early hints:", await (await fetch("".concat(process.argv[2], "/early-hints"))).text());
try {
    await fetch("".concat(process.argv[2], "/switching-protocols"));
    console.log("switching protocols unexpectedly resolved");
}
catch (error) {
    var caught_8 = error;
    console.log("switching protocols:", caught_8.name, caught_8.message);
}
console.log("invalid utf8:", JSON.stringify(await (await fetch("".concat(process.argv[2], "/invalid-utf8"))).text()));
var statusMeta = await fetch("".concat(process.argv[2], "/status-meta"));
console.log("status text:", statusMeta.status, statusMeta.statusText);
var head = await fetch("".concat(process.argv[2], "/text"), { method: "HEAD" });
console.log("head body:", head.body === null, head.bodyUsed, JSON.stringify(await head.text()), head.bodyUsed, JSON.stringify(await head.text()));
var noContent = await fetch("".concat(process.argv[2], "/no-content"));
try {
    await noContent.json();
}
catch (error) {
    var caught_9 = error;
    console.log("no-content json:", caught_9.name, caught_9.message, noContent.bodyUsed);
}
console.log("no-content body:", noContent.body === null, noContent.bodyUsed, JSON.stringify(await noContent.text()), noContent.bodyUsed);
var resetContent = await fetch("".concat(process.argv[2], "/reset-content"));
console.log("reset-content body:", resetContent.body === null, JSON.stringify(await resetContent.text()));
var largeResetContent = await fetch("".concat(process.argv[2], "/reset-content-large"));
console.log("large reset-content body:", largeResetContent.body === null, JSON.stringify(await largeResetContent.text()));
try {
    await fetch("".concat(process.argv[2], "/json"), { method: "BAD METHOD" });
}
catch (error) {
    console.log("invalid-method:", error.name);
}
try {
    await fetch("not a url", {
        signal: AbortSignal.abort(new Error("must not mask URL validation")),
    });
}
catch (error) {
    console.log("aborted invalid-url:", error.name);
}
try {
    await fetch("".concat(process.argv[2], "/text"), { method: "TRACE" });
}
catch (error) {
    var caught_10 = error;
    console.log("forbidden-method:", caught_10.name, caught_10.message);
}
try {
    await fetch("".concat(process.argv[2], "/post-echo"), {
        method: "POST",
        headers: { "content-length": "5" },
        body: "hi",
        signal: AbortSignal.timeout(200),
    });
}
catch (error) {
    var caught_11 = error;
    console.log("fixed content-length mismatch:", caught_11.name, caught_11.message);
}
export {};
