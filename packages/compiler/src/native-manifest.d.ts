/* The native manifest format the compiler consumes — one declaration, owned
 * here, and the only place any of it is stated.
 *
 * An embedder describes native semantics with these types and the compiler
 * lowers them; nothing else in the pipeline may declare the same vocabulary in
 * its own words. That rule is why this module is separate from the IR it
 * belongs to: a downstream generator has to name these shapes in order to
 * produce them, and a generator that names them independently is one more
 * place the format can be described differently. Investigation record 0006
 * measures what that cost before this file existed.
 *
 * Two constraints make the file importable from outside this package's build,
 * and both are load-bearing rather than stylistic:
 *
 *   - It IMPORTS NOTHING, so a consumer that pulls this in does not thereby
 *     pull in the compiler's source graph.
 *   - It DECLARES NO RUNTIME VALUE, so the import erases and a consumer needs
 *     no build of this package to typecheck against it. A predicate over these
 *     types is a rule rather than a format, and belongs with the validator
 *     that enforces it.
 *
 * `test/native-manifest.test.ts` holds the file to both mechanically, because
 * breaking either one breaks a clean checkout of a consumer rather than
 * anything here.
 */

/** The typed-array element kinds with a runtime representation: exactly
 * the constructors real CLI code reaches (Uint8Array/Buffer, Uint32Array,
 * Int32Array — the Atomics.wait sleep idiom's array — Float32Array). The
 * other TypedArray flavors stay frontend-fenced. */
export type IrBytesElem = "u8" | "u32" | "i32" | "f32";

export interface IrBytesType {
  kind: "bytes";
  elem: IrBytesElem;
}

/** Exact, non-JavaScript integer representations carried by the boundary.
 * Each name fixes signedness, width, and value semantics; none passes through
 * the JavaScript f64 carrier.
 *
 * Spelled out rather than derived from the IR's own array, because deriving it
 * would make this module depend on a runtime value and a consumer would then
 * need this package built in order to typecheck. `IR_NATIVE_INTEGER_SCALARS`
 * is checked against this union instead, so the two cannot drift. */
export type IrNativeIntegerScalar =
  | "i8"
  | "u8"
  | "i16"
  | "u16"
  | "i32"
  | "u32"
  | "i64"
  | "u64"
  | "isize"
  | "usize";

/** `f32` is an ABI carrier and nothing else. A 32-bit float has no exact
 * source form here — no literal, no arithmetic, no branded type — because
 * ScriptC's float slice is binary64 and admitting a second precision to the
 * language would mean specifying rounding at every operation. What it does
 * have is a slot in a foreign signature, and a plain number crossing into one
 * rounds to nearest float, which is what storing a double in a float means in
 * any language. The validator enforces the restriction: an f32 slot is
 * reachable only through the number projection. */
export type IrNativeScalar = IrNativeIntegerScalar | "f32" | "f64";

export interface IrNativeScalarType {
  kind: "nativeScalar";
  scalar: IrNativeScalar;
}

/** Nominal native aggregate value. `typeId` resolves only through the
 * module's validated Native IR type table; it is never an ordinary
 * JavaScript record or object representation. */
export interface IrNativeStructType {
  kind: "nativeStruct";
  typeId: string;
}

/** Opaque managed native reference. The backend representation is a
 * ScriptC-owned handle entry, never the foreign pointer itself. */
export interface IrNativeHandleType {
  kind: "nativeHandle";
  typeId: string;
}

export type IrNativeValueType = IrNativeScalarType | IrNativeStructType | IrNativeHandleType;

/** A foreign pointer that exists only in the physical native signature.
 * It is intentionally excluded from IrType: source code and ordinary IR
 * expressions can never observe or manufacture one. */
export interface IrNativePointerType {
  /** What the pointer points at. Bytes, or another pointer — the second is
   * what a NUL-terminated vector of strings is, and it is deliberately not a
   * recursive type: one level is what a C API asks for and a second has no
   * program behind it. */
  kind: "nativePointer";
  pointee: "i8" | "u8" | "ptr";
  const: boolean;
  addressSpace: 0;
}

