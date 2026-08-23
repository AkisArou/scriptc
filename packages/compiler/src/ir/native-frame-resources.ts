import {
  nullableNativeHandleUnion,
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
  readonly resource: IrNativeFrameResource;
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
    if (binding === undefined) continue;
    const frame = binding.result.frameBounded;
    if (
      frame === undefined ||
      binding.result.type.kind !== "nativeHandle" ||
      binding.result.ownership.kind !== "owned" ||
      binding.result.ownership.transfer !== "to-runtime" ||
      binding.arguments.some((argument) => argument.callback?.owner.kind === "result")
    ) {
      continue;
    }
    let resource: IrNativeFrameResource;
    if (
      binding.result.projection.kind === "direct" &&
      local.type.kind === "nativeHandle" &&
      init.type.kind === "nativeHandle" &&
      binding.result.type.typeId === local.type.typeId &&
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
        binding.result.type.typeId,
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
      resource,
    });
  }

  const escaped = new Set<string>();
  walkExecutable(fn.body, (node, parent) => {
    if (node.kind !== "varRef") return;
    const localId = (node as Extract<IrExpr, { kind: "varRef" }>).localId;
    if (!candidates.has(localId)) return;
    const candidate = candidates.get(localId)!;
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
        const call = parent?.parent?.node.kind === "nativeCall"
          ? parent.parent.node as Extract<IrExpr, { kind: "nativeCall" }>
          : null;
        const argumentIndex = call?.args.indexOf(narrow) ?? -1;
        if (
          narrow.value === node &&
          narrow.unionId === nullable.unionId &&
          narrow.tag === nullable.handleTag &&
          argumentIndex >= 0 &&
          borrowedHandleArgument(bindings.get(call!.binding), argumentIndex)
        ) {
          return;
        }
      }
      escaped.add(localId);
      return;
    }
    const call = parent?.node.kind === "nativeCall"
      ? parent.node as Extract<IrExpr, { kind: "nativeCall" }>
      : null;
    const argumentIndex = call?.args.indexOf(node as IrExpr) ?? -1;
    if (argumentIndex < 0 || !borrowedHandleArgument(bindings.get(call!.binding), argumentIndex)) {
      escaped.add(localId);
    }
  });
  for (const localId of escaped) candidates.delete(localId);
  return candidates;
}

/** Select the conservative frame-bounded slice: immutable, unboxed locals
 * initialized directly by a capable handle result, with every use as a whole
 * synchronous borrowed native argument or, for nullable handles, an exact
 * null/handle tag test. Everything else remains on the stable path. */
export function specializeNativeFrameResources(mod: IrModule): void {
  const bindings = new Map((mod.nativeBindings ?? []).map((binding) => [binding.id, binding]));
  for (const fn of mod.functions) {
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const candidate of candidatesFor(fn, bindings, mod).values()) {
      locals.get(candidate.localId)!.nativeFrame = candidate.resource;
      candidate.call.resultMode = "frameBounded";
    }
  }
}

export interface NativeFrameResourceIssue {
  readonly message: string;
  readonly loc: SrcLoc;
}

/** Backstop for deserialized or hand-built IR: a frame marker is valid only
 * as the paired initializer/local facts the specialization pass can prove. */
export function validateNativeFrameResources(
  fn: IrFunction,
  bindings: ReadonlyMap<string, IrNativeBinding>,
  mod: Pick<IrModule, "unions">,
): NativeFrameResourceIssue[] {
  const issues: NativeFrameResourceIssue[] = [];
  const candidates = candidatesFor(fn, bindings, mod);
  const annotatedCalls = new Set<Extract<IrExpr, { kind: "nativeCall" }>>();
  walkExecutable(fn.body, (node) => {
    if (node.kind !== "nativeCall") return;
    const call = node as Extract<IrExpr, { kind: "nativeCall" }>;
    if (call.resultMode === "frameBounded") annotatedCalls.add(call);
  });
  for (const local of fn.locals) {
    if (local.nativeFrame === undefined) continue;
    const candidate = candidates.get(local.id);
    if (
      candidate === undefined ||
      candidate.resource.release !== local.nativeFrame.release ||
      candidate.resource.nullable?.unionId !== local.nativeFrame.nullable?.unionId ||
      candidate.resource.nullable?.handleTag !== local.nativeFrame.nullable?.handleTag ||
      candidate.resource.nullable?.nullTag !== local.nativeFrame.nullable?.nullTag ||
      candidate.call.resultMode !== "frameBounded"
    ) {
      issues.push({
        message: `local "${local.name}" has an invalid frame-bounded native resource`,
        loc: candidate?.declaration.loc ?? fn.loc,
      });
      continue;
    }
    annotatedCalls.delete(candidate.call);
  }
  for (const call of annotatedCalls) {
    issues.push({
      message: `Native IR call ${call.binding} selects a frame-bounded result outside an eligible local`,
      loc: call.loc,
    });
  }
  return issues;
}
