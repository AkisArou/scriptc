const keepAlive = setInterval(() => {}, 1000);
const signal = AbortSignal.timeout(0);

signal.addEventListener("abort", { handleEvent: 1 });
console.log("registered non-callable abort listener");

signal.addEventListener("abort", () => {
  clearInterval(keepAlive);
  console.log("later abort listener");
});

export {};
