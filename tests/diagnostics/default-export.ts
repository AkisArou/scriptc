// The residual default-export fence: default-exporting a MUTABLE binding.
// Node's `export default x` snapshots the value when the export statement
// runs (later writes to x are invisible to importers), and the alias-based
// lowering would read the live binding — so the mutable form fences by
// name instead of diverging silently. Const/function/class defaults (and
// expression defaults) compile — the 188x corpus programs pin them.
let counter = 0;
export default counter;
counter = 1;
