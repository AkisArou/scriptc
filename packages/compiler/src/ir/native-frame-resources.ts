import {
  nullableNativeHandleUnion,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrNativeBinding,
  type IrNativeFrameResource,
  type IrStmt,
  type SrcLoc,
} from "./nodes.js";

interface FrameCandidate {
  readonly localId: string;
  readonly declaration: Extract<IrStmt, { kind: "varDecl" }>;
  readonly call: Extract<IrExpr, { kind: "nativeCall" }>;
  readonly binding: IrNativeBinding;
  readonly resource: IrNativeFrameResource;
}

function hasFrameBoundedOwnedHandleResult(
  binding: IrNativeBinding | undefined,
): binding is IrNativeBinding {
  if (
    binding === undefined ||
    binding.result.frameBounded === undefined ||
    binding.result.type.kind !== "nativeHandle" ||
    binding.result.ownership.kind !== "owned" ||
    binding.result.ownership.transfer !== "to-runtime" ||
    (binding.result.projection.kind !== "direct" &&
      binding.result.projection.kind !== "nullableHandle")
  ) {
    return false;
  }
  /* A result-owned callback normally requires the stable result cell to own
   * its lifecycle edge. It may use the raw frame result only when the ABI has
   * an explicit sibling release hook for that same callback context. Native
   * then owns one standalone context reference and must close admission before
   * releasing it. No implicit lifetime inference crosses this boundary. */
  return binding.arguments.every((argument, argumentIndex) => {
    const callback = argument.callback;
    if (callback?.owner.kind !== "result") return true;
    return callback.synchronousReturn === true && binding.parameters.some(
      (parameter) =>
        parameter.projection.kind === "callbackContextRelease" &&
        parameter.projection.argument === argumentIndex,
    );
  });
}

function resultCancellationBindings(binding: IrNativeBinding): ReadonlySet<string> {
  return new Set(
    binding.arguments.flatMap((argument) => {
      const callback = argument.callback;
      return callback !== undefined && callback.owner.kind === "result" &&
          "cancellationBinding" in callback
        ? [callback.cancellationBinding]
        : [];
    }),
  );
}

/** Recognise the one non-borrowing use a scoped registration may have: its
 * explicit terminal cancellation. Requiring a direct top-level expression
 * statement makes the local slot recoverable by both emitters, so they can
 * transfer the raw resource to the cancellation call and then null the slot.
 * The caller separately proves that no use follows this one. */
function terminalFrameCancellationUse(
  value: Extract<IrExpr, { kind: "varRef" }>,
  parent: WalkParent | null,
  candidate: FrameCandidate,
  fn: IrFunction,
): boolean {
  const call = parent?.node.kind === "nativeCall"
    ? parent.node as Extract<IrExpr, { kind: "nativeCall" }>
    : null;
  const statement = parent?.parent?.node.kind === "exprStmt"
    ? parent.parent.node as Extract<IrStmt, { kind: "exprStmt" }>
    : null;
  if (
    call === null || statement === null || statement.expr !== call ||
    !fn.body.includes(statement) || call.args.indexOf(value) < 0
  ) {
    return false;
  }
  const cancellations = resultCancellationBindings(candidate.binding);
  return cancellations.size === 1 && cancellations.has(call.binding);
}

interface CallbackFrameAnalysis {
  readonly eligibleSources: ReadonlySet<object>;
  readonly locals: ReadonlyMap<string, ReadonlyMap<string, IrNativeFrameResource>>;
  readonly sourceLocals: ReadonlyMap<
    object,
    readonly { fn: IrFunction; localId: string; resource: IrNativeFrameResource }[]
  >;
}

type ClosureExpr = Extract<IrExpr, { kind: "closure" }>;

interface NativeFrameClosureCandidate {
  readonly parent: IrFunction;
  readonly call: Extract<IrExpr, { kind: "nativeCall" }>;
  readonly closure: ClosureExpr;
  readonly target: IrFunction;
}

interface NativeFrameClosureAnalysis {
  readonly closures: ReadonlySet<object>;
  readonly locals: ReadonlyMap<string, ReadonlySet<string>>;
}

interface WalkParent {
  readonly node: { readonly kind: string };
  readonly parent: WalkParent | null;
}

/** Walk executable IR while treating type and location records as leaves.
 * Array elements keep the owning IR node as their parent, so a varRef can
 * prove it is the whole logical argument rather than merely nested inside
 * one. */
