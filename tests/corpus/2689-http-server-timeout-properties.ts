// The five writable numeric http.Server timeout fields: Node 24 defaults,
// independent per-server storage, and static reads/writes through a typed
// helper. Timer enforcement is a separate server behavior surface.
import { createServer, Server } from "node:http";

function configure(server: Server): void {
  server.timeout = 125;
  server.keepAliveTimeout = 250;
  server.keepAliveTimeoutBuffer = 300;
  server.headersTimeout = 375;
  server.requestTimeout = 500;
}

const configured = createServer();
const untouched = new Server();

console.log(
  configured.timeout,
  configured.keepAliveTimeout,
  configured.keepAliveTimeoutBuffer,
  configured.headersTimeout,
  configured.requestTimeout,
);

configure(configured);
console.log(
  configured.timeout,
  configured.keepAliveTimeout,
  configured.keepAliveTimeoutBuffer,
  configured.headersTimeout,
  configured.requestTimeout,
);
console.log(
  untouched.timeout,
  untouched.keepAliveTimeout,
  untouched.keepAliveTimeoutBuffer,
  untouched.headersTimeout,
  untouched.requestTimeout,
);
