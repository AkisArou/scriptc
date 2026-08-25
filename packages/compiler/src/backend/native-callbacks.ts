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
/** The union a nullable payload's handler receives, and which tag each arm
 * is. Resolved by the caller because a union's identity belongs to the module
 * being emitted, which this layer does not hold — the same division
 * `resolveDestructor` lives under. */
export interface NativeCallbackAbsentPayload {
  readonly unionId: string;
  readonly presentTag: number;
  readonly nullTag: number;
}

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
      /** Present when the emitter may hand the slot over as NULL, naming the
       * two-arm union the handler receives and which tag each arm is.
       *
       * The same field a nullable handle RESULT carries, spelled the same
       * way, because it is the same question in the other direction: a
       * pointer that may be absent becomes a value the program can test. What
       * differs is only who tests it — a call site there, a trampoline here.
       *
       * `null` means the payload is always an object, which is the only thing
       * a delivery could assume before this existed. */
      readonly absent: NativeCallbackAbsentPayload | null;
      /** When this capability is null, the physical payload is already
       * stable. Otherwise it is a frame-bounded resource that must either be
       * passed raw to a proven synchronous handler or promoted before
       * managed-cell construction. */
      readonly frameBounded: {
        readonly promote: string;
        readonly release: string;
      } | null;
      readonly resourceMode: "stable" | "frameBounded";
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
  resolveNullableUnion: (typeId: string) => NativeCallbackAbsentPayload,
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
    if (
      (source.kind === "nativeHandle" || source.kind === "nullableNativeHandle") &&
      argument.destructor !== undefined
    ) {
      const absent = source.kind === "nullableNativeHandle"
        ? resolveNullableUnion(source.typeId)
        : null;
      return {
        kind: "ownedHandle",
        slot,
        typeId: source.typeId,
        free: resolveDestructor(argument.destructor),
        scriptType: absent === null
          ? { kind: "nativeHandle", typeId: source.typeId }
          : { kind: "union", unionId: absent.unionId },
        absent,
        frameBounded: argument.frameBounded === undefined
          ? null
          : {
              promote: argument.frameBounded.promote.symbol,
              release: argument.frameBounded.release.symbol,
            },
        resourceMode: argument.resourceMode === "frameBounded"
          ? "frameBounded"
          : "stable",
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
    /* A payload that crosses as itself. A nullable handle reaches here only
     * when the contract names no destructor for it — a payload the handler
     * borrows rather than owns — and it still receives the union, because
     * what the handler is handed does not depend on who releases it. */
    return {
      kind: "direct",
      slot,
      scriptType: nativeCallbackSourceScriptType(
        source,
        (typeId) => resolveNullableUnion(typeId).unionId,
      ),
    };
  });
}

/** Where a trampoline finds the closure it must invoke.
 *
 * There are exactly five answers and they follow from the contract, not from
 * the backend: what owns the registration decides whether the library hands
 * back a closure or a token, and whether the signature has a userdata slot
 * decides whether it hands back anything at all. */
export type NativeClosureSource =
  /** The context slot IS the closure. A call-scoped callback, nothing else. */
  | { readonly kind: "context" }
  /** No userdata slot, and only this call's extent to survive: the closure is
   * lent through a thread-local for that extent. */
  | { readonly kind: "threadLocal"; readonly slot: string }
  /** The context is a lightweight lifecycle edge owned by the registration
   * result. This is sufficient when every invocation is synchronous on the
   * owner thread: no transport token or callback table is needed. */
  | { readonly kind: "ownerContext" }
  /** The context slot is the registration's token; the closure is read
   * through the table, which is what keeps it alive between calls. */
  | { readonly kind: "tokenContext" }
  /** No userdata slot and a life longer than the call, so the token lives in
   * a replaceable global instead of being handed over. */
  | { readonly kind: "tokenGlobal"; readonly slot: string };

/** Which trampoline a contract calls for.
 *
 * `call-scoped` invokes the closure directly and dies with the call.
 * `direct` reads the closure from its result-owned local context when the
 * contract proves owner-thread delivery, or through a token for a process
 * registration, and invokes it now.
 * `queued` copies the payload where the event is raised and delivers on a
 * later turn, because the raising thread may not be the script's. */