/** The C ABI is the only calling convention with a lowering, so it is not a
 * field: a field whose only function is to be checked equal to a constant
 * carries no information and gives a producer somewhere to be wrong. It
 * returns when a target needs a second convention, with an emission behind
 * it. */
export interface IrNativeCallbackSignature {
  /** A pointer appears where the payload is a borrowed string: the physical
   * slot carries the pointer, and the source sees the copy made from it. A
   * handle appears where the payload is an object the emitter referenced; the
   * slot is an opaque pointer and the source sees the managed cell. */
  parameters: readonly (
    | IrNativeScalarType
    | IrNativePointerType
    | IrNativeHandleType
    /* The closure context occupies a real ABI slot at a real position, so
     * it is an entry here rather than a placement field beside the list. A
     * callback that takes no context simply has none — which is how a raw C
     * callback with no userdata is written down, and there is no way to
     * state a position the list does not have. */
    | IrNativeContextType
  )[];
  result: IrNativeScalarType | { kind: "void" };
}

/** A C function pointer that exists only in a physical native signature. */
export interface IrNativeCallbackType {
  kind: "nativeCallback";
  signature: IrNativeCallbackSignature;
}

/** The slot a failable call writes its error object into.
 *
 * Compiler-supplied like the closure context beside it, and opaque for the
 * same reason: the object is read through the contract's message and release
 * symbols and never becomes a source value. The compiler allocates the
 * pointer, initialises it to null, and passes its address — which is what a
 * `GError **` trailing parameter is, and what makes the call's own result
 * free to carry something useful. */
export interface IrNativeErrorOutType {
  kind: "nativeErrorOut";
  addressSpace: 0;
}

/** Opaque ScriptC closure context passed beside a native callback pointer. */
export interface IrNativeContextType {
  kind: "nativeContext";
  addressSpace: 0;
}

export type IrNativeCallbackArgumentType = {
  kind: "func";
  /** What the source callback receives, in order. A string arrives already
   * copied: a queued delivery outlives the pointer the emitter handed over. */
  params: readonly (
    | IrNativeScalarType
    | IrNativeHandleType
    /** A NUL-terminated `const char *` payload, decoded into a script string
     * the way every other foreign byte sequence is — maximal-subpart U+FFFD
     * replacement. It is named for the C shape rather than for `string`
     * because the shape is the part that varies: a pointer-and-length span
     * is a different physical arrangement of the same script value, and the
     * two cannot share one tag. */
    | { kind: "cstring" }
    /** The same script string from a pointer and a length instead of a
     * terminator, so the bytes may contain NUL and are not scanned for one. */
    | { kind: "utf8Span" }
    /** A pointer and a length copied into a script byte array. Bytes, not
     * text: nothing is decoded and nothing is replaced. */
    | { kind: "byteSpan" }
    /** Exact widening of an at-most-32-bit integer payload slot into the
     * source f64. The queued invocation stores the physical exact value; the
     * widening happens when the delivery reads it back. */
    | { kind: "f64" }
    /** An integer payload slot read as an ordinary TypeScript boolean,
     * carrying the two values that storage means — the mirror of the answer
     * form below, which this list was simply missing. */
    | { kind: "bool"; falseValue: string; trueValue: string }
  )[];
  /** A handler's answer. An exact scalar answers with its own
   * representation; `bool` answers with an ordinary TypeScript boolean over
   * an ABI boolean's storage, carrying the two values that storage means, so
   * a handler can say `return true` where a toolkit asks whether an event was
   * consumed. */
  ret:
    | IrNativeScalarType
    | { kind: "void" }
    | { kind: "bool"; falseValue: string; trueValue: string }
    /** An ordinary number answered into an exact slot — the mirror of the
     * `f64` payload form above, which this list was missing.
     *
     * It names its conversion where the payload form does not, and the
     * difference is real rather than an inconsistency: a payload WIDENS out
     * of an at-most-32-bit slot into a double, which is exact and cannot
     * fail, while an answer NARROWS a double back into the slot and has to
     * choose. Same reason a parameter position names one and a result
     * position does not. */
    | { kind: "f64"; conversion: "checked" | "wrap" };
};

