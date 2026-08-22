/* A TypeScript class whose base is a NATIVE class.
 *
 * `docs/native-subclassing.md` makes this the public API for a platform whose
 * application model is subclass-based: the framework constructs the object and
 * calls a member on it, so the program declares the member rather than handing
 * a function to a registration. The generated adapter and the registration are
 * internal artifacts, not the architecture a person writes.
 *
 * WHAT THIS SLICE IS. Overrides, `this`, and inherited native members, with NO
 * managed fields. That exclusion is the whole reason it can ship now: with no
 * managed state there is no second object, so `this` IS the handle cell whose
 * identity the interning map already keeps, and none of the peer's lifetime
 * question arises. An instance field is exactly what introduces that object,
 * and it refuses here by name.
 *
 * WHY IT NEEDS NO NEW IR. A lowered method's first parameter is already its
 * receiver, typed — so an override lowered with `this` typed as the native
 * handle produces exactly the signature the registration's callback takes. The
 * synthesis is then a `nativeCall` over a `closure`, both of which exist. What
 * the class form adds is spelling, which is what the document said it should
 * add.
 */
import { nativeBindingDiag, unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { IrExpr, IrFunction, IrParam, IrStmt, IrType, SrcLoc } from "../../ir/nodes.js";
import { nativeCallbackIsOwnerScoped, VOID } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { nativeBaseHandleName } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

/** A class declaration whose heritage names a native class, with the handle
 * type that base declares. Recorded at collection and lowered per file, so a
 * class in a non-entry module registers when that module evaluates. */
export interface NativeSubclass {
  readonly decl: ts.ClassDeclaration;
  readonly className: string;
  readonly handleTypeId: string;
}

/** The base's handle type, or null when this class is an ordinary one.
 *
 * Asked before ordinary collection so a native-based class never enters the
 * ClassInfo machinery at all: it has no managed base, no fields, no vtable and
 * no constructor, so every question that machinery answers is one this shape
 * does not ask. */
export function nativeSubclassOf(
  L: Lowerer,
  decl: ts.ClassDeclaration,
): NativeSubclass | null {
  const base = decl.heritageClauses
    ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types.map((type) => type.expression)
    .filter(ts.isIdentifier)[0];
  if (base === undefined || decl.name === undefined) return null;
  const handleTypeId = nativeBaseHandleName(L, base);
  if (handleTypeId === null) return null;
  return { decl, className: decl.name.text, handleTypeId };
}

/** Every member this slice refuses, each by its own reason.
 *
 * A refusal here is not a limitation of the class form — it is a member whose
 * meaning the document defers or whose machinery this slice deliberately
 * excludes, and saying which is the difference between "wait for it" and
 * "spell it another way". */
function refuseUnsupportedMembers(L: Lowerer, subclass: NativeSubclass): boolean {
  let ok = true;
  /* `pushDiag` rather than `unsupported`, which throws to poison the statement
   * it was called from. There is no statement here — this runs while the file
   * init is assembled — so a throw would escape the lowering as an error
   * instead of arriving as the diagnostic it is. Reporting every refused
   * member also beats stopping at the first: a class with a field AND a
   * constructor has two things to fix, and one build should say both. */
  const refuse = (node: ts.Node, detail: string): void => {
    ok = false;
    L.pushDiag(unsupportedDiag("SC1090", locOf(node), detail));
  };
  for (const member of subclass.decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      refuse(
        member,
        `a constructor on '${subclass.className}': the platform constructs the ` +
          "object, so there is no allocation for one to perform (see " +
          "docs/native-subclassing.md, host-owned construction)",
      );
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      refuse(
        member,
        `an instance field on '${subclass.className}': fields live in the ` +
          "managed peer, whose lifetime policy this platform has not declared " +
          "(see docs/native-subclassing.md) — a local inside the override has " +
          "no such question",
      );
      continue;
    }
    if (!ts.isMethodDeclaration(member)) {
      refuse(member, `this member of '${subclass.className}' on a native base`);
    }
  }
  return ok;
}

/** One override as its module function, with the receiver as parameter zero.
 *
 * The same construction an ordinary method gets, differing only in what `this`
 * is: a native handle rather than a managed object. That is what makes the
 * lowered function directly usable as the registration's callback. */
