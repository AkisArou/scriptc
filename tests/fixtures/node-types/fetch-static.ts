// The adopted @types/node/undici declarations must route the same native
// AbortSignal and readable Web Streams surface as the shipped fallback.
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from("typed stream"));
    controller.close();
  },
});

const init: RequestInit = {
  method: "POST",
  body,
  duplex: "half",
  signal: AbortSignal.timeout(100),
};

async function consume(url: string): Promise<number> {
  const response = await fetch(url, init);
  const reader = response.body!.getReader();
  const first = await reader.read();
  return first.done ? 0 : first.value.length;
}

void consume;