function walkExecutable(
  value: unknown,
  visit: (node: { kind: string }, parent: WalkParent | null) => void,
  parent: WalkParent | null = null,
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkExecutable(item, visit, parent);
    return;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const owner = typeof kind === "string"
    ? { node: record as { kind: string }, parent }
    : parent;
  if (typeof kind === "string") visit(record as { kind: string }, parent);
  for (const [key, child] of Object.entries(record)) {
    if (key === "type" || key === "loc" || key === "nativeFrame") continue;
    walkExecutable(child, visit, owner);
  }
}

function borrowedHandleArgument(
  binding: IrNativeBinding | undefined,
  argumentIndex: number,
): boolean {
  const argument = binding?.arguments[argumentIndex];
  if (argument?.type.kind !== "nativeHandle") return false;
  const slots = binding!.parameters.filter(
    (parameter) =>
      parameter.projection.kind === "argument" &&
      parameter.projection.argument === argumentIndex,
  );
  if (
    slots.length === 0 ||
    slots.some(
      (parameter) =>
        parameter.type.kind !== "nativeHandle" ||
        parameter.ownership.kind !== "borrowed" ||
        parameter.ownership.scope !== "call",
    )
  ) {
    return false;
  }
  /* A borrowed receiver can still become the owner of a registration made by
   * this call. Such an edge must point at a stable cell, so it is an escape. */
  return !binding!.arguments.some((candidate) => {
    const owner = candidate.callback?.owner;
    return owner?.kind === "argument" && owner.argument === argumentIndex;
  });
}

/** Whether `value`, optionally widened through identity native-handle
 * upcasts, is the complete argument of a synchronous borrowed native slot. */
function borrowedHandleUse(
  initialValue: IrExpr,
  initialParent: WalkParent | null,
  bindings: ReadonlyMap<string, IrNativeBinding>,
): boolean {
  let value = initialValue;
  let parent = initialParent;
  while (parent?.node.kind === "upcast") {
    const upcast = parent.node as Extract<IrExpr, { kind: "upcast" }>;
    if (
      upcast.value !== value || value.type.kind !== "nativeHandle" ||
      upcast.type.kind !== "nativeHandle"
    ) {
      return false;
    }
    value = upcast;
    parent = parent.parent;
  }
  const call = parent?.node.kind === "nativeCall"
    ? parent.node as Extract<IrExpr, { kind: "nativeCall" }>
    : null;
  const argumentIndex = call?.args.indexOf(value) ?? -1;
  return argumentIndex >= 0 &&
    borrowedHandleArgument(bindings.get(call!.binding), argumentIndex);
}

