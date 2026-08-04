import type { IrExpr, IrFunction, IrModule, IrStmt } from "./nodes.js";

/** Mark reads of local arrays that cannot acquire a hole. This deliberately
 * rejects aliases and unfamiliar operations: a missed optimization is safe,
 * while a false positive would turn a required hole trap into a value read. */
export function markDenseArrayReads(mod: IrModule): void {
  for (const fn of mod.functions) markFunction(fn);
}

function markFunction(fn: IrFunction): void {
  const candidates = new Set(fn.locals.filter((l) => l.type.kind === "array" && !l.boxed).map((l) => l.id));
  const initialized = new Set<string>();
  const reads = new Map<string, Extract<IrExpr, { kind: "arrayGet" }>[]>();

  const invalidate = (id: string): void => { candidates.delete(id); };
  const directCandidate = (e: IrExpr): string | null =>
    e.kind === "varRef" && candidates.has(e.localId) ? e.localId : null;

  const opaque = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(opaque);
    } else if (value !== null && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (typeof node.kind === "string" && "type" in node && "loc" in node) {
        expr(node as IrExpr);
        return;
      }
      if (node.kind === "varRef" && typeof node.localId === "string") {
        invalidate(node.localId);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== "kind" && key !== "type" && key !== "loc") opaque(child);
      }
    }
  };

  const expr = (e: IrExpr): void => {
    if (e.kind === "varRef") {
      invalidate(e.localId);
      return;
    }
    if (e.kind === "arrayGet") {
      const id = directCandidate(e.arr);
      if (id !== null) {
        const list = reads.get(id) ?? [];
        list.push(e);
        reads.set(id, list);
        opaque(e.index);
        return;
      }
    }
    if (e.kind === "arrayHas") {
      const id = directCandidate(e.arr);
      if (id !== null) {
        opaque(e.index);
        return;
      }
    }
    if (e.kind === "arrIntrinsic") {
      const id = directCandidate(e.receiver);
      // All intrinsic methods except these two preserve density when their
      // receiver starts dense. Sparse sources can introduce holes.
      if (id !== null) {
        if (e.method === "pushSpread" || e.method === "appendSparse") invalidate(id);
        e.args.forEach(opaque);
        return;
      }
    }
    for (const [key, child] of Object.entries(e)) {
      if (key !== "kind" && key !== "type" && key !== "loc") opaque(child);
    }
  };

  const stmts = (body: IrStmt[]): void => {
    for (const s of body) {
      switch (s.kind) {
        case "varDecl":
          if (candidates.has(s.localId) && s.init?.kind === "arrayLit" && !s.init.holes?.length && !s.init.spreads?.length) {
            initialized.add(s.localId);
            s.init.elems.forEach(opaque);
          } else if (s.init) expr(s.init);
          break;
        case "assign":
          invalidate(s.localId);
          expr(s.value);
          break;
        case "exprStmt": expr(s.expr); break;
        case "arraySet": {
          const id = directCandidate(s.arr);
          // A dynamic index can now grow past length and introduce holes.
          // Without a range proof, later reads must inspect presence.
          if (id !== null) invalidate(id);
          else expr(s.arr);
          expr(s.index);
          expr(s.value);
          break;
        }
        case "arrayDelete": {
          const id = directCandidate(s.arr);
          if (id !== null) invalidate(id);
          else expr(s.arr);
          expr(s.index);
          break;
        }
        case "arraySetLength": {
          const id = directCandidate(s.arr);
          if (id !== null) invalidate(id);
          else expr(s.arr);
          expr(s.length);
          break;
        }
        case "if": expr(s.cond); stmts(s.then); if (s.else_) stmts(s.else_); break;
        case "while": expr(s.cond); stmts(s.body); break;
        case "doWhile": stmts(s.body); expr(s.cond); break;
        case "for": if (s.init) stmts([s.init]); if (s.cond) expr(s.cond); if (s.update) stmts([s.update]); stmts(s.body); break;
        case "switch": expr(s.disc); s.cases.forEach((c) => { if (c.test) expr(c.test); stmts(c.body); }); break;
        case "forOf": {
          const id = directCandidate(s.iterable);
          if (id === null) expr(s.iterable);
          stmts(s.body);
          break;
        }
        case "block": stmts(s.body); break;
        case "tryCatch": stmts(s.tryBody); if (s.catchBody) stmts(s.catchBody); if (s.finallyBody) stmts(s.finallyBody); break;
        case "return": if (s.value) expr(s.value); break;
        case "throw": expr(s.value); break;
        default: opaque(s);
      }
    }
  };

  stmts(fn.body);
  for (const id of candidates) {
    if (initialized.has(id)) {
      for (const read of reads.get(id) ?? []) read.dense = true;
    }
  }
}
