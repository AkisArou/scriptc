import type { IrFfiCallbackParam, IrFfiImport } from "../ir/nodes.js";
import { isFfiCallbackParam, isFfiContextParam } from "../ir/nodes.js";

export interface FfiCallbackAdapter {
  symbol: string;
  /** Raw callbacks have no ABI context parameter and borrow this TLS slot. */
  tls: string | null;
  callback: IrFfiCallbackParam["callback"];
}

/** Allocate internal callback symbols outside the manifest's external
 * symbol set. C and LLVM share this table so a valid native symbol can
 * never collide with a generated trampoline or raw-callback TLS slot. */
export function allocateFfiCallbackAdapters(
  imports: readonly IrFfiImport[],
): Map<string, FfiCallbackAdapter> {
  const reserved = new Set(imports.map((entry) => entry.symbol));
  const adapters = new Map<string, FfiCallbackAdapter>();
  let suffix = 0;

  for (const entry of imports) {
    for (const param of entry.params) {
      if (!isFfiCallbackParam(param)) continue;
      const hasContext = param.callback.params.some(isFfiContextParam);
      let symbol: string;
      let tls: string | null;
      do {
        const index = suffix++;
        symbol = `sc_ffi_cb_${index}`;
        tls = hasContext ? null : `sc_ffi_cb_ctx_${index}`;
      } while (reserved.has(symbol) || (tls !== null && reserved.has(tls)));
      reserved.add(symbol);
      if (tls !== null) reserved.add(tls);
      adapters.set(`${entry.name}:${param.callback.id}`, {
        symbol,
        tls,
        callback: param.callback,
      });
    }
  }

  return adapters;
}