export type IrNativeCallbackSourceArgument =
  | {
      kind: "callback-parameter";
      parameter: number;
      /** Present when the payload is an owned handle. The emitter took a
       * reference before queueing, so the invocation owns one and this gives
       * it back — whether the delivery runs or is dropped at shutdown. */
      destructor?: string;
    }
  /** One handler parameter fed by two physical slots: a pointer and the
   * element count beside it. The pairing lives here rather than in the
   * payload form because which slots feed a parameter is what a source
   * argument is for — the form says what the handler sees, not where the
   * pieces came from. */
  | { kind: "callback-parameter-span"; data: number; length: number }
  | { kind: "registration-owner" };

/** Which registration a release refers to: the binding that made it and the
 * argument position of the callback within that binding. A release lives in a
 * DIFFERENT binding from its registration — `remove` is not `add` — so the
 * reference has to name both halves rather than an index into the caller. */
export interface IrNativeRegistrationRef {
  binding: string;
  argument: number;
}

/** Delivery executor, reentrancy, post-disposal behavior, and shutdown
 * behavior are deliberately absent. Each was pinned by the validator to the
 * one value its arm implies and then read by nothing: a call-scoped callback
 * always runs on the caller, an asynchronous retained one always through the
 * runtime owner, and every implemented contract drains at shutdown and is not
 * invoked after disposal. A field the emitter derives is not documentation;
 * it is a second place for the truth to live. */
export type IrNativeCallbackContract =
  | {
      owner: { kind: "call" };
      allowedInvocationExecutors: readonly ["same-as-caller"];
      synchronousReturn: true;
      sourceArguments: readonly IrNativeCallbackSourceArgument[];
    }
  | {
      owner: { kind: "result" } | { kind: "argument"; argument: number };
      cancellationBinding: string;
      allowedInvocationExecutors: readonly (
        | "same-as-caller"
        | "any-attached-thread"
      )[];
      synchronousReturn: false;
      sourceArguments: readonly IrNativeCallbackSourceArgument[];
    }
  /**
   * A registration nothing in the program owns, invoked on the thread that
   * registered it whenever the library decides to — inside a later native
   * call, not on a runtime turn. Delivery is therefore direct, and script
   * code runs re-entrantly within whatever native frame pumped it.
   *
   * There is no cancellation binding, because there is no owner whose
   * disposal could cancel anything. A release names the function value back
   * instead, and the ledger matches it by pointer identity.
   *
   * It carries no answer: the library that calls a stored callback at a
   * moment of its own choosing has nowhere to put one.
   */
  | {
      owner: { kind: "process" };
      allowedInvocationExecutors: readonly ["same-as-caller"];
      synchronousReturn: true;
      sourceArguments: readonly IrNativeCallbackSourceArgument[];
    }
  /**
   * The same registration, produced by a thread the script does not own. It
   * cannot be delivered where it is raised — reading a closure is a
   * script-thread operation — so the payload is copied on the producing
   * thread and the invocation is queued for a later turn.
   *
   * The two axes move together and neither is free. A foreign producer is
   * exactly why delivery is queued rather than direct, and a queued delivery
   * is exactly why there is no answer: the producing thread is gone by the
   * time the handler runs.
   */
  | {
      owner: { kind: "process" };
      allowedInvocationExecutors: readonly (
        | "same-as-caller"
        | "any-attached-thread"
      )[];
      synchronousReturn: false;
      sourceArguments: readonly IrNativeCallbackSourceArgument[];
    }
  /**
   * A retained callback the native side ASKS rather than tells: it is
   * registered once and its answer is the value the emitting call returns.
   * An event handler that reports whether it consumed the event has this
   * shape, and it is common across C toolkits and window systems: such a
   * handler cannot say so after the event is gone.
   *
   * So delivery is synchronous, which is admissible for exactly one reason:
   * the invocation is same-as-caller, on the thread that owns the runtime. A
   * foreign producer may not ask, because answering means reading a closure,
   * and a foreign thread may never read one. The payloads are borrowed rather
   * than copied for the same reason a call-scoped payload is: they live only
   * as long as the call that carries them.
   *
   * An exception the handler leaves pending is not thrown into the toolkit's
   * frame. It stays pending, the trampoline answers with the ABI zero, and
   * the next runtime turn reports it — the discipline a call-scoped callback
   * already follows, with the difference that here the turn rather than an
   * outer native call is what observes it.
   */
  | {
      owner: { kind: "result" } | { kind: "argument"; argument: number };
      cancellationBinding: string;
      allowedInvocationExecutors: readonly ["same-as-caller"];
      synchronousReturn: true;
      sourceArguments: readonly IrNativeCallbackSourceArgument[];
    };

