"use strict";
process.env.NODE_USE_ENV_PROXY = "1";
process.env.http_proxy = process.argv[3];
process.env.HTTP_PROXY = process.argv[3];
process.env.NODE_EXTRA_CA_CERTS = process.argv[5];
var direct = await fetch(process.argv[2]);
console.log("http: ".concat(await direct.text()));
try {
    var secure = await fetch(process.argv[4]);
    console.log("https: ".concat(await secure.text()));
}
catch (_a) {
    console.log("https: rejected");
}
export {};
