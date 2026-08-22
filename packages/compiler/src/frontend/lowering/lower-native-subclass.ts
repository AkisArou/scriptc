/* A TypeScript class whose base is a NATIVE class.
 *
 * `docs/native-subclassing.md` makes this the public API for a platform whose
 * application model is subclass-based: the framework constructs the object and
 * calls a member on it, so the program declares the member rather than handing
 * a function to a registration. The generated adapter and the registration are
 * internal artifacts, not the architecture a person writes.
 *
 * A subclass without fields stays the cheap shape: its callback receiver is
 * `this` and no managed object exists. A subclass with fields uses an ordinary
 * ScriptC class as its peer. The generated foreign object carries only the
 * peer association; the registration roots the peer until its stated terminal
 * dispatch, and the peer's hidden field keeps one delivered handle alive for
 * inherited calls outside a dispatch.
 *
 * It does NOT rest on the interning map. Only `pointer`-identity handles
 * intern, and a JVM handle declares `identity: "none"` because `NewGlobalRef`
 * twice on one object yields two distinct `jobject`s — so on the platform this
 * exists for, every dispatch builds a fresh cell. That is indistinguishable
 * from one cell per object precisely while no field exists to compare across
 * dispatches, which is the same boundary the refusal draws.
 *
 * The peer attach/detach operations are explicit IR because only the compiler
 * can connect a managed object and the opaque slot without projecting that
 * pointer into the source language.
 */
import { nativeBindingDiag, unsupportedDiag } from "../../diagnostics/diagnostic.js";
import type { IrExpr, IrFunction, IrParam, IrStmt, IrType, SrcLoc } from "../../ir/nodes.js";
import { nativeCallbackIsOwnerScoped, VOID } from "../../ir/nodes.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { nativeBaseHandleName, nativeBaseSymbol } from "./lower-classes.js";
import { lowerNativeBaseCall, type NativeInputBinding } from "./lower-native.js";
import type { Lowerer } from "./lowerer.js";

/** A class declaration whose heritage names a native class, with the handle
 * type that base declares. Recorded at collection and lowered per file, so a
 * class in a non-entry module registers when that module evaluates. */
export interface NativeSubclass {
  readonly decl: ts.ClassDeclaration;
  readonly className: string;
  readonly handleTypeId: string;
}

/** What a class's base turned out to be.
 *
 * Three answers rather than a handle type and null, because "the base is an
 * ordinary managed class" and "the base came from the native surface and that
 * surface maps no handle type to it" are opposite situations that a null
 * cannot tell apart. Reading them as one is how a class that overrides nothing
 * used to compile in silence. */
export type NativeBase =
  | { readonly kind: "managed" }
  | { readonly kind: "native"; readonly subclass: NativeSubclass }
  | { readonly kind: "unmapped"; readonly base: ts.Identifier; readonly detail: string };

/** Files the native surface draws TYPES from — the declaration files that
 * describe a native package.
 *
 * A base declared in one of them is a native base whatever the input says
 * about it, which is what lets an unresolved one be told apart from
 * `class MyError extends Error`: `Error` is ambient too, but nothing in the
 * native surface is declared beside it. Computed once because a large surface
 * is thousands of types and this is asked per class declaration. */
function nativeSurfaceFiles(L: Lowerer): ReadonlySet<ts.SourceFile> {
  if (L.nativeSurfaceFilesCache !== null) return L.nativeSurfaceFilesCache;
  const files = new Set<ts.SourceFile>();
  for (const symbol of L.nativeTypesBySymbol.keys()) {
    for (const declaration of L.checker.declarationsOf(symbol)) {
      files.add(declaration.getSourceFile());
    }
  }
  L.nativeSurfaceFilesCache = files;
  return files;
}

/** What this class extends.
 *
 * Asked before ordinary collection so a native-based class never enters the
 * ClassInfo machinery at all: it has no managed base, no fields, no vtable and
 * no constructor, so every question that machinery answers is one this shape
 * does not ask. */