function candidatesFor(
  fn: IrFunction,
  bindings: ReadonlyMap<string, IrNativeBinding>,
  mod: Pick<IrModule, "unions">,
): Map<string, FrameCandidate> {
  const candidates = new Map<string, FrameCandidate>();
  if (fn.async === true || fn.generator !== undefined) return candidates;
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const declarations = new Map<string, Extract<IrStmt, { kind: "varDecl" }>[]>();

  walkExecutable(fn.body, (node) => {
    if (node.kind !== "varDecl") return;
    const declaration = node as Extract<IrStmt, { kind: "varDecl" }>;
    const list = declarations.get(declaration.localId) ?? [];
    list.push(declaration);
    declarations.set(declaration.localId, list);
  });

  for (const [localId, list] of declarations) {
    const local = locals.get(localId);
    const declaration = list.length === 1 ? list[0] : undefined;
    const init = declaration?.init;
    if (
      local === undefined ||
      local.mutable ||
      local.boxed === true ||
      init?.kind !== "nativeCall" ||
      init.type.kind !== local.type.kind
    ) {
      continue;
    }
    const binding = bindings.get(init.binding);
    if (!hasFrameBoundedOwnedHandleResult(binding)) {
      continue;
    }
    const frame = binding.result.frameBounded!;
    const resultType = binding.result.type;
    if (resultType.kind !== "nativeHandle") continue;
    let resource: IrNativeFrameResource;
    if (
      binding.result.projection.kind === "direct" &&
      local.type.kind === "nativeHandle" &&
      init.type.kind === "nativeHandle" &&
      resultType.typeId === local.type.typeId &&
      init.type.typeId === local.type.typeId
    ) {
      resource = { release: frame.release.symbol };
    } else if (
      binding.result.projection.kind === "nullableHandle" &&
      local.type.kind === "union" &&
      init.type.kind === "union" &&
      init.type.unionId === local.type.unionId
    ) {
      const nullable = nullableNativeHandleUnion(
        mod.unions ?? [],
        resultType.typeId,
      );
      if (nullable === null || nullable.unionId !== local.type.unionId) continue;
      resource = { release: frame.release.symbol, nullable };
    } else {
      continue;
    }
    candidates.set(localId, {
      localId,
      declaration: declaration!,
      call: init,
      binding,
      resource,
    });
  }

  const escaped = new Set<string>();
  const terminalCancellationSeen = new Set<string>();
  walkExecutable(fn.body, (node, parent) => {
    if (node.kind !== "varRef") return;
    const value = node as Extract<IrExpr, { kind: "varRef" }>;
    const localId = value.localId;
    if (!candidates.has(localId)) return;
    const candidate = candidates.get(localId)!;
    /* Once native has consumed the raw registration, even another borrow is a
     * use-after-dispose. Walking in executable order turns "terminal" into a
     * checked property rather than an emitter assumption. */
    if (terminalCancellationSeen.has(localId)) {
      escaped.add(localId);
      return;
    }
    const nullable = candidate.resource.nullable;
    if (nullable !== undefined) {
      const use = parent?.node;
      if (
        use?.kind === "unionIsTag" &&
        (use as Extract<IrExpr, { kind: "unionIsTag" }>).value === node &&
        (use as Extract<IrExpr, { kind: "unionIsTag" }>).unionId === nullable.unionId &&
        ((use as Extract<IrExpr, { kind: "unionIsTag" }>).tag === nullable.handleTag ||
          (use as Extract<IrExpr, { kind: "unionIsTag" }>).tag === nullable.nullTag)
      ) {
        return;
      }
      if (use?.kind === "unionNarrow") {
        const narrow = use as Extract<IrExpr, { kind: "unionNarrow" }>;
        if (
          narrow.value === node &&
          narrow.unionId === nullable.unionId &&
          narrow.tag === nullable.handleTag &&
          borrowedHandleUse(narrow, parent?.parent ?? null, bindings)
        ) {
          return;
        }
      }
      escaped.add(localId);
      return;
    }
    if (borrowedHandleUse(value, parent, bindings)) return;
    if (terminalFrameCancellationUse(value, parent, candidate, fn)) {
      terminalCancellationSeen.add(localId);
      return;
    }
    escaped.add(localId);
  });
  for (const localId of escaped) candidates.delete(localId);
  return candidates;
}

/** An owned handle whose native call is the complete expression statement is
 * born dead: source code cannot observe or retain it. Selecting the alternate
 * entry avoids constructing a stable managed cell merely so statement cleanup
 * can immediately destroy it. As with local specialization, asynchronous and
 * generator bodies stay conservative because their frames may suspend. */
function discardedFrameCallsFor(
  fn: IrFunction,
  bindings: ReadonlyMap<string, IrNativeBinding>,
): Set<Extract<IrExpr, { kind: "nativeCall" }>> {
  const calls = new Set<Extract<IrExpr, { kind: "nativeCall" }>>();
  if (fn.async === true || fn.generator !== undefined) return calls;
  walkExecutable(fn.body, (node, parent) => {
    if (node.kind !== "nativeCall" || parent?.node.kind !== "exprStmt") return;
    const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
    const statement = parent.node as Extract<IrStmt, { kind: "exprStmt" }>;
    if (
      statement.expr === call &&
      hasFrameBoundedOwnedHandleResult(bindings.get(call.binding))
    ) {
      calls.add(call);
    }
  });
  return calls;
}

/** An owned handle produced directly as a synchronous borrowed native
 * argument cannot escape between the two calls. Keep the inner result in its
 * foreign frame and release it after the containing statement instead of
 * allocating a stable managed cell solely to lend that cell back to native
 * code. Identity upcasts remain eligible; registration-owner arguments do
 * not, through borrowedHandleUse's binding check. */
function nestedBorrowedFrameCallsFor(
  fn: IrFunction,
  bindings: ReadonlyMap<string, IrNativeBinding>,
): Set<Extract<IrExpr, { kind: "nativeCall" }>> {
  const calls = new Set<Extract<IrExpr, { kind: "nativeCall" }>>();
  if (fn.async === true || fn.generator !== undefined) return calls;
  walkExecutable(fn.body, (node, parent) => {
    if (node.kind !== "nativeCall") return;
    const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
    if (
      hasFrameBoundedOwnedHandleResult(bindings.get(call.binding)) &&
      borrowedHandleUse(call, parent, bindings)
    ) {
      calls.add(call);
    }
  });
  return calls;
}

