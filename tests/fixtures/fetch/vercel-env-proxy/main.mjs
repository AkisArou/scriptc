"use strict";
// @dynamic
// Vercel installs this dispatcher when ordinary proxy environment variables
// are present, without requiring Node's global NODE_USE_ENV_PROXY opt-in.
import { EnvProxyDispatcher } from "vercel-env-proxy-dispatcher";
var response = await fetch("".concat(process.argv[2], "/text"), {
    dispatcher: new EnvProxyDispatcher(),
});
var body = await response.text();
console.log(body);
