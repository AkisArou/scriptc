/**
 * The engine-free fetch/Web-platform compatibility contract.
 *
 * Keep this data-only: lowering, the shipped surface manifest, and the
 * differential conformance generator all consume the same profile. A Node
 * upgrade is deliberate because Node's bundled Undici version is observable
 * in coercion, error, stream, and transport behavior.
 */

export type FetchCompatFacet =
  | "argument-evaluation"
  | "body-consumption"
  | "callback-order"
  | "callback-this"
  | "error-shape"
  | "identity"
  | "liveness"
  | "missing-arguments"
  | "mutation"
  | "promise-settlement"
  | "property-read"
  | "state-machine"
  | "surplus-arguments"
  | "transport"
  | "webidl-conversion";

export interface FetchCompatEvidence {
  /** Stable scenario id interpreted by the generated differential harness. */
  generated?: string;
  /** Fixture directory below tests/fixtures/fetch. */
  fixture?: string;
}

export interface FetchCompatOperation {
  id: string;
  name: string;
  kind: "constructor" | "function" | "method" | "property" | "static-method";
  facets: readonly FetchCompatFacet[];
  evidence: readonly FetchCompatEvidence[];
}

export interface FetchCompatOption {
  id: string;
  name: string;
  conversion: string;
  evidence: readonly FetchCompatEvidence[];
}

export interface FetchCompatProfile {
  schemaVersion: 1;
  target: {
    node: string;
    undici: string;
  };
  requestInit: readonly FetchCompatOption[];
  members: {
    responseReads: readonly string[];
    responseCalls: readonly string[];
    readableStreamReads: readonly string[];
    readableStreamCalls: readonly string[];
  };
  operations: readonly FetchCompatOperation[];
}

const generated = (scenario: string): FetchCompatEvidence => ({ generated: scenario });
const fixture = (name: string): FetchCompatEvidence => ({ fixture: name });