function frameResourceForCallbackParameter(
  fn: IrFunction,
  parameterIndex: number,
  typeId: string,
  release: string,
  bindings: ReadonlyMap<string, IrNativeBinding>,
  mod: Pick<IrModule, "unions">,
): IrNativeFrameResource | null {
  const parameter = fn.params[parameterIndex];
  /* A shared trampoline cannot release an omitted parameter for one handler
   * while lending it to another. Until adapters are specialized per call
   * site, a callback that declares fewer parameters keeps this payload on the
   * stable path rather than relying on a platform frame's implicit cleanup. */
  if (parameter === undefined) return null;
  if (fn.async === true || fn.generator !== undefined) return null;
  const local = fn.locals.find((candidate) => candidate.id === parameter.localId);
  if (local === undefined || local.boxed === true || !typeEquals(local.type, parameter.type)) {
    return null;
  }
  let resource: IrNativeFrameResource;
  if (parameter.type.kind === "nativeHandle" && parameter.type.typeId === typeId) {
    resource = { release };
  } else if (parameter.type.kind === "union") {
    const nullable = nullableNativeHandleUnion(mod.unions ?? [], typeId);
    if (nullable === null || nullable.unionId !== parameter.type.unionId) return null;
    resource = { release, nullable };
  } else {
    return null;
  }

  let escaped = false;
  walkExecutable(fn.body, (node, parent) => {
    if (escaped) return;
    if (
      (node.kind === "assign" || node.kind === "assignExpr" || node.kind === "incDec") &&
      (node as { localId?: unknown }).localId === parameter.localId
    ) {
      escaped = true;
      return;
    }
    if (node.kind !== "varRef") return;
    const ref = node as Extract<IrExpr, { kind: "varRef" }>;
    if (ref.localId !== parameter.localId) return;
    const nullable = resource.nullable;
    if (nullable !== undefined) {
      const use = parent?.node;
      if (
        use?.kind === "unionIsTag" &&
        (use as Extract<IrExpr, { kind: "unionIsTag" }>).value === node &&
        (use as Extract<IrExpr, { kind: "unionIsTag" }>).unionId === nullable.unionId &&
        ((use as Extract<IrExpr, { kind: "unionIsTag" }>).tag === nullable.handleTag ||
          (use as Extract<IrExpr, { kind: "unionIsTag" }>).tag === nullable.nullTag)
      ) {
        return;
      }
      if (use?.kind === "unionNarrow") {
        const narrow = use as Extract<IrExpr, { kind: "unionNarrow" }>;
        if (
          narrow.value === node &&
          narrow.unionId === nullable.unionId &&
          narrow.tag === nullable.handleTag &&
          borrowedHandleUse(narrow, parent?.parent ?? null, bindings)
        ) {
          return;
        }
      }
      escaped = true;
      return;
    }
    if (!borrowedHandleUse(node as IrExpr, parent, bindings)) {
      escaped = true;
    }
  });
  return escaped ? null : resource;
}

/** Find callback payload positions for which every reached registration
 * supplies a directly-known synchronous handler and every such handler keeps
 * the payload inside borrowed native calls/null tests. Callback adapters are
 * allocated per binding today, so one unproved registration conservatively
 * keeps that payload position stable for all registrations of the binding. */