export type IrNativeAbiType =
  | IrNativeValueType
  | IrNativePointerType
  | IrNativeCallbackType
  | IrNativeContextType
  | IrNativeErrorOutType;

export type IrNativeArgumentType =
  | IrNativeValueType
  /** A plain JavaScript number crossing into a checked exact-integer slot.
   * The physical parameter stays the exact scalar; the boundary conversion
   * (finite, integral, in range — else a catchable TypeError) is the
   * `number` parameter projection's contract. */
  | { kind: "f64" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "nullableString" }
  /** A managed handle the source may omit. The null arm passes NULL without
   * consulting the handle table; a present handle is validated exactly as a
   * required one is. */
  | { kind: "nullableNativeHandle"; typeId: string }
  | (IrBytesType & { elem: "u8" })
  /** A managed array of plain strings, which is what a C API taking a
   * NUL-terminated `char **` receives. The element is not nullable: a
   * terminated vector cannot carry an absent element without ending itself
   * where the absence is. */
  | { kind: "array"; elem: { kind: "string" } }
  | IrNativeCallbackArgumentType;

export type IrNativeParameterProjection =
  | { kind: "argument"; argument: number }
  | { kind: "boolean"; argument: number; falseValue: string; trueValue: string }
  /** JavaScript-number ingress into an exact integer slot, naming which
   * conversion it performs. `checked` requires finite, integral, and in the
   * slot's range, raising a catchable TypeError otherwise; `wrap` is the
   * ECMAScript modulo conversion, exactly what `| 0` and `>>> 0` spell in
   * the language.
   *
   * Naming it is the point. Both behaviors are defensible and a binding
   * author may want either, but a boundary that wraps INVISIBLY is a
   * corruption wearing a conversion's clothes. There is no default: a
   * position states which one it gets.
   *
   * The original text follows, for the checked arm it still describes.
   *
   * Checked JavaScript-number ingress into an exact integer slot of at most
   * 32 bits. The source argument is f64; crossing requires finite, integral
   * (trunc(v) == v), and in the slot's range, else a catchable TypeError at
   * the boundary — the native boolean projection's mechanism. -0 crosses as
   * integer zero. 64-bit and pointer-width slots are excluded: their range
   * exceeds what an f64 carries injectively, which is what BigInt carriers
   * are for. */
  | { kind: "number"; argument: number; conversion: "checked" | "wrap" }
  | { kind: "utf8CString"; argument: number }
  /** A managed string array borrowed as the NUL-terminated `char **` a C API
   * expects. The elements are not copied — a managed string already owns its
   * bytes and keeps owning them — so what the call borrows is one vector of
   * pointers, built before the call and released after it whatever the call
   * did. That release is why this is not simply a pointer conversion: it is
   * the one argument family that leaves something behind to clean up. */
  | { kind: "utf8CStringArray"; argument: number }
  | { kind: "utf8Data"; argument: number }
  | { kind: "utf8ByteLength"; argument: number }
  | { kind: "bytesData"; argument: number }
  | { kind: "bytesByteLength"; argument: number }
  /** The compiler's own error slot. It projects no source argument: nothing
   * in the program supplies it, and nothing reads it but the error contract. */
  | { kind: "errorOut" }
  | { kind: "callbackFunction"; argument: number }
  | { kind: "callbackContext"; argument: number }
  /** The trampoline of a registration this call is UNMAKING. It is the same
   * pointer the registering call passed, because that pair — function and
   * context — is how the library recognises which registration to drop, so
   * the projection names the registration rather than allocating a second
   * trampoline that would identify nothing. */
  | {
      kind: "callbackRelease";
      argument: number;
      registration: IrNativeRegistrationRef;
    };