export type NativeTrampolineShape = "call-scoped" | "direct" | "queued";

export interface NativeTrampolineForm {
  readonly shape: NativeTrampolineShape;
  readonly closure: NativeClosureSource;
}

/** The shape and closure source for one adapter.
 *
 * Both backends selected their arm from the same two contract fields and read
 * the closure from the same two adapter fields, in code that had to agree and
 * twice did not: an arm guard narrowed on one side sent a process-scoped
 * registration into owner-side token machinery, and a slot emitted by a new
 * arm was emitted again by an old one. */
export function nativeTrampolineForm(
  adapter: NativeCallbackAdapter,
): NativeTrampolineForm {
  if (adapter.contract.owner.kind === "call") {
    return {
      shape: "call-scoped",
      closure: adapter.tls === null
        ? { kind: "context" }
        : { kind: "threadLocal", slot: adapter.tls },
    };
  }
  if (
    nativeCallbackIsOwnerScoped(adapter.contract) &&
    adapter.contract.synchronousReturn &&
    adapter.global === null
  ) {
    return { shape: "direct", closure: { kind: "ownerContext" } };
  }
  const closure: NativeClosureSource = adapter.global === null
    ? { kind: "tokenContext" }
    : { kind: "tokenGlobal", slot: adapter.global };
  return {
    shape: adapter.contract.synchronousReturn ? "direct" : "queued",
    closure,
  };
}

/** Work a native call must do before its arguments are converted, because it
 * must happen whether or not a conversion throws. */
export type NativeCallSetup =
  /** Register a callback a VALUE owns. Produces the token the library is
   * handed as context; `ownerArgument` names the handle that owns it, when
   * the contract injects one. */
  | {
      readonly kind: "registerOwned";
      readonly argument: number;
      readonly ownerArgument: number | null;
      /** A synchronous owner-thread registration can store its closure on
       * the result lifecycle directly instead of entering callback transport. */
      readonly direct: boolean;
    }
  /** Register a callback nothing owns, pinning it before the call so a
   * library that fires on subscribe already reaches a rooted closure. */
  | {
      readonly kind: "registerProcess";
      readonly argument: number;
      readonly foreign: boolean;
      /** A replaceable slot to arm, and only while it is empty: a setter may
       * flush the outgoing handler one last time mid-replace. */
      readonly armSlot: string | null;
    }
  /** Validate a release BEFORE the native call, so releasing a value that was
   * never registered traps before native code acts on the pointer pair. */
  | { readonly kind: "requireProcess"; readonly argument: number };

/** Work that must happen after every argument is converted but before the
 * call, so a conversion that throws cannot leave a slot armed. */
export interface NativeCallLend {
  readonly argument: number;
  readonly slot: string;
}

/** Work that must happen the moment the call returns. Order is the array's. */
export type NativeCallTeardown =
  | { readonly kind: "restoreClosure"; readonly argument: number; readonly slot: string }
  /** Repoint a replaceable slot at the registration that superseded it. */
  | { readonly kind: "commitSlot"; readonly argument: number; readonly slot: string }
  /** Unpin a released registration, after the library has had its last
   * flush. `clearSlot` is the slot that must stop naming it. */
  | {
      readonly kind: "releaseProcess";
      readonly argument: number;
      readonly foreign: boolean;
      readonly clearSlot: string | null;
    };

export interface NativeCallLifecycle {
  readonly setup: readonly NativeCallSetup[];
  readonly lends: readonly NativeCallLend[];
  readonly teardown: readonly NativeCallTeardown[];
  /** Handle arguments that own a registration made by this call. */
  readonly registrationOwnerArguments: ReadonlySet<number>;
  /**
   * The one handle argument a registration made here is owned by, or null.
   *
   * At most one, because the registration is owned by the RESULT and a result
   * has one owner; two would be two answers to the same question. Both
   * backends checked that separately, which is the shape this whole module
   * exists to stop.
   */
  readonly registrationOwner: number | null;
  /**
   * The handle whose callbacks this call ends, resolved and checked.
   *
   * A cancellation binding runs while the object it names is still alive and
   * answers nothing, so its argument must be a handle and its result void.
   */
  readonly cancellation: {
    readonly argument: number;
    readonly typeId: string;
  } | null;
}

