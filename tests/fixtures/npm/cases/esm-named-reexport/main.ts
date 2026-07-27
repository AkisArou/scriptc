// @dynamic
// A dual package whose "module" ESM arm exposes a value only through a
// named re-export. Node loads the equivalent "main" CJS arm; scriptc
// deliberately prefers the ESM arm and must carry that format through its
// relative graph instead of synthesizing a CommonJS facade for the leaf,
// while preserving nested package.json and explicit-extension boundaries.
import { CJS_VALUE, EXPLICIT_VALUE, VALUE } from "esm-named-reexport";

console.log(`VALUE = ${VALUE}; CJS_VALUE = ${CJS_VALUE}; EXPLICIT_VALUE = ${EXPLICIT_VALUE}`);