export type IrNativeResultProjection =
  | { kind: "direct" }
  /** A native integer becoming a JavaScript boolean, naming which reading it
   * performs. `exact` admits only the two declared representations and
   * raises catchably on anything else — the contract a binding states when
   * the foreign API promises exactly those. `nonZero` is C's own truth test,
   * where every nonzero value is true and nothing can fail. */
  | { kind: "boolean"; conversion: "exact"; falseValue: string; trueValue: string }
  | { kind: "boolean"; conversion: "nonZero" }
  /** Exact widening of an at-most-32-bit integer result into the source f64.
   * Lossless for every representable value, so there is no failure path and
   * validation requires the no-fail error contract. */
  | { kind: "number" }
  | { kind: "utf8CString"; nullable: boolean }
  /** A NUL-terminated vector of C strings copied into a managed `string[]`.
   *
   * Copying is what makes the result independent of the callee's storage,
   * which is not one thing: the vector may be the callee's to keep or the
   * caller's to free, and the elements likewise. `release` settles all of it
   * with one symbol, which is why conventions an SDK distinguishes need no arm
   * here — GIR's `full` and `container` transfers differ in whether the
   * elements are the caller's too, and that difference is entirely which
   * symbol frees the vector.
   *
   * The result's ownership is pinned to match and cannot disagree: a vector
   * that needs no release is `borrowed` from its receiver, exactly as a
   * borrowed string is, and one that does is a `value` — because it is
   * consumed inside this projection and never becomes something the program
   * holds.
   *
   * An element cannot be absent, because the absent slot IS the terminator.
   * The VECTOR can be, which is what `nullable` covers. */
  | { kind: "utf8CStringArray"; nullable: boolean; release: IrNativeRelease }
  /** An owned handle the callee may report as absent, projected as a union of
   * the handle and null. Absence is a value, not a failure. */
  | { kind: "nullableHandle" }
  /** The physical result is the operation's error channel and yields no
   * source value. It is not a discarded result: the `errorHandle` contract
   * reads it for a message and releases it. Paired with that contract, which
   * validation requires, so a pointer never becomes a source value. */
  | { kind: "errorChannel" };

export type IrNativeResultAbiType =
  | IrNativeValueType
  | IrNativePointerType
  | { kind: "void" };

/** How a failure is recognised in what the call returned. */
export type IrNativeFailureDetection =
  | { kind: "never" }
  | { kind: "resultIsNull" }
  /** The result IS the error object: non-null means failure, null success. */
  | { kind: "resultIsNotNull" }
  /** An OUT PARAMETER is the error object: non-null after the call means
   * failure. The result is the call's own, so unlike `resultIsNotNull` this
   * leaves a failable call free to hand something back — which is what 289 of
   * the 481 failable callables across GTK, Gio and GLib do. */
  | { kind: "outParameterIsNotNull"; parameter: number }
  | { kind: "resultEquals"; value: string };

/** Where the thrown message comes from. `none` means the detection names the
 * failure by itself, which is what a bare sentinel contract has to offer. */
export type IrNativeFailureMessage =
  | { kind: "none" }
  | { kind: "errno" }
  | { kind: "symbol"; symbol: string };

/** What must be released once a borrowed pointer has been read: an error
 * object after its message, or a returned vector after its elements have been
 * copied. Named here rather than derived from the operation's own symbol, so
 * no emitter guesses it.
 *
 * Distinct from a handle result's `destructor`, which names a BINDING the
 * validator checks — a handle is a resource the program holds, and what ends
 * it is itself a callable. These pointers are consumed inside one projection
 * and never become a program value, so there is no binding to name and a
 * symbol is the whole of it. */
export type IrNativeRelease =
  | { kind: "none" }
  | { kind: "symbol"; symbol: string };

export interface IrNativeErrorContract {
  detect: IrNativeFailureDetection;
  message: IrNativeFailureMessage;
  release: IrNativeRelease;
}