export function nativeBaseOf(L: Lowerer, decl: ts.ClassDeclaration): NativeBase {
  const base = decl.heritageClauses
    ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types.map((type) => type.expression)
    .filter(ts.isIdentifier)[0];
  if (base === undefined || decl.name === undefined) return { kind: "managed" };
  const handleTypeId = nativeBaseHandleName(L, base);
  if (handleTypeId !== null) {
    return {
      kind: "native",
      subclass: { decl, className: decl.name.text, handleTypeId },
    };
  }
  const resolved = nativeBaseSymbol(L, base);
  if (resolved === null) return { kind: "managed" };
  const declaredBySurface = L.checker
    .declarationsOf(resolved)
    .some((declaration) => nativeSurfaceFiles(L).has(declaration.getSourceFile()));
  if (!declaredBySurface) return { kind: "managed" };
  /* The surface declares the class and maps no HANDLE type to it — either no
   * type at all, or one that names a value the boundary copies rather than an
   * object a platform constructs and dispatches on. The message does not
   * distinguish them because the answer is the same either way and only one of
   * the two is reachable from source today; claiming to tell them apart would
   * be a branch no program can take.
   *
   * Either way the SELECTION is short a type, not the program, which is why
   * the message names the surface rather than the class that extends it. */
  return {
    kind: "unmapped",
    base,
    detail: `'${base.text}' is declared by a native surface that maps no handle ` +
      "type to it, so nothing names the object an override would receive",
  };
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
      const isStatic = ts.getModifiers(member)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      ) === true;
      if (isStatic) refuse(member, `a static field on '${subclass.className}'`);
      continue;
    }
    if (!ts.isMethodDeclaration(member)) {
      refuse(member, `this member of '${subclass.className}' on a native base`);
    }
  }
  return ok;
}

/** The override being lowered, so `super.m(...)` inside it can find the binding
 * that reaches the base. A native-based class has no ClassInfo, so the ordinary
 * super path — which walks a managed base chain — has nothing to walk. */
export interface NativeOverrideContext {
  readonly subclass: NativeSubclass;
  readonly receiverLocalId: string;
  /* What the receiver IS, which is the registration's answer rather than the
   * declared base's. Carried because `super` reads the same local and must
   * agree with how it was declared — a varRef whose type disagrees with its
   * binding is an internal compiler error, and the two disagree exactly when
   * the generated class is below the base the program named. */
  readonly receiverType: IrType;
  readonly baseCall: string | undefined;
}

type NativeCallbackType = Extract<
  NativeInputBinding["arguments"][number]["type"],
  { readonly kind: "func" }
>;

/** `super.m(args)` inside an override of a native base.
 *
 * The manifest names the binding that reaches the base; everything after that
 * is the ordinary native invocation, so a base call is validated and projected
 * exactly like the call a program writes by hand.
 */
export function lowerNativeSuperCall(
  L: Lowerer,
  context: NativeOverrideContext,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = access.name.text;
  if (context.baseCall === undefined) {
    /* No base implementation to reach, which is what an abstract or interface
     * member looks like — a different fact from "super is unsupported", and
     * the reason the manifest carries the link rather than a convention. */
    L.pushDiag(unsupportedDiag(
      "SC1090",
      locOf(call),
      `'super.${member}()' on '${context.subclass.className}': the manifest ` +
        "records no base call for this member",
    ));
    return null;
  }
  return lowerNativeBaseCall(L, context.baseCall, call, access);
}

/** One override as its module function, with the receiver as parameter zero.
 *
 * The same construction an ordinary method gets, differing only in what `this`
 * is: a native handle rather than a managed object. That is what makes the
 * lowered function directly usable as the registration's callback.
 *
 * `thisType` comes from the REGISTRATION, not from the declared base. A
 * class-anchored registration answers for every instance of the class the
 * packager generated, so the receiver it delivers is that class — while
 * `extends Activity` names an ANCESTOR, which is a different type and a
 * weaker statement. Typing `this` from the base produced a handler the
 * registration could not accept, and the mismatch surfaced as an internal
 * compiler error rather than as anything a reader could act on. */