/**
 * Everything a native call must do around itself, in order.
 *
 * The order is the decision, not a detail. Registration precedes the call
 * because a library may fire on subscribe. A release is validated before and
 * unpinned after, because the registration must stay readable for a library
 * that flushes one last time on the way out. A lent closure slot is armed
 * after every argument is converted, because a conversion that throws must
 * not leave one armed, and restored first on the way back because it is the
 * innermost thing that was changed.
 *
 * Both backends built these lists independently from the same fields. They
 * build them from this instead, and allocate their own temporaries for the
 * values the steps produce — keyed by argument index, which is how both
 * already addressed them.
 */
export function nativeCallLifecycle(
  binding: IrNativeBinding,
  adapterFor: (bindingId: string, argument: number) => NativeCallbackAdapter,
  /** Every binding in the module, so a cancellation can be recognised by the
   * registration that names it. Omitted where the caller has already resolved
   * the cancellation itself. */
  moduleBindings: readonly IrNativeBinding[] = [],
): NativeCallLifecycle {
  const setup: NativeCallSetup[] = [];
  const lends: NativeCallLend[] = [];
  const teardown: NativeCallTeardown[] = [];
  const registrationOwnerArguments = new Set<number>();

  binding.arguments.forEach((argument, index) => {
    const contract = argument.callback;
    if (argument.type.kind !== "func" || contract === undefined) return;
    const adapter = adapterFor(binding.id, index);
    if (nativeCallbackIsOwnerScoped(contract)) {
      setup.push({
        kind: "registerOwned",
        argument: index,
        ownerArgument:
          contract.sourceArguments.some((source) => source.kind === "registration-owner") &&
            contract.owner.kind === "argument"
            ? contract.owner.argument
            : null,
        direct: nativeTrampolineForm(adapter).closure.kind === "ownerContext",
      });
      if (contract.owner.kind === "argument") {
        registrationOwnerArguments.add(contract.owner.argument);
      }
      return;
    }
    if (contract.owner.kind !== "process") return;
    setup.push({
      kind: "registerProcess",
      argument: index,
      foreign: adapter.foreign,
      armSlot: adapter.global,
    });
    if (adapter.global !== null) {
      teardown.push({ kind: "commitSlot", argument: index, slot: adapter.global });
    }
  });

  for (const parameter of binding.parameters) {
    if (parameter.projection.kind !== "callbackRelease") continue;
    const adapter = adapterFor(
      parameter.projection.registration.binding,
      parameter.projection.registration.argument,
    );
    setup.push({ kind: "requireProcess", argument: parameter.projection.argument });
    teardown.push({
      kind: "releaseProcess",
      argument: parameter.projection.argument,
      foreign: adapter.foreign,
      clearSlot: adapter.global,
    });
  }

  /* A value that UNMAKES a registration has no adapter of its own, so it
   * lends nothing; the binding that made the registration lent whatever it
   * had to. */
  binding.arguments.forEach((argument, index) => {
    if (argument.type.kind !== "func" || argument.callback === undefined) return;
    const slot = adapterFor(binding.id, index).tls;
    if (slot === null) return;
    lends.push({ argument: index, slot });
  });

  return {
    setup,
    /* Innermost first on the way back: the lends were the last thing armed. */
    teardown: [
      ...[...lends].reverse().map((lend): NativeCallTeardown => ({
        kind: "restoreClosure",
        argument: lend.argument,
        slot: lend.slot,
      })),
      ...teardown,
    ],
    lends,
    registrationOwnerArguments,
    registrationOwner: resolveRegistrationOwner(binding, registrationOwnerArguments),
    cancellation: resolveCancellation(binding, moduleBindings),
  };
}

/** A registration owned by more than one argument is two answers to one
 * question. Both backends asked it; now neither does. */
