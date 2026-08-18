import type {
  IrFfiImport,
  IrNativeBinding,
  IrNativeCallbackArgumentType,
  IrNativeCallbackContract,
  IrNativeCallbackType,
} from "../ir/nodes.js";
import { nativeCallbackIsOwnerScoped } from "../ir/nodes.js";

export interface NativeCallbackAdapter {
  readonly symbol: string;
  readonly bindingId: string;
  readonly argument: number;
  readonly callback: IrNativeCallbackType;
  readonly source: IrNativeCallbackArgumentType;
  readonly contract: IrNativeCallbackContract;
  /** The thread-local the closure is lent through, for a callback whose C
   * signature has no userdata slot to carry it. Null when the signature has
   * one, which is the ordinary case and needs no storage at all: the context
   * slot IS the closure pointer, so nesting and reentrancy cost nothing. */
  readonly tls: string | null;
  /** The counted registration ledger a process-scoped registration lives in,
   * and which a release names back. Null for every other owner: a call-scoped
   * callback has nothing to outlive the call, and an owner-scoped one is
   * pinned by the object that owns it. */
  readonly table: string | null;
  /** The process-global slot a contextless process-scoped registration is
   * dispatched through, since there is no userdata to carry the closure and
   * no call whose extent a thread-local could borrow. Replaceable: setting a
   * second registration supersedes the first. */
  readonly global: string | null;
}

export function nativeCallbackAdapterKey(bindingId: string, argument: number): string {
  return `${bindingId}\0${argument}`;
}

/** Logical handle argument cancelled by an explicit, non-consuming callback
 * cancellation binding. Owned destructor calls already run lifecycle teardown
 * inside ScrNativeHandle and are intentionally excluded. */
export function nativeCallbackCancellationArgument(
  bindings: readonly IrNativeBinding[],
  binding: IrNativeBinding,
): number | undefined {
  const cancellation = bindings.some((registration) =>
    registration.arguments.some((argument) =>
      argument.type.kind === "func" &&
      argument.callback !== undefined &&
      nativeCallbackIsOwnerScoped(argument.callback) &&
      argument.callback.cancellationBinding === binding.id
    )
  );
  if (
    !cancellation ||
    binding.parameters.some((parameter) => parameter.ownership.kind === "owned")
  ) return undefined;
  const argument = binding.arguments.findIndex(({ type }) => type.kind === "nativeHandle");
  return argument < 0 ? undefined : argument;
}

/** Allocate callback-trampoline symbols outside every external symbol set.
 * The logical callback argument is the stable identity: its function and
 * context projections necessarily share this one adapter. */
export function allocateNativeCallbackAdapters(
  bindings: readonly IrNativeBinding[],
  ffiImports: readonly IrFfiImport[],
): Map<string, NativeCallbackAdapter> {
  const reserved = new Set([
    ...bindings.map((binding) => binding.entry.symbol),
    ...ffiImports.map((entry) => entry.symbol),
  ]);
  const adapters = new Map<string, NativeCallbackAdapter>();
  let suffix = 0;

  for (const binding of bindings) {
    for (const parameter of binding.parameters) {
      if (
        parameter.projection.kind !== "callbackFunction" ||
        parameter.type.kind !== "nativeCallback"
      ) {
        continue;
      }
      const contractOf = binding.arguments[parameter.projection.argument]?.callback;
      const processScoped = contractOf?.owner.kind === "process";
      const takesContext = parameter.type.signature.parameters.some(
        (slot) => slot.kind === "nativeContext",
      );
      let symbol: string;
      let table: string | null;
      let global: string | null;
      do {
        const index = suffix++;
        symbol = `sc_native_cb_${index}`;
        table = processScoped ? `sc_native_cb_table_${index}` : null;
        global = processScoped && !takesContext ? `sc_native_cb_slot_${index}` : null;
      } while (
        reserved.has(symbol) ||
        (table !== null && reserved.has(table)) ||
        (global !== null && reserved.has(global))
      );
      reserved.add(symbol);
      if (table !== null) reserved.add(table);
      if (global !== null) reserved.add(global);
      const contract =
        binding.arguments[parameter.projection.argument]?.callback;
      const source = binding.arguments[parameter.projection.argument]?.type;
      if (contract === undefined) {
        throw new Error(
          `backend bug: native callback ${binding.id}:${parameter.projection.argument} has no contract`,
        );
      }
      if (source?.kind !== "func") {
        throw new Error(
          `backend bug: native callback ${binding.id}:${parameter.projection.argument} has no logical function type`,
        );
      }
      /* A signature with no context slot cannot be handed the closure. A
       * call-scoped one borrows a thread-local for the call's dynamic extent
       * — distinct per adapter, so two raw callbacks in one call cannot read
       * each other's — and a process-scoped one has no call to borrow, so it
       * dispatches through the replaceable global above instead. */
      adapters.set(
        nativeCallbackAdapterKey(binding.id, parameter.projection.argument),
        {
          symbol,
          bindingId: binding.id,
          argument: parameter.projection.argument,
          callback: parameter.type,
          source,
          contract,
          tls: takesContext || processScoped ? null : `${symbol}_closure`,
          table,
          global,
        },
      );
    }
  }

  return adapters;
}