function callbackFrameAnalysis(mod: IrModule): CallbackFrameAnalysis {
  const bindings = new Map((mod.nativeBindings ?? []).map((binding) => [binding.id, binding]));
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const calls = new Map<string, Array<Extract<IrExpr, { kind: "nativeCall" }>>>();
  const closureOccurrences = new Map<string, number>();
  for (const fn of mod.functions) {
    walkExecutable(fn.body, (node) => {
      if (node.kind === "nativeCall") {
        const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
        const list = calls.get(call.binding) ?? [];
        list.push(call);
        calls.set(call.binding, list);
      } else if (node.kind === "closure") {
        const name = (node as Extract<IrExpr, { kind: "closure" }>).fnName;
        closureOccurrences.set(name, (closureOccurrences.get(name) ?? 0) + 1);
      }
    });
  }

  const eligibleSources = new Set<object>();
  const locals = new Map<string, Map<string, IrNativeFrameResource>>();
  const sourceLocals = new Map<
    object,
    { fn: IrFunction; localId: string; resource: IrNativeFrameResource }[]
  >();
  for (const binding of mod.nativeBindings ?? []) {
    const bindingCalls = calls.get(binding.id) ?? [];
    if (bindingCalls.length === 0) continue;
    binding.arguments.forEach((argument, argumentIndex) => {
      const contract = argument.callback;
      if (contract === undefined || !contract.synchronousReturn) return;
      contract.sourceArguments.forEach((source, sourceIndex) => {
        if (
          source.kind !== "callback-parameter" ||
          source.destructor === undefined ||
          source.frameBounded === undefined
        ) {
          return;
        }
        const sourceType = argument.type.kind === "func"
          ? argument.type.params[sourceIndex]
          : undefined;
        const typeId = sourceType?.kind === "nativeHandle" ||
            sourceType?.kind === "nullableNativeHandle"
          ? sourceType.typeId
          : null;
        if (typeId === null) return;
        const selected: Array<{
          fn: IrFunction;
          resource: IrNativeFrameResource;
        }> = [];
        const usedClosures = new Map<string, number>();
        let safe = true;
        for (const call of bindingCalls) {
          const callback = call.args[argumentIndex];
          if (callback?.kind !== "closure") {
            safe = false;
            break;
          }
          const fn = functions.get(callback.fnName);
          if (fn === undefined) {
            safe = false;
            break;
          }
          const resource = frameResourceForCallbackParameter(
            fn,
            sourceIndex,
            typeId,
            source.frameBounded.release.symbol,
            bindings,
            mod,
          );
          if (resource === null) {
            safe = false;
            break;
          }
          selected.push({ fn, resource });
          usedClosures.set(fn.name, (usedClosures.get(fn.name) ?? 0) + 1);
        }
        /* A function body whose parameter representation changes may not be
         * reached through another closure value with the ordinary stable ABI.
         * Anonymous handlers normally have one occurrence; this check makes
         * that fact a proof instead of an assumption. */
        if (
          safe && [...usedClosures].some(
            ([name, count]) => closureOccurrences.get(name) !== count,
          )
        ) {
          safe = false;
        }
        if (!safe) return;
        const selectedLocals: {
          fn: IrFunction;
          localId: string;
          resource: IrNativeFrameResource;
        }[] = [];
        const pending = new Map<string, IrNativeFrameResource>();
        for (const { fn, resource } of selected) {
          const parameter = fn.params[sourceIndex]!;
          const key = `${fn.name}\u0000${parameter.localId}`;
          const prior = pending.get(key) ?? locals.get(fn.name)?.get(parameter.localId);
          if (
            prior !== undefined &&
            (prior.release !== resource.release ||
              prior.nullable?.unionId !== resource.nullable?.unionId)
          ) {
            eligibleSources.delete(source);
            safe = false;
            break;
          }
          pending.set(key, resource);
          selectedLocals.push({ fn, localId: parameter.localId, resource });
        }
        if (!safe) return;
        eligibleSources.add(source);
        for (const selectedLocal of selectedLocals) {
          const byLocal = locals.get(selectedLocal.fn.name) ??
            new Map<string, IrNativeFrameResource>();
          byLocal.set(selectedLocal.localId, selectedLocal.resource);
          locals.set(selectedLocal.fn.name, byLocal);
        }
        sourceLocals.set(source, selectedLocals);
      });
    });
  }
  return { eligibleSources, locals, sourceLocals };
}

/** A stack capture box must be born once in the declaring function's outer
 * lexical scope. This deliberately excludes params, inherited captures, TDZ
 * cells, and loop/block declarations: all are supportable in principle, but
 * none is needed for the renderer hot path and each widens the lifetime proof. */
function directScalarFrameCapture(fn: IrFunction, localId: string): boolean {
  if (
    fn.params.some((parameter) => parameter.localId === localId) ||
    (fn.captures ?? []).some((capture) => capture.localId === localId)
  ) {
    return false;
  }
  const local = fn.locals.find((candidate) => candidate.id === localId);
  if (
    local?.boxed !== true || local.tdz === true ||
    (local.type.kind !== "f64" && local.type.kind !== "bool")
  ) {
    return false;
  }
  const declarations: Extract<IrStmt, { kind: "varDecl" }>[] = [];
  walkExecutable(fn.body, (node) => {
    if (node.kind !== "varDecl") return;
    const declaration = node as Extract<IrStmt, { kind: "varDecl" }>;
    if (declaration.localId === localId) declarations.push(declaration);
  });
  return declarations.length === 1 && declarations[0]!.init !== null &&
    fn.body.includes(declarations[0]!);
}