export const NODE24_FETCH_COMPAT_PROFILE = {
  schemaVersion: 1,
  target: {
    node: "24.15.0",
    undici: "7.24.4",
  },
  requestInit: [
    {
      id: "stdlib.fetch.request-init.method",
      name: "RequestInit.method",
      conversion: "WebIDL ByteString after all call arguments evaluate",
      evidence: [fixture("static-coercion")],
    },
    {
      id: "stdlib.fetch.request-init.headers",
      name: "RequestInit.headers",
      conversion: "Headers, record, or sequence-of-pairs snapshot",
      evidence: [fixture("static"), fixture("static-coercion")],
    },
    {
      id: "stdlib.fetch.request-init.body",
      name: "RequestInit.body",
      conversion: "string, Uint8Array, ReadableStream, or null",
      evidence: [fixture("static"), fixture("static-stream"), fixture("static-coercion")],
    },
    {
      id: "stdlib.fetch.request-init.duplex",
      name: "RequestInit.duplex",
      conversion: "WebIDL enum; 'half' required for streaming bodies",
      evidence: [fixture("static-stream"), fixture("static-coercion")],
    },
    {
      id: "stdlib.fetch.request-init.redirect",
      name: "RequestInit.redirect",
      conversion: "WebIDL enum: follow, error, or manual",
      evidence: [fixture("static"), fixture("static-coercion")],
    },
    {
      id: "stdlib.fetch.request-init.signal",
      name: "RequestInit.signal",
      conversion: "native AbortSignal handle or absent",
      evidence: [fixture("static"), fixture("static-abort-throw")],
    },
  ],
  members: {
    responseReads: [
      "ok",
      "status",
      "statusText",
      "url",
      "redirected",
      "headers",
      "body",
      "bodyUsed",
    ],
    responseCalls: ["json", "text", "bytes"],
    readableStreamReads: ["locked"],
    readableStreamCalls: ["cancel", "getReader"],
  },
  operations: [
    {
      id: "stdlib.fetch",
      name: "fetch",
      kind: "function",
      facets: [
        "argument-evaluation",
        "webidl-conversion",
        "surplus-arguments",
        "promise-settlement",
        "transport",
        "error-shape",
      ],
      evidence: [fixture("static"), fixture("static-coercion"), fixture("static-network-error")],
    },
    {
      id: "stdlib.abort-signal.abort",
      name: "AbortSignal.abort",
      kind: "static-method",
      facets: ["identity", "liveness", "surplus-arguments", "property-read"],
      evidence: [generated("webidl-operations"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.abort-signal.any",
      name: "AbortSignal.any",
      kind: "static-method",
      facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "property-read"],
      evidence: [generated("webidl-operations"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.abort-signal.timeout",
      name: "AbortSignal.timeout",
      kind: "static-method",
      facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "error-shape"],
      evidence: [generated("webidl-operations"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.abort-signal.aborted",
      name: "AbortSignal.aborted",
      kind: "property",
      facets: ["property-read"],
      evidence: [generated("webidl-operations")],
    },
    {
      id: "stdlib.abort-signal.reason",
      name: "AbortSignal.reason",
      kind: "property",
      facets: ["identity", "liveness", "property-read"],
      evidence: [generated("webidl-operations"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.abort-signal.onabort",
      name: "AbortSignal.onabort",
      kind: "property",
      facets: ["callback-order", "callback-this", "mutation", "property-read"],
      evidence: [generated("abort-events"), fixture("static-listener-this")],
    },
    {
      id: "stdlib.abort-signal.throw-if-aborted",
      name: "AbortSignal.throwIfAborted",
      kind: "method",
      facets: ["identity", "error-shape"],
      evidence: [generated("webidl-operations"), fixture("static-abort-throw")],
    },
    {
      id: "stdlib.abort-signal.add-event-listener",
      name: "AbortSignal.addEventListener",
      kind: "method",
      facets: ["webidl-conversion", "identity", "callback-order", "callback-this"],
      evidence: [generated("abort-events"), fixture("static-listener-this"), fixture("static-listener-noncallable")],
    },
    {
      id: "stdlib.abort-signal.remove-event-listener",
      name: "AbortSignal.removeEventListener",
      kind: "method",
      facets: ["webidl-conversion", "identity", "callback-order"],
      evidence: [generated("abort-events"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.abort-signal.dispatch-event",
      name: "AbortSignal.dispatchEvent",
      kind: "method",
      facets: ["callback-order", "callback-this", "error-shape"],
      evidence: [fixture("static-dispatch-throw")],
    },
    {
      id: "stdlib.readable-stream.constructor",
      name: "ReadableStream constructor",
      kind: "constructor",
      facets: ["webidl-conversion", "callback-this", "callback-order", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream-this")],
    },
    {
      id: "stdlib.readable-stream.from",
      name: "ReadableStream.from",
      kind: "static-method",
      facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "liveness"],
      evidence: [generated("webidl-operations"), generated("stream-traces")],
    },
    {
      id: "stdlib.readable-stream.locked",
      name: "ReadableStream.locked",
      kind: "property",
      facets: ["property-read", "state-machine"],
      evidence: [generated("stream-traces")],
    },
    {
      id: "stdlib.readable-stream.cancel",
      name: "ReadableStream.cancel",
      kind: "method",
      facets: ["identity", "promise-settlement", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream.get-reader",
      name: "ReadableStream.getReader",
      kind: "method",
      facets: ["webidl-conversion", "identity", "state-machine", "error-shape"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-reader.closed",
      name: "ReadableStreamDefaultReader.closed",
      kind: "property",
      facets: ["promise-settlement", "property-read", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-reader.read",
      name: "ReadableStreamDefaultReader.read",
      kind: "method",
      facets: ["identity", "promise-settlement", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-reader.cancel",
      name: "ReadableStreamDefaultReader.cancel",
      kind: "method",
      facets: ["identity", "promise-settlement", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-reader.release-lock",
      name: "ReadableStreamDefaultReader.releaseLock",
      kind: "method",
      facets: ["promise-settlement", "state-machine", "error-shape"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-controller.desired-size",
      name: "ReadableStreamDefaultController.desiredSize",
      kind: "property",
      facets: ["property-read", "state-machine"],
      evidence: [generated("stream-traces")],
    },
    {
      id: "stdlib.readable-stream-default-controller.enqueue",
      name: "ReadableStreamDefaultController.enqueue",
      kind: "method",
      facets: ["identity", "liveness", "state-machine", "error-shape"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-controller.close",
      name: "ReadableStreamDefaultController.close",
      kind: "method",
      facets: ["state-machine", "error-shape"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    {
      id: "stdlib.readable-stream-default-controller.error",
      name: "ReadableStreamDefaultController.error",
      kind: "method",
      facets: ["identity", "promise-settlement", "state-machine"],
      evidence: [generated("stream-traces"), fixture("static-stream")],
    },
    ...[
      "append",
      "delete",
      "get",
      "getSetCookie",
      "has",
      "set",
      "forEach",
    ].map((member): FetchCompatOperation => ({
      id: `stdlib.headers.${member}`,
      name: `Headers.${member}`,
      kind: "method",
      facets:
        member === "forEach"
          ? ["callback-order", "callback-this", "mutation"]
          : member === "get" || member === "has"
            ? ["webidl-conversion", "missing-arguments", "property-read"]
            : ["webidl-conversion", "mutation", "error-shape"],
      evidence: [fixture("static"), fixture("static-coercion")],
    })),
    ...[
      "ok",
      "status",
      "statusText",
      "url",
      "redirected",
      "headers",
      "body",
      "bodyUsed",
    ].map((member): FetchCompatOperation => ({
      id: `stdlib.response.${member}`,
      name: `Response.${member}`,
      kind: "property",
      facets: ["property-read"],
      evidence: [fixture("static")],
    })),
    ...["json", "text", "bytes"].map((member): FetchCompatOperation => ({
      id: `stdlib.response.${member}`,
      name: `Response.${member}`,
      kind: "method",
      facets: ["body-consumption", "promise-settlement", "state-machine", "error-shape"],
      evidence: [fixture("static"), fixture("static-stream")],
    })),
  ],
} satisfies FetchCompatProfile;

export const STATIC_REQUEST_INIT_KEYS = new Set(
  NODE24_FETCH_COMPAT_PROFILE.requestInit.map((entry) =>
    entry.id.slice("stdlib.fetch.request-init.".length)
  ),
);

export const STATIC_RESPONSE_READS = new Set(
  NODE24_FETCH_COMPAT_PROFILE.members.responseReads,
);

export const STATIC_RESPONSE_CALLS = new Set(
  NODE24_FETCH_COMPAT_PROFILE.members.responseCalls,
);

export const STATIC_READABLE_STREAM_READS = new Set(
  NODE24_FETCH_COMPAT_PROFILE.members.readableStreamReads,
);

export const STATIC_READABLE_STREAM_CALLS = new Set(
  NODE24_FETCH_COMPAT_PROFILE.members.readableStreamCalls,
);
