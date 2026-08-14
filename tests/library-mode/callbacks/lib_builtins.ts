// CB6 builtin-name collision fixture: profile channels may share names with
// declaration-file ambients without claiming those bindings. isNaN must keep
// its standard-library lowering; parseInt is unreferenced channel capacity and
// must not be validated against lib.d.ts's optional-radix signature.
export function checkBuiltin(x: number): boolean {
  return isNaN(x);
}