/** A lifted handler may freely read and mutate its scalar captures, but it may
 * not expose the stack closure itself or put one of its stack boxes into a
 * nested closure. Either operation could manufacture a reference that outlives
 * the native registration even though the registration itself is scoped. */
function targetAcceptsFrameClosure(target: IrFunction): boolean {
  if (target.async === true || target.generator !== undefined) return false;
  const captures = new Set((target.captures ?? []).map(({ localId }) => localId));
  let safe = true;
  walkExecutable(target.body, (node) => {
    if (!safe) return;
    if (node.kind === "selfRef") {
      safe = false;
      return;
    }
    if (node.kind === "closure") {
      const nested = node as ClosureExpr;
      if (nested.captures.some((localId) => captures.has(localId))) safe = false;
    }
  });
  return safe;
}

/** Select the zero-allocation callback-context slice. The existing
 * frame-bounded result proof establishes that native teardown happens before
 * the declaring function returns. This additional proof requires the callback
 * to run synchronously on that same caller, keeps the closure expression as a
 * direct callback argument, and closes every alternate escape for its boxes.
 *
 * Candidate removal is a fixpoint: when one closure using a local cannot use a
 * stack context, every sibling using that same local must fall back too. This
 * is what prevents one ordinary heap closure from retaining a stack box. */
function nativeFrameClosureAnalysis(mod: IrModule): NativeFrameClosureAnalysis {
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const bindings = new Map((mod.nativeBindings ?? []).map((binding) => [binding.id, binding]));
  const users = new Map<string, Map<string, Set<object>>>();
  const candidates = new Map<object, NativeFrameClosureCandidate>();

  for (const parent of mod.functions) {
    const byLocal = new Map<string, Set<object>>();
    users.set(parent.name, byLocal);
    walkExecutable(parent.body, (node) => {
      if (node.kind !== "closure") return;
      const closure = node as ClosureExpr;
      for (const localId of closure.captures) {
        const localUsers = byLocal.get(localId) ?? new Set<object>();
        localUsers.add(closure);
        byLocal.set(localId, localUsers);
      }
    });
    if (parent.async === true || parent.generator !== undefined) continue;
    walkExecutable(parent.body, (node) => {
      if (node.kind !== "nativeCall") return;
      const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
      if (call.resultMode !== "frameBounded") return;
      const binding = bindings.get(call.binding);
      if (!hasFrameBoundedOwnedHandleResult(binding)) return;
      binding.arguments.forEach((argument, argumentIndex) => {
        const contract = argument.callback;
        const closure = call.args[argumentIndex];
        if (
          contract?.owner.kind !== "result" ||
          contract.synchronousReturn !== true ||
          contract.allowedInvocationExecutors.length !== 1 ||
          contract.allowedInvocationExecutors[0] !== "same-as-caller" ||
          closure?.kind !== "closure" || closure.captures.length === 0 ||
          !binding.parameters.some(
            (parameter) =>
              parameter.projection.kind === "callbackContextRelease" &&
              parameter.projection.argument === argumentIndex,
          )
        ) {
          return;
        }
        const target = functions.get(closure.fnName);
        if (
          target?.captures === undefined ||
          target.captures.length !== closure.captures.length ||
          !targetAcceptsFrameClosure(target) ||
          closure.captures.some((localId, index) => {
            const local = parent.locals.find((candidate) => candidate.id === localId);
            const capture = target.captures![index];
            return !directScalarFrameCapture(parent, localId) ||
              local === undefined || capture === undefined ||
              !typeEquals(local.type, capture.type);
          })
        ) {
          return;
        }
        candidates.set(closure, { parent, call, closure, target });
      });
    });
  }

  const closures = new Set<object>(candidates.keys());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, candidate] of candidates) {
      if (!closures.has(key)) continue;
      const byLocal = users.get(candidate.parent.name)!;
      if (
        candidate.closure.captures.some((localId) =>
          [...(byLocal.get(localId) ?? [])].some((user) => !closures.has(user))
        )
      ) {
        closures.delete(key);
        changed = true;
      }
    }
  }

  const locals = new Map<string, Set<string>>();
  for (const [key, candidate] of candidates) {
    if (!closures.has(key)) continue;
    const selected = locals.get(candidate.parent.name) ?? new Set<string>();
    for (const localId of candidate.closure.captures) selected.add(localId);
    locals.set(candidate.parent.name, selected);
  }
  return { closures, locals };
}

