// @dynamic
// A dual package whose "module" ESM arm exposes a value only through a
// named re-export. Node loads the equivalent "main" CJS arm; scriptc
// deliberately prefers the ESM arm and must carry that format through its
// relative graph instead of synthesizing a CommonJS facade for the leaf.
import { VALUE } from "esm-named-reexport";

console.log(`VALUE = ${VALUE}`);
