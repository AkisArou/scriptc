import type { IrExpr, IrFunction, IrModule, IrNativeBinding, IrStmt, SrcLoc } from "./nodes.js";

interface FrameCandidate {
  readonly localId: string;
  readonly declaration: Extract<IrStmt, { kind: "varDecl" }>;
  readonly call: Extract<IrExpr, { kind: "nativeCall" }>;
  readonly release: string;
}

interface WalkParent {
  readonly node: { readonly kind: string };
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
  const owner = typeof kind === "string" ? { node: record as { kind: string } } : parent;
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
      local?.type.kind !== "nativeHandle" ||
      local.mutable ||
      local.boxed === true ||
      init?.kind !== "nativeCall" ||
      init.type.kind !== "nativeHandle" ||
      init.type.typeId !== local.type.typeId
    ) {
      continue;
    }
    const binding = bindings.get(init.binding);
    if (binding === undefined) continue;
    const frame = binding.result.frameBounded;
    if (
      frame === undefined ||
      binding.result.type.kind !== "nativeHandle" ||
      binding.result.type.typeId !== local.type.typeId ||
      binding.result.ownership.kind !== "owned" ||
      binding.result.ownership.transfer !== "to-runtime" ||
      binding.result.projection.kind !== "direct" ||
      binding.arguments.some((argument) => argument.callback?.owner.kind === "result")
    ) {
      continue;
    }
    candidates.set(localId, {
      localId,
      declaration: declaration!,
      call: init,
      release: frame.release.symbol,
    });
  }

  const escaped = new Set<string>();
  walkExecutable(fn.body, (node, parent) => {
    if (node.kind !== "varRef") return;
    const localId = (node as Extract<IrExpr, { kind: "varRef" }>).localId;
    if (!candidates.has(localId)) return;
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

/** Select the first conservative frame-bounded slice: immutable, unboxed
 * locals initialized directly by a capable handle result, with every use as
 * a whole synchronous borrowed native argument. Everything else remains on
 * the stable path. */
export function specializeNativeFrameResources(mod: IrModule): void {
  const bindings = new Map((mod.nativeBindings ?? []).map((binding) => [binding.id, binding]));
  for (const fn of mod.functions) {
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const candidate of candidatesFor(fn, bindings).values()) {
      locals.get(candidate.localId)!.nativeFrame = { release: candidate.release };
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
): NativeFrameResourceIssue[] {
  const issues: NativeFrameResourceIssue[] = [];
  const candidates = candidatesFor(fn, bindings);
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
      candidate.release !== local.nativeFrame.release ||
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