/** Select the conservative frame-bounded slice: ignored capable results,
 * capable results nested directly in synchronous borrowed native arguments,
 * plus immutable, unboxed locals initialized directly by a capable handle
 * result with every use as a whole synchronous borrowed native argument or,
 * for nullable handles, an exact null/handle tag test. Everything else remains
 * on the stable path. */
export function specializeNativeFrameResources(mod: IrModule): void {
  const bindings = new Map((mod.nativeBindings ?? []).map((binding) => [binding.id, binding]));
  for (const fn of mod.functions) {
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const candidate of candidatesFor(fn, bindings, mod).values()) {
      locals.get(candidate.localId)!.nativeFrame = candidate.resource;
      candidate.call.resultMode = "frameBounded";
    }
    for (const call of discardedFrameCallsFor(fn, bindings)) {
      call.resultMode = "frameBounded";
    }
    for (const call of nestedBorrowedFrameCallsFor(fn, bindings)) {
      call.resultMode = "frameBounded";
    }
  }
  const callbacks = callbackFrameAnalysis(mod);
  for (const binding of mod.nativeBindings ?? []) {
    for (const argument of binding.arguments) {
      for (const source of argument.callback?.sourceArguments ?? []) {
        if (source.kind !== "callback-parameter" || !callbacks.eligibleSources.has(source)) {
          continue;
        }
        source.resourceMode = "frameBounded";
      }
    }
  }
  for (const fn of mod.functions) {
    const selected = callbacks.locals.get(fn.name);
    if (selected === undefined) continue;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const [localId, resource] of selected) {
      locals.get(localId)!.nativeFrame = resource;
    }
  }
  const frameClosures = nativeFrameClosureAnalysis(mod);
  for (const fn of mod.functions) {
    const selectedLocals = frameClosures.locals.get(fn.name);
    if (selectedLocals !== undefined) {
      const locals = new Map(fn.locals.map((local) => [local.id, local]));
      for (const localId of selectedLocals) locals.get(localId)!.nativeFrameCapture = true;
    }
    walkExecutable(fn.body, (node) => {
      if (node.kind === "closure" && frameClosures.closures.has(node)) {
        (node as ClosureExpr).nativeFrameContext = true;
      }
    });
  }
}

export interface NativeFrameResourceIssue {
  readonly message: string;
  readonly loc: SrcLoc;
}

/** Backstop for one function's deserialized or hand-built IR. The caller owns
 * the module-wide callback analysis so validation remains one whole-program
 * pass rather than repeating it once per function. */
function validateFunctionNativeFrameResources(
  fn: IrFunction,
  bindings: ReadonlyMap<string, IrNativeBinding>,
  mod: IrModule,
  callbackAnalysis: CallbackFrameAnalysis,
): NativeFrameResourceIssue[] {
  const issues: NativeFrameResourceIssue[] = [];
  const candidates = candidatesFor(fn, bindings, mod);
  const discardedCalls = discardedFrameCallsFor(fn, bindings);
  const nestedBorrowedCalls = nestedBorrowedFrameCallsFor(fn, bindings);
  const callbackLocals = new Map<string, IrNativeFrameResource>();
  for (const binding of mod.nativeBindings ?? []) {
    for (const argument of binding.arguments) {
      for (const source of argument.callback?.sourceArguments ?? []) {
        if (source.kind !== "callback-parameter" || source.resourceMode !== "frameBounded") {
          continue;
        }
        for (const selected of callbackAnalysis.sourceLocals.get(source) ?? []) {
          if (selected.fn.name === fn.name) callbackLocals.set(selected.localId, selected.resource);
        }
      }
    }
  }
  const annotatedCalls = new Set<Extract<IrExpr, { kind: "nativeCall" }>>();
  walkExecutable(fn.body, (node) => {
    if (node.kind !== "nativeCall") return;
    const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
    if (call.resultMode === "frameBounded") annotatedCalls.add(call);
  });
  for (const local of fn.locals) {
    if (local.nativeFrame === undefined) continue;
    const candidate = candidates.get(local.id);
    const callback = callbackLocals.get(local.id);
    if (
      (candidate === undefined ||
        candidate.resource.release !== local.nativeFrame.release ||
        candidate.resource.nullable?.unionId !== local.nativeFrame.nullable?.unionId ||
        candidate.resource.nullable?.handleTag !== local.nativeFrame.nullable?.handleTag ||
        candidate.resource.nullable?.nullTag !== local.nativeFrame.nullable?.nullTag ||
        candidate.call.resultMode !== "frameBounded") &&
      (callback === undefined ||
        callback.release !== local.nativeFrame.release ||
        callback.nullable?.unionId !== local.nativeFrame.nullable?.unionId ||
        callback.nullable?.handleTag !== local.nativeFrame.nullable?.handleTag ||
        callback.nullable?.nullTag !== local.nativeFrame.nullable?.nullTag)
    ) {
      issues.push({
        message: `local "${local.name}" has an invalid frame-bounded native resource`,
        loc: candidate?.declaration.loc ?? fn.loc,
      });
      continue;
    }
    if (candidate !== undefined) annotatedCalls.delete(candidate.call);
  }
  for (const call of discardedCalls) annotatedCalls.delete(call);
  for (const call of nestedBorrowedCalls) annotatedCalls.delete(call);
  for (const call of annotatedCalls) {
    issues.push({
      message: `Native IR call ${call.binding} selects a frame-bounded result outside an eligible local or discarded expression`,
      loc: call.loc,
    });
  }
  return issues;
}

