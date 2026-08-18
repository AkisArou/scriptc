import type {
  IrFfiImport,
  IrNativeBinding,
  IrNativeCallbackArgumentType,
  IrNativeCallbackContract,
  IrNativeCallbackType,
} from "../ir/nodes.js";
import { nativeCallbackIsRetained } from "../ir/nodes.js";

export interface NativeCallbackAdapter {
  readonly symbol: string;
  readonly bindingId: string;
  readonly argument: number;
  readonly callback: IrNativeCallbackType;
  readonly source: IrNativeCallbackArgumentType;
  readonly contract: IrNativeCallbackContract;
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
      nativeCallbackIsRetained(argument.callback) &&
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
      let symbol: string;
      do {
        symbol = `sc_native_cb_${suffix++}`;
      } while (reserved.has(symbol));
      reserved.add(symbol);
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
      adapters.set(
        nativeCallbackAdapterKey(binding.id, parameter.projection.argument),
        {
          symbol,
          bindingId: binding.id,
          argument: parameter.projection.argument,
          callback: parameter.type,
          source,
          contract,
        },
      );
    }
  }

  return adapters;
}