export interface IrNativeBinding {
  /** Stable identity used by `nativeCall`, unique within this module.
   * Embedders may qualify a manifest-local ID with its package instance. */
  id: string;
  /** Source declaration identity. It is metadata at the IR/backend seam;
   * the frontend integration uses it to prove the called symbol. */
  declaration: { module: string; name: string };
  /** Source operation role. Read and write may intentionally share one
   * declaration identity for a native accessor pair. */
  sourceAccess: "call" | "read" | "write";
  /** How the call is materialized. One field today, because a C symbol is the
   * only call target implemented; it is a record rather than a bare string
   * because that is the position a descriptor or a capsule occupies when
   * another one is. */
  entry: { symbol: string };
  /** Exact foreign failure convention. This is mandatory so backends never
   * infer error semantics from a symbol, declaration, or native type.
   *
   * Failure is three independent questions rather than a list of platform
   * conventions: how a failure is RECOGNISED, where its message comes from,
   * and what has to be released afterwards. A compiler has no business
   * knowing what an HRESULT is; it has every business knowing that some
   * operations report failure by a sentinel result and some by a non-null
   * error object.
   *
   * The axes are orthogonal but not every combination has a lowering yet.
   * The validator admits exactly the combinations both backends emit, so
   * adding one later is a validator row and an emission branch rather than a
   * new arm through every switch in the compiler. */
  error: IrNativeErrorContract;
  /** Logical values evaluated by nativeCall, once and in source order. */
  arguments: {
    name: string;
    type: IrNativeArgumentType;
    /** Required exactly when `type` is a callback. The logical contract is
     * kept beside the source value while physical function/context slots
     * merely project it into the ABI. */
    callback?: IrNativeCallbackContract;
  }[];
  /** Physical ABI slots in declaration order. Multiple slots may project
   * from one logical argument (for example UTF-8 data plus byte length). */
  parameters: {
    name: string;
    type: IrNativeAbiType;
    passMode: "value" | "pointer";
    ownership:
      | { kind: "value" }
      | { kind: "borrowed"; scope: "call" }
      | { kind: "owned"; transfer: "to-native" }
      | { kind: "callback" };
    projection: IrNativeParameterProjection;
  }[];
  result: {
    type: IrNativeResultAbiType;
    passMode: "value" | "pointer";
    ownership:
      | { kind: "value" }
      | { kind: "borrowed"; scope: "receiver"; anchor: string }
      | { kind: "owned"; transfer: "to-runtime"; destructor: string };
    projection: IrNativeResultProjection;
  };
}

export interface IrNativeStructDef {
  kind: "struct";
  id: string;
  declaration: { module: string; name: string };
  size: number;
  alignment: number;
  packing: "default";
  triviallyCopyable: true;
  destruction: "trivial";
  abi: {
    result: IrNativePhysicalAbiValue;
    parameters: readonly IrNativePhysicalAbiValue[];
  };
  fields: {
    name: string;
    type: IrNativeScalarType | IrNativeStructType;
    offset: number;
    /** How source reads this field, when it does not read the exact scalar.
     *
     * `number` widens an at-most-32-bit integer into a plain f64, exactly.
     * Physical layout is unchanged and construction still supplies the exact
     * field type, so nothing here loosens what may be written.
     *
     * `boolean` is C's own truth test over an integer field: nonzero is true.
     * It is the TOTAL reading rather than the exact one a boolean RESULT may
     * declare, and deliberately so — a field read is not a call, and admitting
     * a reading that can fail would make every struct field access a throwing
     * site with a pending check after it. What a C predicate means is
     * "nonzero", which is what the answer-as-a-field shape carries: a call
     * that fills storage and says whether it worked. Construction writes 1 for
     * true and 0 for false, which is the canonical pair the same truth test
     * reads back. */
    projection?: "number" | "boolean";
  }[];
}

/** Target-Clang's physical function type for one nominal aggregate. The
 * `aggregate` leaf denotes the logical struct itself; every other leaf is
 * target-independent LLVM ABI vocabulary. */
export type IrNativePhysicalAbiType =
  | { kind: "void" }
  | { kind: "integer"; bits: number }
  | { kind: "float"; format: "half" | "bfloat" | "float" | "double" | "fp128" | "x86_fp80" }
  | { kind: "pointer"; addressSpace: number }
  | { kind: "array"; count: number; element: IrNativePhysicalAbiType }
  | { kind: "vector"; count: number; scalable: boolean; element: IrNativePhysicalAbiType }
  | { kind: "struct"; packed: boolean; fields: readonly IrNativePhysicalAbiType[] }
  | { kind: "aggregate" };

