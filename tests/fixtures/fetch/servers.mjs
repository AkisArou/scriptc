/* The fetch fixtures' local HTTP servers — the routes fetch.test.ts always
 * ran in-process, extracted so the Linux lane can run the IDENTICAL routes
 * inside its container (linux-differential.test.ts). Two entry forms, one
 * behavior:
 *
 * - module: `startFetchServers()` binds all three legs on 127.0.0.1 and
 *   resolves { baseUrl, refusedUrl, proxyUrl, proxiedRequests(), close() }
 *   (fetch.test.ts's in-process use).
 * - standalone: `node servers.mjs` starts the same legs and prints
 *   `BASE <url>` / `REFUSED <url>` / `PROXY <url>` on stderr (the PORT
 *   protocol's channel — never a compared stream), then serves until
 *   killed. The proxied-request COUNT is queryable over the wire in this
 *   form: a plain `GET /__count` to the proxy (a relative-path request no
 *   real proxy client sends) answers the current count.
 *
 * Routes: /text /json /post-echo /header-echo /request-defaults /redirect
 * /early-hints /invalid-utf8 /slow /drip /chunked /gzip /deflate
 * /status-meta /no-content /sse, 404 for the rest;
 * the proxy relays absolute-URI requests and CONNECT tunnels, counting one
 * per proxied request either way. */
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

export async function startFetchServers() {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (url === "/text") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-kind": "greeting" });
        res.end("héllo wörld 😀");
      } else if (url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ n: 42, s: "wide é", arr: [1, "two"] }));
      } else if (url === "/post-echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers["content-type"] ?? null,
            contentLength: req.headers["content-length"] ?? null,
            body: body.toString("utf8"),
          }),
        );
      } else if (url === "/header-echo") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "x-multi": ["a", "b"],
          "set-cookie": ["first=1", "second=2"],
        });
        res.end(`one=${req.headers["x-echo-one"]} two=${req.headers["x-echo-two"]}`);
      } else if (url === "/request-defaults") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            accept: req.headers["accept"] ?? null,
            acceptLanguage: req.headers["accept-language"] ?? null,
            secFetchMode: req.headers["sec-fetch-mode"] ?? null,
            userAgent: req.headers["user-agent"] ?? null,
            acceptEncoding: req.headers["accept-encoding"] ?? null,
          }),
        );
      } else if (url === "/redirect") {
        res.writeHead(302, { location: "/text" });
        res.end();
      } else if (url === "/early-hints") {
        res.writeEarlyHints({
          link: "</style.css>; rel=preload; as=style",
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("final");
      } else if (url === "/invalid-utf8") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(Buffer.from([0x61, 0xc3, 0x28, 0x62]));
      } else if (url === "/slow") {
        // Answers after 1500ms: the abort/timeout cases cancel long before.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow done");
        }, 1500);
      } else if (url === "/drip") {
        // First chunk immediately, the rest after 3000ms: the mid-stream
        // abort case reads the first chunk and cancels during the gap.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first");
        setTimeout(() => {
          res.end("tail");
        }, 3000);
      } else if (url === "/chunked") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        // split a multibyte sequence ACROSS chunks: € is e2 82 ac
        const bytes = Buffer.from("first€second", "utf8");
        res.write(bytes.subarray(0, 6)); // "first" + e2
        setTimeout(() => {
          res.write(bytes.subarray(6, 8)); // 82 ac
          setTimeout(() => {
            res.end(bytes.subarray(8));
          }, 15);
        }, 15);
      } else if (url === "/gzip") {
        // gzip-encoded body, written in two chunks so decompression spans
        // arrivals: fetch must deliver the DECODED text on both lanes.
        const payload = gzipSync(Buffer.from("compressed héllo 😀 ".repeat(40), "utf8"));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip", "content-length": String(payload.length) });
        res.write(payload.subarray(0, Math.floor(payload.length / 2)));
        setTimeout(() => {
          res.end(payload.subarray(Math.floor(payload.length / 2)));
        }, 15);
      } else if (url === "/deflate") {
        // zlib-wrapped deflate (Node servers' `deflate` spelling).
        const payload = deflateSync(Buffer.from("deflated wörld", "utf8"));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "deflate" });
        res.end(payload);
      } else if (url === "/status-meta") {
        res.writeHead(206, "Custom Partial", { "content-type": "text/plain" });
        res.end("partial");
      } else if (url === "/no-content") {
        res.writeHead(204);
        res.end();
      } else if (url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          'data: {"type":"delta","text":"hé"}\n\n',
          'event: usage\nid: 7\ndata: {"tokens":3}\n\n',
          "data: multi\ndata: line 😀\n\n",
          "data: [DONE]\n\n",
        ];
        let i = 0;
        const tick = () => {
          if (i === frames.length) {
            res.end();
            return;
          }
          // split each frame mid-way so parsing must span chunk boundaries
          const buf = Buffer.from(frames[i], "utf8");
          const cut = Math.floor(buf.length / 2);
          res.write(buf.subarray(0, cut));
          setTimeout(() => {
            res.write(buf.subarray(cut));
            i++;
            setTimeout(tick, 10);
          }, 10);
        };
        tick();
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`not found: ${url}`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("no server address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // A port that was just bound and released: connecting to it refuses.
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const paddr = probe.address();
  if (paddr === null || typeof paddr !== "object") throw new Error("no probe address");
  const refusedUrl = `http://127.0.0.1:${paddr.port}`;
  await new Promise((resolve) => probe.close(() => resolve()));

  // The forward proxy, both wire forms: absolute-URI requests (curl's
  // http_proxy shape for http:// targets) relay through http.request, and
  // CONNECT tunnels (undici's ProxyAgent shape — it tunnels even plain
  // http) splice raw sockets. One count per proxied request either way.
  let proxiedRequests = 0;
  const proxy = createServer((req, res) => {
    // Relative-path requests are never proxy traffic — the standalone
    // form's count query rides one; anything else relative is a 404.
    if ((req.url ?? "").startsWith("/")) {
      if (req.url === "/__count") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(proxiedRequests));
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    proxiedRequests++;
    const target = new URL(req.url ?? "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && k !== "proxy-connection" && k !== "connection") headers[k] = v;
      }
      const upstream = request(
        { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
        (ures) => {
          res.writeHead(ures.statusCode ?? 502, ures.headers);
          ures.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end("proxy error");
      });
      upstream.end(Buffer.concat(chunks));
    });
  });
  proxy.on("connect", (req, clientSocket, head) => {
    proxiedRequests++;
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = connect(Number(portStr ?? "80"), host ?? "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const pxaddr = proxy.address();
  if (pxaddr === null || typeof pxaddr !== "object") throw new Error("no proxy address");
  const proxyUrl = `http://127.0.0.1:${pxaddr.port}`;

  return {
    baseUrl,
    refusedUrl,
    proxyUrl,
    proxiedRequests: () => proxiedRequests,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => proxy.close(() => resolve()));
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startFetchServers();
  process.stderr.write(`BASE ${s.baseUrl}\nREFUSED ${s.refusedUrl}\nPROXY ${s.proxyUrl}\n`);
  // Serve until killed (the lane owns the process's lifetime).
}
