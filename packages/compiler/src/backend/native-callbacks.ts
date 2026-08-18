import type {
  IrFfiImport,
  IrNativeScalarType,
  IrType,
  IrNativeBinding,
  IrNativeCallbackArgumentType,
  IrNativeCallbackContract,
  IrNativeCallbackType,
} from "../ir/nodes.js";
import { nativeCallbackIsOwnerScoped, nativeCallbackSourceScriptType } from "../ir/nodes.js";

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
  /** The process-global slot a contextless process-scoped registration is
   * dispatched through, since there is no userdata to carry the closure and
   * no call whose extent a thread-local could borrow. Replaceable: setting a
   * second registration supersedes the first. */
  readonly global: string | null;
  /** Whether this registration posts to the PROCESS transport: raised by a
   * thread the script does not own, and owned by nothing, so there is no
   * owner whose loop could carry it. An owner-scoped registration a foreign
   * thread may raise is queued too, but through the owner's gateway — the
   * two are different transports, and only one of them is this one. */
  readonly foreign: boolean;
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
      let global: string | null;
      do {
        const index = suffix++;
        symbol = `sc_native_cb_${index}`;
        global = processScoped && !takesContext ? `sc_native_cb_slot_${index}` : null;
      } while (
        reserved.has(symbol) || (global !== null && reserved.has(global))
      );
      reserved.add(symbol);
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
          global,
          foreign: processScoped &&
            (contract.allowedInvocationExecutors as readonly string[])
              .includes("any-attached-thread"),
        },
      );
    }
  }

  return adapters;
}

/**
 * How one source argument becomes the value a handler receives.
 *
 * This is the DECISION — widen or pass through, compare or decode, one slot
 * or two — stated once. Each backend materializes it with its own primitives
 * and nothing else: the C emitter writes a cast, the LLVM emitter writes an
 * `sitofp`, and neither gets to disagree about which is called for.
 *
 * The two backends previously made these choices independently, in switches
 * that had to be edited together and were kept so by a comment. They drifted
 * anyway — an f64 payload over an f64 slot asked LLVM for a widened value it
 * had never produced, unreachable until a foreign registration carried one —
 * which is the argument for putting the choice in one place rather than
 * asking two places to agree.
 */
export type NativeCallbackPayload =
  /** The physical slot IS the script value, which `scriptType` names so a
   * backend does not re-derive it and risk disagreeing. */
  | {
      readonly kind: "direct";
      readonly slot: number;
      readonly scriptType: IrType;
    }
  /** An at-most-32-bit integer or an f32 read as an ordinary number. Exact,
   * and never emitted over an f64 slot, where there is nothing to widen. */
  | {
      readonly kind: "widenedNumber";
      readonly slot: number;
      readonly physical: IrNativeScalarType;
    }
  /** An integer slot read as a boolean: false is exactly the declared value. */
  | {
      readonly kind: "boolean";
      readonly slot: number;
      readonly falseValue: string;
      readonly physical: IrNativeScalarType;
    }
  /** A NUL-terminated pointer, trapped when null and decoded lossily. */
  | { readonly kind: "cstring"; readonly slot: number }
  /** A pointer and a count. `text` decodes; otherwise the bytes are copied. */
  | {
      readonly kind: "span";
      readonly data: number;
      readonly length: number;
      readonly text: boolean;
    }
  /** A handle the emitter already referenced, with the binding that gives
   * that reference back whether the delivery runs or is dropped. */
  | {
      readonly kind: "ownedHandle";
      readonly slot: number;
      readonly typeId: string;
      readonly free: string;
      readonly scriptType: IrType;
    }
  /** The registration's owner, injected rather than read from a slot. */
  | { readonly kind: "registrationOwner" };

/** The payload plan for one adapter, in handler-parameter order.
 *
 * `resolveDestructor` maps a binding id to the C symbol that releases the
 * handle, which is the one fact this module cannot derive on its own. */
export function nativeCallbackPayloads(
  adapter: NativeCallbackAdapter,
  resolveDestructor: (bindingId: string) => string,
): readonly NativeCallbackPayload[] {
  const physical = adapter.callback.signature.parameters;
  return adapter.contract.sourceArguments.map((argument, sourceIndex) => {
    if (argument.kind === "registration-owner") return { kind: "registrationOwner" };
    const source = adapter.source.params[sourceIndex];
    if (source === undefined) {
      throw new Error(`backend bug: source argument ${sourceIndex} has no payload form`);
    }
    if (argument.kind === "callback-parameter-span") {
      return {
        kind: "span",
        data: argument.data,
        length: argument.length,
        text: source.kind !== "byteSpan",
      };
    }
    const slot = argument.parameter;
    if (source.kind === "cstring") return { kind: "cstring", slot };
    if (source.kind === "nativeHandle" && argument.destructor !== undefined) {
      return {
        kind: "ownedHandle",
        slot,
        typeId: source.typeId,
        free: resolveDestructor(argument.destructor),
        scriptType: nativeCallbackSourceScriptType(source),
      };
    }
    const carrier = physical[slot];
    if (source.kind === "bool") {
      if (carrier?.kind !== "nativeScalar") {
        throw new Error("backend bug: a boolean payload needs a scalar slot");
      }
      return { kind: "boolean", slot, falseValue: source.falseValue, physical: carrier };
    }
    /* Widening is what the SLOT calls for, not what the source form says: an
     * f64 read out of an f64 slot is already the value the handler wants, and
     * naming a widened form there names a value nothing produced. */
    if (
      source.kind === "f64" && carrier?.kind === "nativeScalar" &&
      carrier.scalar !== "f64"
    ) {
      return { kind: "widenedNumber", slot, physical: carrier };
    }
    return { kind: "direct", slot, scriptType: nativeCallbackSourceScriptType(source) };
  });
}
