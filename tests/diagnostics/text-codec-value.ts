const encoder = new TextEncoder();
console.log(encoder);

function encodeCaptured(s: string): Uint8Array {
  return sharedEncoder.encode(s);
}
const sharedEncoder = new TextEncoder();
console.log(encodeCaptured("x").length);
