// @dynamic
// Canceling ReadableStream.from() before its first pull does not start or
// close the source iterator. Byte-exact against the pinned Node runtime.
import { immediateCancelIterable } from "stream-from-cancel-probe";

await ReadableStream.from(immediateCancelIterable() as any).cancel("why");
console.log("immediate cancel done");
