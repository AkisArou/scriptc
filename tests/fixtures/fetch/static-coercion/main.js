function methodToString() {
  return this.expected;
}

const method = { expected: "POST", toString: methodToString };
const methodResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method,
  body: "method receiver",
});
const methodResult = await methodResponse.json();
console.log(
  "method coercion receiver:",
  methodResult.method,
  methodResult.body,
);

function bufferToString() {
  return Buffer.from("POST");
}

function bufferValueOf() {
  throw new Error("valueOf called");
}

try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: { toString: bufferToString, valueOf: bufferValueOf },
  });
  console.log("object coercion result unexpectedly accepted");
} catch (error) {
  console.log("object coercion result:", error.name, error.message);
}

function duplexToString() {
  return this.expected;
}

const duplex = { expected: "half", toString: duplexToString };
const duplexBody = ReadableStream.from([Buffer.from("duplex body")]);
const duplexResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: duplexBody,
  duplex,
});
const duplexResult = await duplexResponse.json();
console.log("duplex coercion:", duplexResult.method, duplexResult.body);

export {};