function lowerOverride(
  L: Lowerer,
  subclass: NativeSubclass,
  member: ts.MethodDeclaration,
  name: string,
  baseCall: string | undefined,
  thisType: IrType,
  terminal: boolean,
): IrFunction | null {
  if (member.body === undefined) return null;
  const shapes = L.paramShapes(member.parameters);
  L.pushFnCtx(VOID);
  const previousOverride = L.currentNativeOverride;
  const previousClass = L.currentClass;
  try {
    const peerInfo = L.classes.get(subclass.className);
    const peer = peerInfo?.nativePeer;
    const receiverLocal = peer === undefined
      ? L.declareThis(thisType)
      : {
          id: "nativeReceiver.0",
          name: "nativeReceiver",
          type: thisType,
          mutable: false,
        };
    if (peer !== undefined) L.ctx.locals.push(receiverLocal);
    const params: IrParam[] = [{
      localId: receiverLocal.id,
      name: peer === undefined ? "this" : "nativeReceiver",
      type: thisType,
    }];
    const thisLocal = peer === undefined
      ? receiverLocal
      : L.declareThis({ kind: "object", className: subclass.className });
    const declared = L.declareParams(member.parameters, shapes);
    params.push(...declared.params);
    /* Set for the BODY only: `super` means this override's receiver while
     * lowering it, and means nothing anywhere else. Saved and restored rather
     * than cleared, because an override's body may contain another class. */
    L.currentNativeOverride = {
      subclass,
      receiverLocalId: receiverLocal.id,
      receiverType: thisType,
      baseCall,
    };
    if (peerInfo !== undefined) L.currentClass = peerInfo;
    const loweredBody: IrStmt[] = [
      ...declared.prologue,
      ...L.lowerStmts(member.body.statements),
    ];
    const body: IrStmt[] = peer === undefined
      ? loweredBody
      : [
          {
            kind: "varDecl",
            localId: thisLocal.id,
            init: {
              kind: "nativePeerAttach",
              handle: {
                kind: "varRef",
                localId: receiverLocal.id,
                type: thisType,
                loc: locOf(member),
              },
              className: subclass.className,
              handleTypeId: thisType.kind === "nativeHandle"
                ? thisType.typeId
                : subclass.handleTypeId,
              type: { kind: "object", className: subclass.className },
              loc: locOf(member),
            },
            loc: locOf(member),
          },
          ...(terminal
            ? [{
                kind: "tryCatch" as const,
                tryBody: loweredBody,
                catchBody: null,
                catchLocalId: null,
                finallyBody: [{
                  kind: "nativePeerDetach" as const,
                  handle: {
                    kind: "varRef" as const,
                    localId: receiverLocal.id,
                    type: thisType,
                    loc: locOf(member),
                  },
                  className: subclass.className,
                  handleTypeId: thisType.kind === "nativeHandle"
                    ? thisType.typeId
                    : subclass.handleTypeId,
                  loc: locOf(member),
                }],
                loc: locOf(member),
              }]
            : loweredBody),
        ];
    if (peer !== undefined) L.noteEdge(`%${subclass.className}.constructor`);
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
    L.currentNativeOverride = previousOverride;
    L.currentClass = previousClass;
    L.popFnCtx();
  }
}

/** The terminal hook when the source class does not declare one.
 *
 * The platform selection still generates and registers the override: peer
 * teardown is a platform lifetime rule, not something a program may forget by
 * omitting `onDestroy`. With no source body to run, the honest implementation
 * is the base implementation followed by the same finally-detach an explicit
 * override receives. */
