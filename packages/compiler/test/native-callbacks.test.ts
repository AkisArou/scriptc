/* The one number the LLVM backend cannot derive and the C backend never needs.
 *
 * A queued invocation is a flat literal type in LLVM IR, so the runtime's
 * `ScrCallbackInvocation` header has to be counted out in pointer-sized fields
 * and every payload index counted from the end of it. The C backend names the
 * struct instead and lets the C compiler place what follows, so it is immune
 * to the number being wrong.
 *
 * That asymmetry is the hazard. Adding a field to either runtime struct is an
 * ordinary change that leaves C correct and moves every LLVM payload index by
 * one — reading a string out of what is now the token slot, which is a
 * type-confused load that no diagnostic would report. Nothing connected the
 * constant to the header, so this test does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { NATIVE_CALLBACK_INVOCATION_BASE_FIELDS } from "../src/backend/native-callbacks.js";

const header = readFileSync(
  fileURLToPath(new URL("../../runtime/src/scr_runtime.h", import.meta.url)),
  "utf8",
);

/** The declarations inside one `struct NAME { ... };`, comments removed. */
function structMembers(name: string): string[] {
  const start = header.indexOf(`struct ${name} {`);
  expect(start, `${name} is not declared in the runtime header`).toBeGreaterThan(-1);
  const open = header.indexOf("{", start);
  const close = header.indexOf("};", open);
  return header
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .split(";")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

test("the invocation base is the field count the LLVM backend assumes", () => {
  /* Every member of both structs is pointer-sized: three intrusive queue and
   * callback pointers, then the compiler-emitted signature, the invoke thunk,
   * the payload destructor, and the runtime-private token. If one ever is not
   * — an int, a flag, anything packed — this count stops describing the layout
   * and the assertion below is the wrong shape rather than merely off by one.
   * That is worth failing on too. */
  const event = structMembers("ScrOwnerGatewayEvent");
  const invocation = structMembers("ScrCallbackInvocation");

  expect(event).toHaveLength(3);
  /* The nested event plus this struct's own four. */
  expect(invocation).toHaveLength(5);
  expect(invocation[0]).toContain("ScrOwnerGatewayEvent");

  const pointerFields = event.length + (invocation.length - 1);
  expect(pointerFields).toBe(NATIVE_CALLBACK_INVOCATION_BASE_FIELDS);

  for (const member of [...event, ...invocation.slice(1)]) {
    expect(
      member.includes("*") || member.includes("Fn"),
      `${member} is not pointer-sized, so the flat LLVM layout no longer holds`,
    ).toBe(true);
  }
});
