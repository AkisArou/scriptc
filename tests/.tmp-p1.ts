import * as net from "node:net";
const server = net.createServer((s) => { s.end("x"); });
server.listen(0, () => {
  const c = net.connect((server.address() as net.AddressInfo).port);
  c.on("data", () => {
    console.log("pause chains:", c.pause() === c);
    c.resume();
  });
  c.on("end", () => {
    console.log("bytesWritten:", c.bytesWritten, "readable:", c.readable);
    c.destroySoon();
  });
  c.on("close", () => { server.close(); });
});