function lowerSyntheticTerminal(
  L: Lowerer,
  subclass: NativeSubclass,
  binding: NativeInputBinding,
  callbackType: NativeCallbackType,
): IrFunction | null {
  const loc = locOf(subclass.decl);
  const peerInfo = L.classes.get(subclass.className);
  const peer = peerInfo?.nativePeer;
  if (peer === undefined) return null;
  if (binding.baseCall === undefined) {
    L.pushDiag(nativeBindingDiag(
      binding.id,
      "a synthetic terminal override requires the stated base call it forwards to",
      loc,
    ));
    return null;
  }
  const base = (L.nativeInput?.bindings ?? []).find(
    (candidate) => candidate.id === binding.baseCall,
  );
  if (base === undefined) {
    L.pushDiag(nativeBindingDiag(
      binding.id,
      `names missing synthetic terminal base call '${binding.baseCall}'`,
      loc,
    ));
    return null;
  }
  if (
    base.arguments.length !== callbackType.params.length ||
    base.result.type.kind !== "void" ||
    base.result.projection.kind !== "direct"
  ) {
    L.pushDiag(nativeBindingDiag(
      binding.id,
      "a synthetic terminal override must forward the callback's complete parameter list to a direct void base call",
      loc,
    ));
    return null;
  }
  const parameterTypes: IrType[] = [];
  for (const parameter of callbackType.params) {
    if (parameter.kind !== "nativeScalar" && parameter.kind !== "nativeHandle") {
      L.pushDiag(nativeBindingDiag(
        binding.id,
        "a synthetic terminal override can forward only exact scalar and native handle payloads",
        loc,
      ));
      return null;
    }
    parameterTypes.push(parameter);
  }

  L.pushFnCtx(VOID);
  const previousClass = L.currentClass;
  try {
    const params: IrParam[] = parameterTypes.map((type, index) => {
      const local = {
        id: `nativeTerminal.${index}`,
        name: index === 0 ? "nativeReceiver" : `a${index - 1}`,
        type,
        mutable: false,
      };
      L.ctx.locals.push(local);
      return { localId: local.id, name: local.name, type };
    });
    const receiver = params[0];
    if (receiver === undefined || receiver.type.kind !== "nativeHandle") {
      L.pushDiag(nativeBindingDiag(
        binding.id,
        "a synthetic terminal override must receive its native handle first",
        loc,
      ));
      return null;
    }
    const thisLocal = L.declareThis({ kind: "object", className: subclass.className });
    L.currentClass = peerInfo ?? null;
    const args: IrExpr[] = params.map((param, index) => {
      const value: IrExpr = {
        kind: "varRef",
        localId: param.localId,
        type: param.type,
        loc,
      };
      const expected = base.arguments[index]!.type;
      return value.type.kind === "nativeHandle" &&
          expected.kind === "nativeHandle" &&
          value.type.typeId !== expected.typeId
        ? {
            kind: "upcast",
            value,
            type: { kind: "nativeHandle", typeId: expected.typeId },
            loc,
          }
        : value;
    });
    L.noteEdge(`%${subclass.className}.constructor`);
    L.usedNativeBindingIds.add(base.id);
    for (const param of callbackType.params) {
      if (param.kind === "nativeHandle") {
        L.useNativeType(param.typeId);
      }
    }
    for (const argument of base.arguments) {
      if (argument.type.kind === "nativeHandle" || argument.type.kind === "nullableNativeHandle") {
        L.useNativeType(argument.type.typeId);
      }
    }
    return {
      name: `%${subclass.className}.%terminal`,
      params,
      returnType: VOID,
      locals: L.ctx.locals,
      body: [{
        kind: "varDecl",
        localId: thisLocal.id,
        init: {
          kind: "nativePeerAttach",
          handle: {
            kind: "varRef",
            localId: receiver.localId,
            type: receiver.type,
            loc,
          },
          className: subclass.className,
          handleTypeId: receiver.type.typeId,
          type: { kind: "object", className: subclass.className },
          loc,
        },
        loc,
      }, {
        kind: "tryCatch",
        tryBody: [{
          kind: "exprStmt",
          expr: { kind: "nativeCall", binding: base.id, args, type: VOID, loc },
          loc,
        }],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [{
          kind: "nativePeerDetach",
          handle: {
            kind: "varRef",
            localId: receiver.localId,
            type: receiver.type,
            loc,
          },
          className: subclass.className,
          handleTypeId: receiver.type.typeId,
          loc,
        }],
        loc,
      }],
      captures: [],
      loc,
    };
  } finally {
    L.currentClass = previousClass;
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
    const peerInfo = L.classes.get(subclass.className);
    const peer = peerInfo?.nativePeer;
    let terminalBinding: NativeInputBinding | undefined;
    if (peer !== undefined) {
      terminalBinding = (L.nativeInput?.bindings ?? []).find(
        (binding) =>
          binding.terminal === true &&
          binding.declaration.name.startsWith(`${subclass.className}.`),
      );
      if (terminalBinding === undefined) {
        L.pushDiag(unsupportedDiag(
          "SC1090",
          locOf(subclass.decl),
          `instance fields on '${subclass.className}': the platform selection ` +
            "declares no terminal event to release the managed peer",
        ));
        continue;
      }
    }
    let sourceDeclaresTerminal = false;
    const appendRegistration = (
      binding: NativeInputBinding,
      callbackType: NativeCallbackType,
      fn: IrFunction,
      loc: SrcLoc,
    ): void => {
      L.nativeOverrideFunctions.push(fn);
      /* The only reference to this function is the closure synthesized below,
       * which no reachability walk saw because the program never wrote it. */
      L.noteEdge(fn.name);
      const handler: IrExpr = {
        kind: "closure",
        fnName: fn.name,
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
    };
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
      /* Parameter zero is the receiver — the shape a class-anchored
       * registration has, and the one an override lowers into with no adapter
       * between. Nothing in the metadata marks it as the receiver rather than
       * a first payload; that is the same convention the registration itself
       * rests on, not a new assumption introduced here. */
      const thisType = callbackType.params[0];
      if (thisType === undefined || thisType.kind !== "nativeHandle") {
        L.pushDiag(nativeBindingDiag(
          binding.id,
          "a native override registration delivers the receiver as the " +
            "callback's first parameter, which must be a native handle",
          loc,
        ));
        continue;
      }
      if (peer !== undefined) {
        /* The slot belongs to the DELIVERED receiver, not necessarily to the
         * base named in `extends`. On Android that distinction is concrete:
         * source extends Activity while the generated MainActivity owns the
         * field. Reading the base here made a correct platform package look
         * slotless and, worse, let a same-type fixture conceal the mistake. */
        const receiver = L.nativeTypeDefsById.get(thisType.typeId);
        if (receiver?.kind !== "handle" || receiver.peerSlot === undefined) {
          L.pushDiag(unsupportedDiag(
            "SC1090",
            locOf(member),
            `instance fields on '${subclass.className}': the delivered native ` +
              "receiver declares no managed peer slot",
          ));
          continue;
        }
        L.usedNativeBindingIds.add(receiver.peerSlot.read);
        L.usedNativeBindingIds.add(receiver.peerSlot.write);
      }
      const fnName = `%${subclass.className}.${memberName}`;
      const fn = lowerOverride(
        L,
        subclass,
        member,
        fnName,
        binding.baseCall,
        thisType,
        binding.terminal === true,
      );
      if (fn === null) continue;
      if (binding.terminal === true) sourceDeclaresTerminal = true;
      appendRegistration(binding, callbackType, fn, loc);
      /* Both the receiver's own type and the declared base's: the receiver is
       * what arrives, and the base is what a `super` call upcasts to. */
      L.useNativeType(thisType.typeId);
    }
    if (peer !== undefined && terminalBinding !== undefined && !sourceDeclaresTerminal) {
      const loc = locOf(subclass.decl);
      const callbackType = terminalBinding.arguments[0]?.type;
      if (callbackType === undefined || callbackType.kind !== "func") {
        L.pushDiag(nativeBindingDiag(
          terminalBinding.id,
          "a native terminal registration takes exactly one callback argument",
          loc,
        ));
        continue;
      }
      const terminalReceiver = callbackType.params[0];
      const terminalReceiverDef = terminalReceiver?.kind === "nativeHandle"
        ? L.nativeTypeDefsById.get(terminalReceiver.typeId)
        : undefined;
      if (
        terminalReceiverDef?.kind !== "handle" ||
        terminalReceiverDef.peerSlot === undefined
      ) {
        L.pushDiag(unsupportedDiag(
          "SC1090",
          loc,
          `instance fields on '${subclass.className}': the delivered terminal ` +
            "receiver declares no managed peer slot",
        ));
        continue;
      }
      L.usedNativeBindingIds.add(terminalReceiverDef.peerSlot.read);
      L.usedNativeBindingIds.add(terminalReceiverDef.peerSlot.write);
      const fn = lowerSyntheticTerminal(L, subclass, terminalBinding, callbackType);
      if (fn !== null) appendRegistration(terminalBinding, callbackType, fn, loc);
    }
  }
  return statements;
}
