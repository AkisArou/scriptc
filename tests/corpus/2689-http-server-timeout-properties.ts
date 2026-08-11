// The five writable numeric http.Server timeout fields: Node 24 defaults,
// independent per-server storage, constructor initialization, optional and
// dynamic access, and static reads/writes through a typed helper. Timer
// enforcement is a separate server behavior surface.
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
const fromOption = createServer({ keepAliveTimeoutBuffer: 4321 });

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

console.log("option", fromOption.keepAliveTimeoutBuffer);

function logOptional(server: Server | undefined): void {
  console.log("optional", server?.keepAliveTimeoutBuffer);
}
logOptional(fromOption);
logOptional(undefined);

const dynamic: any = fromOption;
console.log("dynamic", dynamic.keepAliveTimeoutBuffer);
dynamic.keepAliveTimeoutBuffer = 8765;
console.log("dynamic-set", dynamic.keepAliveTimeoutBuffer, fromOption.keepAliveTimeoutBuffer);

try {
  createServer({ keepAliveTimeoutBuffer: -1 });
} catch (err) {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    console.log(err.name, code, err.message);
  }
}