/** Validate frame-resource selection once for the module. A callback's
 * selected mode lives on a binding shared by every registration, while raw
 * storage markers live on directly-known handler parameters, so neither fact
 * is sufficient without the other. */
export function validateNativeFrameResources(
  mod: IrModule,
  bindings: ReadonlyMap<string, IrNativeBinding>,
): NativeFrameResourceIssue[] {
  const issues: NativeFrameResourceIssue[] = [];
  const analysis = callbackFrameAnalysis(mod);
  const frameClosures = nativeFrameClosureAnalysis(mod);
  for (const binding of mod.nativeBindings ?? []) {
    for (const argument of binding.arguments) {
      for (const source of argument.callback?.sourceArguments ?? []) {
        if (source.kind !== "callback-parameter" || source.resourceMode === undefined) continue;
        if (
          source.resourceMode !== "frameBounded" ||
          !analysis.eligibleSources.has(source)
        ) {
          issues.push({
            message: `Native IR binding "${binding.id}" selects a frame-bounded callback payload outside an eligible synchronous handler`,
            loc: { file: mod.sourceFile, start: 0, end: 0 },
          });
          continue;
        }
        for (const selected of analysis.sourceLocals.get(source) ?? []) {
          const local = selected.fn.locals.find((candidate) => candidate.id === selected.localId);
          if (
            local?.nativeFrame?.release !== selected.resource.release ||
            local.nativeFrame.nullable?.unionId !== selected.resource.nullable?.unionId ||
            local.nativeFrame.nullable?.handleTag !== selected.resource.nullable?.handleTag ||
            local.nativeFrame.nullable?.nullTag !== selected.resource.nullable?.nullTag
          ) {
            issues.push({
              message: `callback parameter "${local?.name ?? selected.localId}" has an invalid frame-bounded native resource`,
              loc: selected.fn.loc,
            });
          }
        }
      }
    }
  }
  for (const fn of mod.functions) {
    issues.push(...validateFunctionNativeFrameResources(fn, bindings, mod, analysis));
    const selectedLocals = frameClosures.locals.get(fn.name) ?? new Set<string>();
    for (const local of fn.locals) {
      if (local.nativeFrameCapture === true && !selectedLocals.has(local.id)) {
        issues.push({
          message: `local "${local.name}" has an invalid frame-bounded callback capture`,
          loc: fn.loc,
        });
      }
    }
    walkExecutable(fn.body, (node) => {
      if (node.kind !== "closure") return;
      const closure = node as ClosureExpr;
      if (closure.nativeFrameContext !== true) return;
      if (!frameClosures.closures.has(closure)) {
        issues.push({
          message: `closure ${closure.fnName} has an invalid frame-bounded native callback context`,
          loc: closure.loc,
        });
        return;
      }
      for (const localId of closure.captures) {
        if (fn.locals.find((local) => local.id === localId)?.nativeFrameCapture !== true) {
          issues.push({
            message: `closure ${closure.fnName} uses a frame-bounded context without a frame capture for "${localId}"`,
            loc: closure.loc,
          });
        }
      }
    });
  }
  return issues;
}