export interface IrNativePhysicalAbiValue {
  type: IrNativePhysicalAbiType;
  alignment: number | null;
  stackAlignment: number | null;
  extension: "sign" | "zero" | null;
  inRegister: boolean;
  byValue: boolean;
  structureReturn: boolean;
}

export interface IrNativeHandleDef {
  kind: "handle";
  id: string;
  declaration: { module: string; name: string };
  nativeName: string;
  /** Foreign resource safety. ScriptC handle cells remain owner-confined;
   * `shared` permits the native implementation to use the resource from
   * its own worker/callback threads without exposing the managed cell. */
  threadSafety: "confined" | "shared";
  identity: "none" | "pointer" | "binding" | "platform";
  /** Whether values of this nominal type carry a cycle-collector header.
   * Identity-upcast-connected types must agree because they share a cell. */
  cycleCollection: "none" | "traceable";
  /** Direct representation-preserving nominal conversions. */
  upcasts: { kind: "identity"; target: string }[];
}

/** One exact Native IR entry exported from a library artifact. Unlike
 * IrLibExport, these values never use the JavaScript f64 marshalling classes:
 * the C ABI and the compiled TypeScript function carry the same exact type. */
export interface IrNativeExport {
  id: string;
  symbol: string;
  fnName: string;
  declaration: { module: string; name: string };
  params: { name: string; type: IrNativeScalarType }[];
  returns: IrNativeScalarType | { kind: "void" };
  error: {
    detect: { kind: "never" };
    message: { kind: "none" };
    release: { kind: "none" };
  };
}

/* ── the document an embedder hands over ─────────────────────────────────
 *
 * Everything above describes ONE value or ONE binding. These describe the
 * whole document: the bindings, the types they reference, the source
 * identities they attach to, and the ABI facts the generic ones are resolved
 * against. `NativeFrontendInput` is the format — the rest of this module is
 * what it is made of.
 */

/** One exported TypeScript declaration that denotes an exact Native IR value.
 * Source spelling is never used as evidence: the frontend resolves this
 * module/name pair to the checker's declaration symbol. */
export interface NativeSourceType {
  readonly declaration: {
    readonly module: string;
    readonly name: string;
  };
  readonly type: Readonly<IrNativeValueType>;
}

export interface NativeFrontendConstant {
  readonly id: string;
  readonly declaration: {
    readonly module: string;
    readonly name: string;
  };
  readonly type: Readonly<IrNativeScalarType>;
  readonly value: string;
}

/** One source-level operation on an exact scalar, supplied by the embedder.
 * None has a native symbol or a runtime module value: the frontend resolves
 * the checked declaration identity and lowers reached calls directly to
 * Native IR.
 *
 * `integer-reduce` folds a variadic argument list with one wrapping operator
 * (a flags `combine`). `to-number` and `from-number` are the conversions
 * between an exact scalar and an ordinary number; they are operations rather
 * than operators because no syntax names a direction, and named rather than
 * spelled `Number(v)` because JavaScript's conversion rounds silently where
 * this one refuses. Every arithmetic operation is an operator expression
 * inside a construction instead. */
export type NativeFrontendOperation =
  | {
      readonly id: string;
      readonly declaration: {
        readonly module: string;
        readonly name: string;
      };
      readonly kind: "integer-reduce";
      readonly operator: "&" | "|" | "^";
      readonly type: Readonly<IrNativeScalarType>;
    }
  | {
      readonly id: string;
      readonly declaration: {
        readonly module: string;
        readonly name: string;
      };
      readonly kind: "to-number";
      readonly type: Readonly<IrNativeScalarType>;
    }
  | {
      readonly id: string;
      readonly declaration: {
        readonly module: string;
        readonly name: string;
      };
      readonly kind: "from-number";
      readonly type: Readonly<IrNativeScalarType>;
    };