function resolveRegistrationOwner(
  binding: IrNativeBinding,
  owners: ReadonlySet<number>,
): number | null {
  if (owners.size > 1) {
    throw new Error(
      `emitter bug: conflicting retained callback owners in ${binding.id}`,
    );
  }
  return owners.values().next().value ?? null;
}

/** The handle whose callbacks this binding ends, checked against what a
 * cancellation can be: it runs while the object is alive, so it takes a
 * handle, and it answers nothing, so its result is void. */
function resolveCancellation(
  binding: IrNativeBinding,
  moduleBindings: readonly IrNativeBinding[],
): NativeCallLifecycle["cancellation"] {
  const argument = nativeCallbackCancellationArgument(moduleBindings, binding);
  if (argument === undefined) return null;
  const type = binding.arguments[argument]?.type;
  if (type?.kind !== "nativeHandle" || binding.result.type.kind !== "void") {
    throw new Error(
      `emitter bug: invalid callback cancellation binding ${binding.id}`,
    );
  }
  return { argument, typeId: type.typeId };
}

/** What a queued invocation must give back if it is dropped instead of run. */
export interface NativeQueuedPayloadCleanup {
  /** Slots holding a string this invocation copied out of foreign storage. */
  readonly copiedStrings: ReadonlySet<number>;
  /** Slots holding a handle reference this invocation owns, with the binding
   * that gives that reference back. */
  readonly ownedHandles: ReadonlyMap<
    number,
    {
      readonly typeId: string;
      readonly free: string;
      readonly frameBounded: {
        readonly promote: string;
        readonly release: string;
      } | null;
    }
  >;
}

/**
 * The slots a dropped queued delivery has to release.
 *
 * A queued invocation materializes its payloads before the delivery runs,
 * because the thread that raised it may not be the thread that can read a
 * closure. Two of those payload kinds are OWNED — a copied string and a
 * retained handle reference — so a delivery that is dropped rather than run
 * still has to give them back.
 *
 * Both backends computed this, and computed it differently: one filtered the
 * payloads, the other walked the contract's source arguments and re-derived
 * the same conditions from the adapter's parameter kinds. They agreed, which
 * is the only reason it was not a defect — `nativeCallbackPayloads` produces
 * an `ownedHandle` under exactly the condition the second derivation tested
 * for, and a `cstring` under exactly the other. Two computations that agree by
 * construction are still two places for one answer to change.
 */
export function nativeQueuedPayloadCleanup(
  payloads: readonly NativeCallbackPayload[],
): NativeQueuedPayloadCleanup {
  const copiedStrings = new Set<number>();
  const ownedHandles = new Map<
    number,
    {
      typeId: string;
      free: string;
      frameBounded: { promote: string; release: string } | null;
    }
  >();
  for (const payload of payloads) {
    if (payload.kind === "cstring") copiedStrings.add(payload.slot);
    else if (payload.kind === "ownedHandle") {
      ownedHandles.set(payload.slot, {
        typeId: payload.typeId,
        free: payload.free,
        frameBounded: payload.frameBounded,
      });
    }
  }
  return { copiedStrings, ownedHandles };
}

/**
 * How many pointer-sized fields `ScrCallbackInvocation` occupies before a
 * queued invocation's own payload fields begin.
 *
 * The C backend never needs this: it names the runtime struct and lets the C
 * compiler place what follows. LLVM has no such option — a queued invocation
 * is a flat literal type there, so the base has to be spelled out, and every
 * payload field is addressed by an index counted from it.
 *
 * It was spelled as the bare number 7, twice, with nothing tying it to the
 * header it describes. The count is:
 *
 *   ScrOwnerGatewayEvent  next, deliver, destroy                      3
 *   ScrCallbackInvocation signature, invoke, payload_destroy, token   4
 *
 * Adding a field to either struct is an ordinary runtime change that would
 * leave the C backend correct and silently move every LLVM payload index by
 * one — reading a string out of what is now the token slot. Naming it here
 * puts the number in one place; `native-callbacks.test.ts` reads the header
 * and fails when the header stops agreeing with it, which is the half that
 * makes the name worth having.
 */
export const NATIVE_CALLBACK_INVOCATION_BASE_FIELDS = 7;