function lowerOverride(
  L: Lowerer,
  subclass: NativeSubclass,
  member: ts.MethodDeclaration,
  name: string,
): IrFunction | null {
  if (member.body === undefined) return null;
  const thisType: IrType = { kind: "nativeHandle", typeId: subclass.handleTypeId };
  const shapes = L.paramShapes(member.parameters);
  L.pushFnCtx(VOID);
  try {
    const thisLocal = L.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const declared = L.declareParams(member.parameters, shapes);
    params.push(...declared.params);
    const body: IrStmt[] = [
      ...declared.prologue,
      ...L.lowerStmts(member.body.statements),
    ];
    return {
      name,
      params,
      returnType: VOID,
      locals: L.ctx.locals,
      body,
      /* Empty but PRESENT: a closure target receives its environment as the
       * first C parameter, and the trampoline passes one whether or not the
       * body reads it. Omitting the field shifts every argument by one — the
       * closure lands where `this` is read, which is a segfault rather than a
       * diagnostic. */
      captures: [],
      loc: locOf(member),
    };
  } finally {
    L.popFnCtx();
  }
}

/** The registration statements for one file's native subclasses, pushing each
 * override's function onto the module's list.
 *
 * The call synthesized here is the one a program writes by hand today —
 * `Ticker.onTick(handler)` — which is why this needs no new IR node and no
 * contract change. The binding is found by the member's declaration identity,
 * `Class.member`, because that is what the packager generated and ingested. */
export function lowerNativeSubclassRegistrations(
  L: Lowerer,
  subclasses: readonly NativeSubclass[],
): IrStmt[] {
  const statements: IrStmt[] = [];
  for (const subclass of subclasses) {
    if (!refuseUnsupportedMembers(L, subclass)) continue;
    for (const member of subclass.decl.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const memberName = member.name.text;
      const declaredName = `${subclass.className}.${memberName}`;
      const binding = L.nativeBindingByDeclaredName(declaredName);
      if (binding === null) {
        /* The generated class does not declare this member. That is a
         * SELECTION problem — the packager produced a class without it — and
         * naming the identity it looked for is what lets someone fix the
         * selection rather than the program. */
        L.pushDiag(unsupportedDiag(
          "SC1090",
          locOf(member),
          `'${memberName}' overrides nothing on the native base: no binding ` +
            `declares '${declaredName}'`,
        ));
        continue;
      }
      const fnName = `%${subclass.className}.${memberName}`;
      const fn = lowerOverride(L, subclass, member, fnName);
      if (fn === null) continue;
      L.nativeOverrideFunctions.push(fn);
      /* The only reference to this function is the closure synthesized below,
       * which no reachability walk saw because the program never wrote it.
       * Without the edge it is stripped and the closure names a function the
       * module does not carry — the same shape as a payload destructor reached
       * only through a contract. */
      L.noteEdge(fn.name);
      const loc: SrcLoc = locOf(member);
      const callbackType = binding.arguments[0]?.type;
      if (callbackType === undefined || callbackType.kind !== "func") {
        L.pushDiag(nativeBindingDiag(
          binding.id,
          "a native override registration takes exactly one callback argument",
          loc,
        ));
        continue;
      }
      const handler: IrExpr = {
        kind: "closure",
        fnName,
        captures: [],
        type: { kind: "func", params: fn.params.map((param) => param.type), ret: VOID },
        loc,
      };
      statements.push({
        kind: "exprStmt",
        expr: {
          kind: "nativeCall",
          binding: binding.id,
          args: [handler],
          type: VOID,
          loc,
        },
        loc,
      });
      L.usesNativeTarget = true;
      L.usedNativeBindingIds.add(binding.id);
      /* Everything the CONTRACT reaches, which an ordinary lowered call marks
       * on the way through and a synthesized one otherwise does not. A payload
       * destructor is named by the contract and by nothing else — the program
       * never writes it — so without this the emitter asks for a binding the
       * module stripped, and the same is true of the payload's own nominal
       * type and of the binding that cancels an owner-scoped registration. */
      const contract = binding.arguments[0]?.callback;
      if (contract !== undefined) {
        for (const source of contract.sourceArguments ?? []) {
          if (source.kind === "callback-parameter" && source.destructor !== undefined) {
            L.usedNativeBindingIds.add(source.destructor);
          }
        }
        if (nativeCallbackIsOwnerScoped(contract)) {
          L.usedNativeBindingIds.add(contract.cancellationBinding);
        }
      }
      for (const parameter of callbackType.params) {
        if (parameter.kind === "nativeHandle" || parameter.kind === "nullableNativeHandle") {
          L.useNativeType(parameter.typeId);
        }
      }
      L.useNativeType(subclass.handleTypeId);
    }
  }
  return statements;
}