export type NativeStructDefinition = Readonly<
  Omit<IrNativeStructDef, "fields"> & {
    readonly fields: readonly Readonly<IrNativeStructDef["fields"][number]>[];
  }
>;

export type NativeHandleDefinition = Readonly<
  Omit<IrNativeHandleDef, "upcasts"> & {
    readonly upcasts: readonly Readonly<IrNativeHandleDef["upcasts"][number]>[];
  }
>;

export type NativeTypeDefinition = NativeStructDefinition | NativeHandleDefinition;

export interface NativeFrontendBinding {
  readonly id: string;
  readonly declaration: {
    readonly module: string;
    readonly name: string;
  };
  readonly entry: {
    readonly symbol: string;
  };
  readonly error:
    Readonly<IrNativeErrorContract>;
  readonly sourceCall:
    | { readonly kind: "function" }
    | { readonly kind: "constructor" }
    | { readonly kind: "method"; readonly receiverArgument: number }
    | { readonly kind: "getter"; readonly receiverArgument: number }
    | {
        readonly kind: "setter";
        readonly receiverArgument: number;
        readonly valueArgument: number;
      };
  readonly arguments: readonly {
    readonly name: string;
    readonly type: Readonly<IrNativeArgumentType>;
    readonly callback?: Readonly<IrNativeCallbackContract>;
  }[];
  readonly parameters: readonly {
    readonly name: string;
    readonly type: Readonly<IrNativeAbiType>;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | { readonly kind: "borrowed"; readonly scope: "call" }
      | { readonly kind: "owned"; readonly transfer: "to-native" }
      | { readonly kind: "callback" };
    readonly projection: Readonly<IrNativeParameterProjection>;
  }[];
  readonly result: {
    readonly type: Readonly<IrNativeResultAbiType>;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | {
          readonly kind: "borrowed";
          readonly scope: "receiver";
          readonly anchor: string;
        }
      | {
          readonly kind: "owned";
          readonly transfer: "to-runtime";
          readonly destructor: string;
        };
    readonly projection: Readonly<IrNativeResultProjection>;
  };
}

/** One C-callable entry implemented by an exported function in the library
 * entry module. This first slice is intentionally exact-scalar-only: it is a
 * Native IR boundary, distinct from library profiles' JavaScript-value
 * marshalling classes. */
export interface NativeFrontendExport {
  readonly id: string;
  /** Exported function name in the compilation entry module. */
  readonly sourceExport: string;
  /** Source contract identity retained for reports and diagnostics. */
  readonly declaration: {
    readonly module: string;
    readonly name: string;
  };
  readonly entry: {
    readonly symbol: string;
  };
  readonly error: {
    readonly detect: { readonly kind: "never" };
    readonly message: { readonly kind: "none" };
    readonly release: { readonly kind: "none" };
  };
  readonly parameters: readonly {
    readonly name: string;
    readonly type: Readonly<IrNativeValueType>;
    readonly passMode: "value";
    readonly ownership: { readonly kind: "value" };
  }[];
  readonly result: {
    readonly type: Readonly<IrNativeValueType> | { readonly kind: "void" };
    readonly passMode: "value";
    readonly ownership: { readonly kind: "value" };
  };
}

/** Embedder-supplied native semantics for one frontend run. This contract is
 * deliberately composition-neutral: package identity, provenance, and target
 * planning live above ScriptC, while this layer sees only exact source
 * identities, the target ABI facts needed to interpret generic types, and
 * Native IR. */
export interface NativeFrontendInput {
  /** ABI facts selected by the embedder. Pointer-sized Native IR types are
   * resolved against this width; aggregate lowering additionally keys on the
   * ABI identity. The compiler driver verifies both against the selected
   * backend target before lowering. */
  readonly target: {
    readonly pointerBits: 32 | 64;
    readonly abi: string;
  };
  readonly sourceTypes: readonly NativeSourceType[];
  readonly constants: readonly NativeFrontendConstant[];
  readonly operations: readonly NativeFrontendOperation[];
  readonly types: readonly NativeTypeDefinition[];
  readonly bindings: readonly NativeFrontendBinding[];
  readonly exports: readonly NativeFrontendExport[];
}
