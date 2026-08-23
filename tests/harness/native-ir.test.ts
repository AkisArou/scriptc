/* Native IR is tested below the TypeScript frontend on purpose: this suite
 * proves the serialized compiler/backend contract independently of any
 * particular binding manifest or declaration package. An embedder's own
 * generated fixture can replace the tiny standalone C source through the two
 * SCRIPTC_NATIVE_IR_FIXTURE_* variables without changing the IR program. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compileC } from "../../packages/compiler/src/backend/cc.js";
import { emitModule } from "../../packages/compiler/src/backend/emission/emitter.js";
import { emitLlvmModule } from "../../packages/compiler/src/backend/llvm/emitter.js";
import type { IrExpr, IrModule, IrNativeCallbackContract, IrNativeScalar, IrNativeValueType, SrcLoc } from "../../packages/compiler/src/ir/nodes.js";
import { nativeCallbackArgumentType, nativeScalarType } from "../../packages/compiler/src/ir/nodes.js";
import { deserializeModule, IR_VERSION, serializeModule } from "../../packages/compiler/src/ir/serialize.js";
import { validateModule } from "../../packages/compiler/src/ir/validate.js";
import { mangleNativeStruct } from "../../packages/compiler/src/backend/mangle.js";
import type { NativeFrontendInput } from "../../packages/compiler/src/frontend/native.js";
import { materializeNativeBinding } from "../../packages/compiler/src/frontend/lowering/lower-native.js";
import { analyze, compile, compileLibrary } from "../../packages/compiler/src/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-native-ir-"));
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const loc: SrcLoc = { file: "native-ir.ts", start: 0, end: 0 };
const nativePackage = "@scriptc/native-abi-fixture";
const I8 = nativeScalarType("i8");
const U8 = nativeScalarType("u8");
const I16 = nativeScalarType("i16");
const U16 = nativeScalarType("u16");
const I32 = nativeScalarType("i32");
const U32 = nativeScalarType("u32");
const I64 = nativeScalarType("i64");
const U64 = nativeScalarType("u64");
const ISIZE = nativeScalarType("isize");
const USIZE = nativeScalarType("usize");
/* The closure slot, at its declared position in the physical signature. */
const CONTEXT = { kind: "nativeContext", addressSpace: 0 } as const;
const NATIVE_F64 = nativeScalarType("f64");
const CALL_I32_CALLBACK = {
  parameters: [I32, CONTEXT],
  result: I32,
} as const;
const CALL_I32_SOURCE = nativeCallbackArgumentType(CALL_I32_CALLBACK);
const CALL_I32_CONTRACT = {
  owner: { kind: "call" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [{ kind: "callback-parameter", parameter: 0 }],
} as const satisfies IrNativeCallbackContract;
const RETAINED_I32_CALLBACK = {
  parameters: [I32, CONTEXT],
  result: { kind: "void" },
} as const;
const RETAINED_I32_SOURCE = nativeCallbackArgumentType(RETAINED_I32_CALLBACK);
const RETAINED_I32_CONTRACT = {
  owner: { kind: "result" },
  cancellationBinding:
    "scriptc.fixture.c-v1@0.0.0#subscription_destroy",
  allowedInvocationExecutors: [
    "same-as-caller",
    "any-attached-thread",
  ],
  synchronousReturn: false,
  sourceArguments: [{ kind: "callback-parameter", parameter: 0 }],
} as const satisfies IrNativeCallbackContract;
/* The checked-number surface: source sees plain f64 numbers; the physical
 * slots stay the exact scalars, so every binding below reuses an existing C
 * symbol. */
const RETAINED_NUMBER_SOURCE = {
  kind: "func",
  params: [{ kind: "f64" }],
  ret: { kind: "void" },
} as const;
const CALL_NUMBER_SOURCE = {
  kind: "func",
  params: [{ kind: "f64" }],
  ret: nativeScalarType("i32"),
} as const;
/* The same shape over a 32-bit float slot: the payload is stored as a float
 * and the handler receives the double it widens to. */
const CALL_F32_CALLBACK = {
  parameters: [nativeScalarType("f32"), CONTEXT],
  result: I32,
} as const;
const PADDED_ID = "scriptc.fixture.c-v1@0.0.0#type:padded";
const PADDED = { kind: "nativeStruct", typeId: PADDED_ID } as const;
const PAIR32_ID = "scriptc.fixture.c-v1@0.0.0#type:pair32";
const PAIR32 = { kind: "nativeStruct", typeId: PAIR32_ID } as const;
const PAIR_F64_ID = "scriptc.fixture.c-v1@0.0.0#type:pair_f64";
const PAIR_F64 = { kind: "nativeStruct", typeId: PAIR_F64_ID } as const;
const NESTED_PAIR32_ID = "scriptc.fixture.c-v1@0.0.0#type:nested_pair32";
const NESTED_PAIR32 = { kind: "nativeStruct", typeId: NESTED_PAIR32_ID } as const;
const DIRECT_I64_AGGREGATE_ABI = {
  result: {
    type: { kind: "integer", bits: 64 },
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: false,
    structureReturn: false,
  },
  parameters: [{
    type: { kind: "integer", bits: 64 },
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: false,
    structureReturn: false,
  }],
} as const;
const EXPANDED_F64_AGGREGATE_ABI = {
  result: {
    type: {
      kind: "struct",
      packed: false,
      fields: [
        { kind: "float", format: "double" },
        { kind: "float", format: "double" },
      ],
    },
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: false,
    structureReturn: false,
  },
  parameters: [
    {
      type: { kind: "float", format: "double" },
      alignment: null,
      stackAlignment: null,
      extension: null,
      inRegister: false,
      byValue: false,
      structureReturn: false,
    },
    {
      type: { kind: "float", format: "double" },
      alignment: null,
      stackAlignment: null,
      extension: null,
      inRegister: false,
      byValue: false,
      structureReturn: false,
    },
  ],
} as const;
const PADDED_ABI = {
  result: {
    type: { kind: "void" },
    alignment: null,
    stackAlignment: null,
    extension: null,
    inRegister: false,
    byValue: false,
    structureReturn: false,
  },
  parameters: [
    {
      type: { kind: "pointer", addressSpace: 0 },
      alignment: 8,
      stackAlignment: null,
      extension: null,
      inRegister: false,
      byValue: false,
      structureReturn: true,
    },
    {
      type: { kind: "pointer", addressSpace: 0 },
      alignment: 8,
      stackAlignment: null,
      extension: null,
      inRegister: false,
      byValue: true,
      structureReturn: false,
    },
  ],
} as const;
const COUNTER_BASE_ID = "scriptc.fixture.c-v1@0.0.0#type:counter_base";
const COUNTER_BASE = { kind: "nativeHandle", typeId: COUNTER_BASE_ID } as const;
const COUNTER_MIDDLE_ID = "scriptc.fixture.c-v1@0.0.0#type:counter_middle";
const COUNTER_MIDDLE = { kind: "nativeHandle", typeId: COUNTER_MIDDLE_ID } as const;
const COUNTER_ID = "scriptc.fixture.c-v1@0.0.0#type:counter";
const COUNTER = { kind: "nativeHandle", typeId: COUNTER_ID } as const;
const SUBSCRIPTION_ID =
  "scriptc.fixture.c-v1@0.0.0#type:subscription";
const SUBSCRIPTION = {
  kind: "nativeHandle",
  typeId: SUBSCRIPTION_ID,
} as const;
const PADDED_DEFINITION = {
  kind: "struct",
  id: PADDED_ID,
  declaration: { module: nativePackage, name: "Padded" },
  size: 24,
  alignment: 8,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: PADDED_ABI,
  fields: [
    { name: "tag", type: U8, offset: 0 },
    { name: "value", type: U64, offset: 8 },
    { name: "ratio", type: NATIVE_F64, offset: 16 },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const PAIR32_DEFINITION = {
  kind: "struct",
  id: PAIR32_ID,
  declaration: { module: nativePackage, name: "Pair32" },
  size: 8,
  alignment: 4,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: DIRECT_I64_AGGREGATE_ABI,
  fields: [
    { name: "first", type: I32, offset: 0 },
    { name: "second", type: I32, offset: 4 },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const PAIR_F64_DEFINITION = {
  kind: "struct",
  id: PAIR_F64_ID,
  declaration: { module: nativePackage, name: "PairF64" },
  size: 16,
  alignment: 8,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: EXPANDED_F64_AGGREGATE_ABI,
  fields: [
    { name: "first", type: NATIVE_F64, offset: 0 },
    { name: "second", type: NATIVE_F64, offset: 8 },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const NESTED_PAIR32_DEFINITION = {
  kind: "struct",
  id: NESTED_PAIR32_ID,
  declaration: { module: nativePackage, name: "NestedPair32" },
  size: 24,
  alignment: 8,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: PADDED_ABI,
  fields: [
    { name: "left", type: PAIR32, offset: 0 },
    { name: "right", type: PAIR32, offset: 8 },
    { name: "marker", type: I64, offset: 16 },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const COUNTER_DEFINITION = {
  kind: "handle",
  id: COUNTER_ID,
  declaration: { module: nativePackage, name: "Counter" },
  nativeName: "NtsCounter",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [{ kind: "identity", target: COUNTER_MIDDLE_ID }],
} as const satisfies NativeFrontendInput["types"][number];
const COUNTER_MIDDLE_DEFINITION = {
  kind: "handle",
  id: COUNTER_MIDDLE_ID,
  declaration: { module: nativePackage, name: "CounterMiddle" },
  nativeName: "NtsCounterMiddle",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [{ kind: "identity", target: COUNTER_BASE_ID }],
} as const satisfies NativeFrontendInput["types"][number];
const NUMBER_PAIR32_ID = "scriptc.fixture.c-v1@0.0.0#type:number-pair32";
const NUMBER_PAIR32 = { kind: "nativeStruct", typeId: NUMBER_PAIR32_ID } as const;
/* Same physical layout and ABI as Pair32 under a distinct identity: the
 * marker changes how source reads the fields, never what the bytes are. */
const NUMBER_PAIR32_DEFINITION = {
  kind: "struct",
  id: NUMBER_PAIR32_ID,
  declaration: { module: nativePackage, name: "NumberPair32" },
  size: 8,
  alignment: 4,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: DIRECT_I64_AGGREGATE_ABI,
  fields: [
    { name: "first", type: I32, offset: 0, projection: "number" },
    { name: "second", type: I32, offset: 4, projection: "number" },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const ANSWERED_ID = "scriptc.fixture.c-v1@0.0.0#type:answered";
const ANSWERED = { kind: "nativeStruct", typeId: ANSWERED_ID } as const;
/* The answer-as-a-field shape. Physically two int32 slots like Pair32, read
 * two different ways: one as C's own truth test, one as a plain number. It is
 * what a predicate with an out-parameter becomes once the out-parameter is a
 * field of the result — a call that fills storage and says whether it did,
 * where reporting absence instead would throw away a usable value. */
const ANSWERED_DEFINITION = {
  kind: "struct",
  id: ANSWERED_ID,
  declaration: { module: nativePackage, name: "Answered" },
  size: 8,
  alignment: 4,
  packing: "default",
  triviallyCopyable: true,
  destruction: "trivial",
  abi: DIRECT_I64_AGGREGATE_ABI,
  fields: [
    { name: "answered", type: I32, offset: 0, projection: "boolean" },
    { name: "value", type: I32, offset: 4, projection: "number" },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const COUNTER_BASE_DEFINITION = {
  kind: "handle",
  id: COUNTER_BASE_ID,
  declaration: { module: nativePackage, name: "CounterBase" },
  nativeName: "NtsCounterBase",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const VAULT_ID = "scriptc.fixture.c-v1@0.0.0#type:vault";
const VAULT = { kind: "nativeHandle", typeId: VAULT_ID } as const;
const ASKER_ID = "scriptc.fixture.c-v1@0.0.0#type:asker";
const ASKER = { kind: "nativeHandle", typeId: ASKER_ID } as const;
/* A retained callback the emitter asks for an answer: registered once,
 * invoked on the caller's thread, and its result is the emitting call's
 * result. Same shape as an event handler that reports whether it consumed
 * the event. */
const ASK_I32_CALLBACK = {
  parameters: [I32, CONTEXT],
  result: I32,
} as const;
const ASK_I32_SOURCE = nativeCallbackArgumentType(ASK_I32_CALLBACK);
const ASK_I32_CONTRACT = {
  owner: { kind: "result" },
  cancellationBinding: "scriptc.fixture.c-v1@0.0.0#asker_destroy",
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [{ kind: "callback-parameter", parameter: 0 }],
} as const satisfies IrNativeCallbackContract;
/* The same question answered with an ordinary TypeScript boolean over the
 * fixture's exact i32 storage — the shape an event handler takes when its
 * integer result means whether it consumed the event. */
const ASK_BOOL_SOURCE = {
  ...ASK_I32_SOURCE,
  ret: { kind: "bool", falseValue: "0", trueValue: "1" },
} as const;
const ASK_BOOL_CONTRACT = {
  ...ASK_I32_CONTRACT,
  cancellationBinding: "scriptc.fixture.c-v1@0.0.0#answerer_destroy",
} as const satisfies IrNativeCallbackContract;
/* The two synchronous deliveries that hold an OBJECT while they run, which is
 * the pair no fixture inhabited. Handle payloads were reachable on the queued
 * path and synchronous delivery was reachable with exact scalars; their
 * intersection was reachable from neither. */
const TELLER_ID = "scriptc.fixture.c-v1@0.0.0#type:teller";
const TELLER = { kind: "nativeHandle", typeId: TELLER_ID } as const;
const JUDGE_ID = "scriptc.fixture.c-v1@0.0.0#type:judge";
const JUDGE = { kind: "nativeHandle", typeId: JUDGE_ID } as const;
const COUNTER_DESTROY = "scriptc.fixture.c-v1@0.0.0#counter_destroy";
const HOST_ID = "scriptc.fixture.c-v1@0.0.0#type:host";
const HOST = { kind: "nativeHandle", typeId: HOST_ID } as const;
const HOST_RELEASE = "scriptc.fixture.c-v1@0.0.0#host_release";
const HOST_PEER_READ = "scriptc.fixture.c-v1@0.0.0#host_peer_read";
const HOST_PEER_WRITE = "scriptc.fixture.c-v1@0.0.0#host_peer_write";
const HOST_RECEIVER_ID = "scriptc.fixture.c-v1@0.0.0#type:host_receiver";
const HOST_RECEIVER = { kind: "nativeHandle", typeId: HOST_RECEIVER_ID } as const;
/* The base a class with FIELDS extends. Its identity arm is `none` — the arm
 * a JVM handle declares — so two lifecycle dispatches on one object arrive as
 * two distinct cells, and nothing about the cell can carry state between them.
 * That is the whole point of the fixture: with `pointer` the interning map
 * would answer, and the test would pass for a reason Android cannot supply. */
const HOST_DEFINITION = {
  kind: "handle",
  id: HOST_ID,
  declaration: { module: nativePackage, name: "Host" },
  nativeName: "NtsHost",
  threadSafety: "confined",
  identity: "none",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
/* The declaration the program EXTENDS and the receiver the generated host
 * DELIVERS are intentionally different. A real Activity has this exact
 * shape: source extends Activity, while the generated MainActivity owns the
 * peer field. Putting the slot on Host would let a compiler read the base and
 * pass this fixture for a reason the platform cannot supply. */
const HOST_RECEIVER_DEFINITION = {
  kind: "handle",
  id: HOST_RECEIVER_ID,
  declaration: { module: nativePackage, name: "HostReceiver" },
  nativeName: "NtsHost",
  threadSafety: "confined",
  identity: "none",
  cycleCollection: "none",
  peerSlot: { read: HOST_PEER_READ, write: HOST_PEER_WRITE },
  upcasts: [{ kind: "identity", target: HOST_ID }],
} as const satisfies NativeFrontendInput["types"][number];
const HOST_OPEN_CALLBACK = {
  parameters: [HOST_RECEIVER, I32, CONTEXT],
  result: { kind: "void" },
} as const;
const HOST_SETTLE_CALLBACK = {
  parameters: [HOST_RECEIVER, CONTEXT],
  result: { kind: "void" },
} as const;
const HOST_OPEN_CONTRACT = {
  owner: { kind: "process" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: HOST_RELEASE },
    { kind: "callback-parameter", parameter: 1 },
  ],
} as const satisfies IrNativeCallbackContract;
const HOST_OPEN_SOURCE = nativeCallbackArgumentType(HOST_OPEN_CALLBACK);
const HOST_SETTLE_SOURCE = nativeCallbackArgumentType(HOST_SETTLE_CALLBACK);
const HOST_SETTLE_CONTRACT = {
  owner: { kind: "process" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: HOST_RELEASE },
  ],
} as const satisfies IrNativeCallbackContract;
const SHARED_ID = "scriptc.fixture.c-v1@0.0.0#type:shared";
const SHARED = { kind: "nativeHandle", typeId: SHARED_ID } as const;
/* The SAME C object as the token, under the OTHER identity arm. Two types over
 * one pointer is what isolates the arm as the only difference: interning is
 * then the whole of what changes, and a comparison that answered constantly
 * would disagree with one of the two. */
const SHARED_DEFINITION = {
  kind: "handle",
  id: SHARED_ID,
  declaration: { module: nativePackage, name: "Shared" },
  nativeName: "NtsToken",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const TOKEN_ID = "scriptc.fixture.c-v1@0.0.0#type:token";
const TOKEN = { kind: "nativeHandle", typeId: TOKEN_ID } as const;
const TOKEN_DEFINITION = {
  kind: "handle",
  id: TOKEN_ID,
  declaration: { module: nativePackage, name: "Token" },
  nativeName: "NtsToken",
  threadSafety: "confined",
  /* The arm a JVM handle declares, and the only one this fixture could not
   * express before. A platform whose references cannot be compared for
   * identity may not be interned by them, so every arrival builds its OWN
   * cell — which is observable from the program, not only in bookkeeping. */
  identity: "none",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];

/* The `onCreate` shape: answers nothing, and the object is the whole payload.
 * The physical slot is the handle type itself — an opaque pointer at the ABI,
 * a managed cell to the handler. */
const TELL_CALLBACK = {
  parameters: [COUNTER, CONTEXT],
  result: { kind: "void" },
} as const;
const TELL_SOURCE = nativeCallbackArgumentType(TELL_CALLBACK);
const TELL_CONTRACT = {
  owner: { kind: "result" },
  cancellationBinding: "scriptc.fixture.c-v1@0.0.0#teller_destroy",
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY },
  ],
} as const satisfies IrNativeCallbackContract;

/* The `onKeyDown` shape, and the conjunction the JVM acceptance pin needs: a
 * boolean answer alongside a scalar AND an object. */
const JUDGE_CALLBACK = {
  parameters: [I32, COUNTER, CONTEXT],
  result: I32,
} as const;
const JUDGE_SOURCE = {
  ...nativeCallbackArgumentType(JUDGE_CALLBACK),
  ret: { kind: "bool", falseValue: "0", trueValue: "1" },
} as const;
const JUDGE_CONTRACT = {
  owner: { kind: "result" },
  cancellationBinding: "scriptc.fixture.c-v1@0.0.0#judge_destroy",
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0 },
    { kind: "callback-parameter", parameter: 1, destructor: COUNTER_DESTROY },
  ],
} as const satisfies IrNativeCallbackContract;

/* The same telling delivery, owned by nothing. No cancellation binding,
 * because there is no receiver whose disposal could cancel it. */
const NOTICE_CONTRACT = {
  owner: { kind: "process" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY },
  ],
} as const satisfies IrNativeCallbackContract;

/* The same telling delivery whose payload the emitter may WITHHOLD. Only the
 * SOURCE type differs from `TELL_SOURCE`: the physical slot is the same handle
 * pointer, because nullability is a fact about the value a program receives
 * rather than about the ABI that carries it. */
const MAYBE_SOURCE = {
  ...nativeCallbackArgumentType(TELL_CALLBACK),
  params: [{ kind: "nullableNativeHandle", typeId: COUNTER_ID }],
} as const;
const MAYBE_CONTRACT = {
  owner: { kind: "process" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY },
  ],
} as const satisfies IrNativeCallbackContract;

/* The owner-scoped mirror of `MAYBE_SOURCE`: an ANSWERING handler holding a
 * scalar and a subject the emitter may withhold, anchored to a receiver whose
 * disposal cancels it. Same physical signature as the judge above — only the
 * payload's source arm differs. */
const MAYBE_JUDGE_SOURCE = {
  ...JUDGE_SOURCE,
  params: [I32, { kind: "nullableNativeHandle", typeId: COUNTER_ID }],
} as const;
const MAYBE_JUDGE_CONTRACT = {
  owner: { kind: "result" },
  cancellationBinding: "scriptc.fixture.c-v1@0.0.0#judge_destroy",
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0 },
    { kind: "callback-parameter", parameter: 1, destructor: COUNTER_DESTROY },
  ],
} as const satisfies IrNativeCallbackContract;

/* The receiver arrives as an owned payload and the call's own argument follows
 * it, which is exactly a lowered method's parameter order. */
const TICK_CALLBACK = {
  parameters: [COUNTER, I32, CONTEXT],
  result: { kind: "void" },
} as const;
const TICK_SOURCE_TYPE = nativeCallbackArgumentType(TICK_CALLBACK);
const TICK_CONTRACT = {
  owner: { kind: "process" },
  allowedInvocationExecutors: ["same-as-caller"],
  synchronousReturn: true,
  sourceArguments: [
    { kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY },
    { kind: "callback-parameter", parameter: 1 },
  ],
} as const satisfies IrNativeCallbackContract;

const TELLER_DEFINITION = {
  kind: "handle",
  id: TELLER_ID,
  declaration: { module: nativePackage, name: "Teller" },
  nativeName: "NtsTeller",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const JUDGE_DEFINITION = {
  kind: "handle",
  id: JUDGE_ID,
  declaration: { module: nativePackage, name: "Judge" },
  nativeName: "NtsJudge",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];

const VAULT_DEFINITION = {
  kind: "handle",
  id: VAULT_ID,
  declaration: { module: nativePackage, name: "Vault" },
  nativeName: "NtsVault",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const ASKER_DEFINITION = {
  kind: "handle",
  id: ASKER_ID,
  declaration: { module: nativePackage, name: "Asker" },
  nativeName: "NtsAsker",
  threadSafety: "confined",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const SUBSCRIPTION_DEFINITION = {
  kind: "handle",
  id: SUBSCRIPTION_ID,
  declaration: { module: nativePackage, name: "Subscription" },
  nativeName: "NtsSubscription",
  threadSafety: "shared",
  identity: "pointer",
  cycleCollection: "none",
  upcasts: [],
} as const satisfies NativeFrontendInput["types"][number];
const NATIVE_VOID = { kind: "void" } as const;
const NO_NATIVE_ERROR = {
  detect: { kind: "never" },
  message: { kind: "none" },
  release: { kind: "none" },
} as const;
/** A NULL result means failure and the detection is the whole message. */
const NULL_IS_FAILURE = {
  detect: { kind: "resultIsNull" },
  message: { kind: "none" },
  release: { kind: "none" },
} as const;
/** A sentinel result means failure and errno says why. */
const errnoFailure = (value: string) =>
  ({
    detect: { kind: "resultEquals", value },
    message: { kind: "errno" },
    release: { kind: "none" },
  }) as const;
const DIRECT_RESULT = { kind: "direct" } as const;

type DirectNativeParameter = {
  readonly name: string;
  readonly type: IrNativeValueType;
  readonly passMode: "value" | "pointer";
  readonly ownership:
    | { readonly kind: "value" }
    | { readonly kind: "borrowed"; readonly scope: "call" }
    | { readonly kind: "owned"; readonly transfer: "to-native" };
};

function directSignature(parameters: readonly DirectNativeParameter[]) {
  return {
    arguments: parameters.map(({ name, type }) => ({ name, type })),
    parameters: parameters.map((parameter, argument) => ({
      ...parameter,
      projection: { kind: "argument" as const, argument },
    })),
  };
}

const exactIntegerBindings = [
  { scalar: "i8", declaration: "i8Identity", symbol: "nts_i8_identity" },
  { scalar: "u8", declaration: "u8Identity", symbol: "nts_u8_identity" },
  { scalar: "i16", declaration: "i16Identity", symbol: "nts_i16_identity" },
  { scalar: "u16", declaration: "u16Identity", symbol: "nts_u16_identity" },
  { scalar: "i32", declaration: "i32Identity", symbol: "nts_i32_identity" },
  { scalar: "u32", declaration: "u32Identity", symbol: "nts_u32_identity" },
  { scalar: "i64", declaration: "i64Identity", symbol: "nts_i64_identity" },
  { scalar: "u64", declaration: "u64Identity", symbol: "nts_u64_identity" },
  { scalar: "usize", declaration: "usizeIdentity", symbol: "nts_usize_identity" },
] as const;

const localNativeInput: NativeFrontendInput = {
  target: { pointerBits: 64, abi: "sysv-amd64" },
  sourceTypes: [
    ...exactIntegerBindings.map(({ scalar }) => ({
      declaration: { module: nativePackage, name: scalar },
      type: nativeScalarType(scalar),
    })),
    { declaration: { module: nativePackage, name: "f64" }, type: NATIVE_F64 },
    { declaration: { module: nativePackage, name: "Padded" }, type: PADDED },
    { declaration: { module: nativePackage, name: "Pair32" }, type: PAIR32 },
    { declaration: { module: nativePackage, name: "NumberPair32" }, type: NUMBER_PAIR32 },
    { declaration: { module: nativePackage, name: "Answered" }, type: ANSWERED },
    { declaration: { module: nativePackage, name: "PairF64" }, type: PAIR_F64 },
    { declaration: { module: nativePackage, name: "NestedPair32" }, type: NESTED_PAIR32 },
    { declaration: { module: nativePackage, name: "CounterBase" }, type: COUNTER_BASE },
    { declaration: { module: nativePackage, name: "CounterMiddle" }, type: COUNTER_MIDDLE },
    { declaration: { module: nativePackage, name: "Counter" }, type: COUNTER },
    { declaration: { module: nativePackage, name: "Token" }, type: TOKEN },
    { declaration: { module: nativePackage, name: "Shared" }, type: SHARED },
    { declaration: { module: nativePackage, name: "Host" }, type: HOST },
    { declaration: { module: nativePackage, name: "HostReceiver" }, type: HOST_RECEIVER },
    /* A DOTTED source type: the nested class, whose symbol is reachable only
     * through its owner's VALUE side. */
    { declaration: { module: nativePackage, name: "NativeCounter.Nested" }, type: COUNTER },
    /* The DECLARED base is an ancestor of what the registration delivers. A
     * program writes `extends TickSource` while the generated class the
     * platform constructs is one identity upcast below it — Android's
     * `extends Activity` against a generated MainActivity — so `this` must be
     * typed from the registration rather than from the base. */
    { declaration: { module: nativePackage, name: "TickSource" }, type: COUNTER_MIDDLE },
    {
      declaration: { module: nativePackage, name: "Subscription" },
      type: SUBSCRIPTION,
    },
    { declaration: { module: nativePackage, name: "Asker" }, type: ASKER },
    { declaration: { module: nativePackage, name: "Teller" }, type: TELLER },
    { declaration: { module: nativePackage, name: "Judge" }, type: JUDGE },
    { declaration: { module: nativePackage, name: "Vault" }, type: VAULT },
  ],
  constants: [{
    id: "scriptc.fixture.c-v1@0.0.0#fixture_answer",
    declaration: { module: nativePackage, name: "FixtureValue.answer" },
    type: I32,
    value: "42",
  }, {
    /* The same exact type declared as an ordinary `number`, which is the only
     * spelling a generated surface can use: mapping runs from the underlying
     * primitive, so a platform's `jint` is `number` however it is branded. */
    id: "scriptc.fixture.c-v1@0.0.0#fixture_count",
    declaration: { module: nativePackage, name: "FixtureValue.count" },
    type: I32,
    value: "17",
  }, {
    /* A constant on a CLASS, which is what merges a namespace onto one. */
    id: "scriptc.fixture.c-v1@0.0.0#counter_step",
    declaration: { module: nativePackage, name: "NativeCounter.step" },
    type: I32,
    value: "3",
  }],
  operations: [
    {
      id: "scriptc.fixture.c-v1@0.0.0#fixture_value_combine",
      declaration: { module: nativePackage, name: "FixtureValue.combine" },
      kind: "integer-reduce",
      operator: "|",
      type: I32,
    },
    /* The conversions, declared per exact type exactly as an embedder
     * synthesizes them. Arithmetic needs no entry here: it is an operator
     * expression inside a construction. */
    ...([
      ["i32", I32, true],
      ["u32", nativeScalarType("u32"), false],
      ["i64", I64, true],
      ["u64", nativeScalarType("u64"), false],
      ["f64", nativeScalarType("f64"), true],
    ] as const).flatMap(([name, type, both]) => [
      {
        id: `scriptc.fixture.c-v1@0.0.0#${name}_to_number`,
        declaration: { module: nativePackage, name: `${name}.toNumber` },
        kind: "to-number" as const,
        type,
      },
      ...(both
        ? [{
            id: `scriptc.fixture.c-v1@0.0.0#${name}_from_number`,
            declaration: { module: nativePackage, name: `${name}.fromNumber` },
            kind: "from-number" as const,
            type,
          }]
        : []),
    ]),
  ],
  types: [
    PADDED_DEFINITION,
    PAIR32_DEFINITION,
    NUMBER_PAIR32_DEFINITION,
    ANSWERED_DEFINITION,
    PAIR_F64_DEFINITION,
    NESTED_PAIR32_DEFINITION,
    COUNTER_BASE_DEFINITION,
    COUNTER_MIDDLE_DEFINITION,
    COUNTER_DEFINITION,
    TOKEN_DEFINITION,
    SHARED_DEFINITION,
    HOST_DEFINITION,
    HOST_RECEIVER_DEFINITION,
    SUBSCRIPTION_DEFINITION,
    ASKER_DEFINITION,
    TELLER_DEFINITION,
    JUDGE_DEFINITION,
    VAULT_DEFINITION,
  ],
  exports: [],
  bindings: [
    /* Checked-number flavors over the same identity symbols: source argument
     * f64, physical slot exact, both directions projected. The 64-bit and
     * pointer-width flavors are the ones whose egress can fail — a double
     * denotes every value of the narrower slots and only some of theirs. */
    ...([
      ["i32", "numberI32Identity", "nts_i32_identity"],
      ["u32", "numberU32Identity", "nts_u32_identity"],
      ["u8", "numberU8Identity", "nts_u8_identity"],
      ["i16", "numberI16Identity", "nts_i16_identity"],
      ["i64", "numberI64Identity", "nts_i64_identity"],
      ["usize", "numberUsizeIdentity", "nts_usize_identity"],
      /* The double flavor: the slot IS the source representation, so the
       * projection converts nothing and can fail at nothing. The float
       * flavor is the one crossing that is not exact — ingress rounds to
       * nearest float, egress is exact because every float is a double. */
      ["f64", "numberF64Identity", "nts_f64_identity"],
      ["f32", "numberF32Identity", "nts_f32_identity"],
    ] as const).map(([scalar, declaration, symbol]) => ({
      id: `scriptc.fixture.c-v1@0.0.0#number_${scalar}_identity`,
      declaration: { module: nativePackage, name: declaration },
      entry: { kind: "c-symbol" as const, symbol },
      callingConvention: "c" as const,
      variadic: false as const,
      sourceCall: { kind: "function" as const },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "value", type: { kind: "f64" as const } }],
      parameters: [{
        name: "value",
        type: nativeScalarType(scalar),
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: { kind: "number" as const, argument: 0, conversion: "checked" as const },
      }],
      result: {
        type: nativeScalarType(scalar),
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: { kind: "number" as const },
      },
    })),
    {
      /* Exact in, number out: the only way to hand the checked egress a value
       * no double denotes, since a number ingress can only deliver ones that
       * round-trip. */
      id: "scriptc.fixture.c-v1@0.0.0#wide_to_number",
      declaration: { module: nativePackage, name: "wideToNumber" },
      entry: { symbol: "nts_i64_passthrough" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "value", type: I64, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: I64,
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number" },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#number_pair32_transform",
      declaration: { module: nativePackage, name: "numberPair32Transform" },
      entry: { symbol: "nts_pair32_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{
        name: "value",
        type: NUMBER_PAIR32,
        passMode: "value",
        ownership: { kind: "value" },
      }]),
      result: {
        type: NUMBER_PAIR32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#cstring_array_measure",
      declaration: { module: nativePackage, name: "cstringArrayMeasure" },
      entry: { symbol: "nts_cstring_array_measure" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "items", type: { kind: "array", elem: { kind: "string" } } }],
      parameters: [{
        name: "items",
        type: { kind: "nativePointer", pointee: "ptr", const: true, addressSpace: 0 },
        passMode: "pointer" as const,
        ownership: { kind: "borrowed" as const, scope: "call" as const },
        projection: { kind: "utf8CStringArray" as const, argument: 0 },
      }],
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      /* The same vector where the source may omit it. Absence reaches the
       * callee as NULL, which a C API distinguishes from an empty vector. */
      id: "scriptc.fixture.c-v1@0.0.0#cstring_array_measure_optional",
      declaration: { module: nativePackage, name: "cstringArrayMeasureOptional" },
      entry: { symbol: "nts_cstring_array_measure_optional" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "items", type: { kind: "nullableStringArray" } }],
      parameters: [{
        name: "items",
        type: { kind: "nativePointer", pointee: "ptr", const: true, addressSpace: 0 },
        passMode: "pointer" as const,
        ownership: { kind: "borrowed" as const, scope: "call" as const },
        projection: { kind: "utf8CStringArray" as const, argument: 0 },
      }],
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      /* A vector and a plain string, in that order, so a program can make the
       * SECOND conversion throw while the first has already allocated. */
      id: "scriptc.fixture.c-v1@0.0.0#cstring_array_measure_named",
      declaration: { module: nativePackage, name: "cstringArrayMeasureNamed" },
      entry: { symbol: "nts_cstring_array_measure_named" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "items", type: { kind: "array", elem: { kind: "string" } } },
        { name: "name", type: { kind: "string" } },
      ],
      parameters: [
        {
          name: "items",
          type: { kind: "nativePointer", pointee: "ptr", const: true, addressSpace: 0 },
          passMode: "pointer" as const,
          ownership: { kind: "borrowed" as const, scope: "call" as const },
          projection: { kind: "utf8CStringArray" as const, argument: 0 },
        },
        {
          name: "name",
          type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
          passMode: "pointer" as const,
          ownership: { kind: "borrowed" as const, scope: "call" as const },
          projection: { kind: "utf8CString" as const, argument: 1 },
        },
      ],
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#answered_above",
      declaration: { module: nativePackage, name: "answeredAbove" },
      entry: { symbol: "nts_answered_above" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "value", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "threshold", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: ANSWERED,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#answered_raw",
      declaration: { module: nativePackage, name: "answeredRaw" },
      entry: { symbol: "nts_answered_raw" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{
        name: "value",
        type: ANSWERED,
        passMode: "value",
        ownership: { kind: "value" },
      }]),
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#subscribe_number",
      declaration: { module: nativePackage, name: "subscribeNumber" },
      entry: { symbol: "nts_subscription_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [{
        name: "callback",
        type: RETAINED_NUMBER_SOURCE,
        callback: RETAINED_I32_CONTRACT,
      }],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: RETAINED_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: SUBSCRIPTION,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor:
            "scriptc.fixture.c-v1@0.0.0#subscription_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#call_scoped_number",
      declaration: { module: nativePackage, name: "callScopedNumber" },
      entry: { symbol: "nts_call_scoped" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: CALL_NUMBER_SOURCE, callback: CALL_I32_CONTRACT },
        { name: "value", type: { kind: "f64" } },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
        {
          name: "value",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "number", argument: 1, conversion: "checked" },
        },
      ],
      result: {
        type: I32,
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number" },
      },
    },
    {
      /* The float flavor of the same shape: the payload slot is 32 bits and
       * the handler receives the double it widens to. */
      id: "scriptc.fixture.c-v1@0.0.0#call_scoped_f32",
      declaration: { module: nativePackage, name: "callScopedFloat" },
      entry: { symbol: "nts_call_scoped_f32" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: CALL_NUMBER_SOURCE, callback: CALL_I32_CONTRACT },
        { name: "value", type: { kind: "f64" } },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: CALL_F32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
        {
          name: "value",
          type: nativeScalarType("f32"),
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "number", argument: 1, conversion: "checked" },
        },
      ],
      result: {
        type: I32,
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "number" },
      },
    },
    ...exactIntegerBindings.map(({ scalar, declaration, symbol }) => {
      const type = nativeScalarType(scalar);
      return {
        id: `scriptc.fixture.c-v1@0.0.0#${scalar}_identity`,
        declaration: { module: nativePackage, name: declaration },
        entry: { kind: "c-symbol" as const, symbol },
        callingConvention: "c" as const,
        variadic: false as const,
        sourceCall: { kind: "function" as const },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type, passMode: "value", ownership: { kind: "value" } }]),
        result: { type, passMode: "value" as const, ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      };
    }),
    ...([
      ["nativeFalse", "nts_boolean_false"],
      ["nativeTrue", "nts_boolean_true"],
      ["nativeInvalidBoolean", "nts_boolean_invalid"],
    ] as const).map(([declaration, symbol]) => ({
      id: `scriptc.fixture.c-v1@0.0.0#${declaration}`,
      declaration: {
        module: nativePackage,
        name: declaration,
      },
      entry: {
        kind: "c-symbol" as const,
        symbol,
      },
      callingConvention: "c" as const,
      variadic: false as const,
      sourceCall: { kind: "function" as const },
      error: NO_NATIVE_ERROR,
      arguments: [],
      parameters: [],
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: {
          kind: "boolean" as const,
          conversion: "exact" as const,
          falseValue: "0",
          trueValue: "1",
        },
      },
    })),
    {
      id: "scriptc.fixture.c-v1@0.0.0#nativeNot",
      declaration: { module: nativePackage, name: "nativeNot" },
      entry: { symbol: "nts_boolean_not" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "value", type: { kind: "bool" } }],
      parameters: [{
        name: "value",
        type: I32,
        passMode: "value",
        ownership: { kind: "value" },
        projection: {
          kind: "boolean",
          argument: 0,
          falseValue: "0",
          trueValue: "1",
        },
      }],
      result: {
        type: I32,
        passMode: "value",
        ownership: { kind: "value" },
        projection: { kind: "boolean", conversion: "exact", falseValue: "0", trueValue: "1" },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#padded_roundtrip",
      declaration: { module: nativePackage, name: "paddedRoundtrip" },
      entry: { symbol: "nts_padded_roundtrip" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PADDED, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PADDED, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair32_transform",
      declaration: { module: nativePackage, name: "pair32Transform" },
      entry: { symbol: "nts_pair32_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR32, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PAIR32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair_f64_transform",
      declaration: { module: nativePackage, name: "pairF64Transform" },
      entry: { symbol: "nts_pair_f64_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR_F64, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PAIR_F64, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair_f64_verify",
      declaration: { module: nativePackage, name: "pairF64Verify" },
      entry: { symbol: "nts_pair_f64_verify" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR_F64, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#nested_pair32_transform",
      declaration: { module: nativePackage, name: "nestedPair32Transform" },
      entry: { symbol: "nts_nested_pair32_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: NESTED_PAIR32, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: NESTED_PAIR32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#hash_utf8",
      declaration: { module: nativePackage, name: "hashUtf8" },
      entry: { symbol: "nts_hash_utf8" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "string" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "utf8Data", argument: 0 },
        },
        {
          name: "length",
          type: USIZE,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "utf8ByteLength", argument: 0 },
        },
      ],
      result: { type: U64, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#c_string_observe",
      declaration: { module: nativePackage, name: "cStringObserve" },
      entry: { symbol: "nts_c_string_observe" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "string" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "utf8CString", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#nullable_c_string_observe",
      declaration: { module: nativePackage, name: "nullableCStringObserve" },
      entry: { symbol: "nts_nullable_c_string_observe" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "nullableString" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "utf8CString", argument: 0 },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#hash_bytes",
      declaration: { module: nativePackage, name: "hashBytes" },
      entry: { symbol: "nts_hash_bytes" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "bytes", elem: "u8" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "u8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "bytesData", argument: 0 },
        },
        {
          name: "length",
          type: USIZE,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "bytesLength", argument: 0, units: "elements" },
        },
      ],
      result: { type: U64, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* The same wider element on the ARGUMENT side, with a length the
       * signature wants in BYTES. Four elements is sixteen bytes, so which
       * reading crossed is a different answer rather than a subtle one. */
      id: "scriptc.fixture.c-v1@0.0.0#i32_span_bytes",
      declaration: { module: nativePackage, name: "i32SpanBytes" },
      entry: { symbol: "nts_i32_span_bytes" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "bytes", elem: "i32" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "u8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "bytesData", argument: 0 },
        },
        {
          name: "byte_length",
          type: USIZE,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "bytesLength", argument: 0, units: "bytes" },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* A span RESULT with a wider element. The physical slot is still a
       * pointer to bytes — the element size is the managed side's business —
       * and the length slot counts ELEMENTS, which is the whole difference
       * this binding exists to prove. */
      id: "scriptc.fixture.c-v1@0.0.0#i32_span_make",
      declaration: { module: nativePackage, name: "i32SpanMake" },
      entry: { symbol: "nts_i32_span_make" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "count", type: I32 }],
      parameters: [
        {
          name: "count",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "out_length",
          type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "bytesLengthOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "u8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "bytes",
          elem: "i32",
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      /* A callee that answers NULL where the contract says a span. Its
       * result contract is identical to the one below; only the C behaves
       * badly, which is the point. */
      id: "scriptc.fixture.c-v1@0.0.0#bytes_absent",
      declaration: { module: nativePackage, name: "bytesAbsent" },
      entry: { symbol: "nts_bytes_absent" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [],
      parameters: [
        {
          name: "out_length",
          type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "bytesLengthOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "u8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: { kind: "bytes", elem: "u8", release: { kind: "none" } },
      },
    },
    {
      /* A byte span in and a byte span out. The input's length is a sibling
       * parameter the CALLER fills; the output's arrives in the compiler's
       * own slot, which nothing in the program supplies. Same word, two
       * mechanisms — which is why they are two projections. */
      /* UTF-8 text arriving as a pointer and a length, in both nullabilities.
       * The fixture's text contains a NUL, so a lowering that scanned for a
       * terminator answers a shorter string that looks correct — which is the
       * only way to tell the two apart. */
      id: "scriptc.fixture.c-v1@0.0.0#span_label",
      declaration: { module: nativePackage, name: "spanLabel" },
      entry: { symbol: "nts_span_label" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [],
      parameters: [
        {
          name: "out_length",
          type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "bytesLengthOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "utf8Span",
          nullable: false,
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#span_label_maybe",
      declaration: { module: nativePackage, name: "spanLabelMaybe" },
      entry: { symbol: "nts_span_label_maybe" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "which", type: I32 }],
      parameters: [
        {
          name: "which",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "out_length",
          type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "bytesLengthOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "utf8Span",
          nullable: true,
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#bytes_reverse",
      declaration: { module: nativePackage, name: "bytesReverse" },
      entry: { symbol: "nts_bytes_reverse" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "data", type: { kind: "bytes", elem: "u8" } }],
      parameters: [
        {
          name: "data",
          type: { kind: "nativePointer", pointee: "u8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "bytesData", argument: 0 },
        },
        {
          name: "length",
          type: USIZE,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "bytesLength", argument: 0, units: "elements" },
        },
        {
          name: "out_length",
          type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "bytesLengthOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "u8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "bytes",
          elem: "u8",
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#call_scoped",
      declaration: { module: nativePackage, name: "callScoped" },
      entry: { symbol: "nts_call_scoped" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
        { name: "value", type: I32 },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
        {
          name: "value",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 1 },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#error_handle_fail",
      declaration: { module: nativePackage, name: "errorHandleFail" },
      entry: { symbol: "nts_error_handle_fail" },
      sourceCall: { kind: "function" },
      error: {
        detect: { kind: "resultIsNotNull" },
        message: { kind: "symbol", symbol: "nts_fixture_error_message" },
        release: { kind: "symbol", symbol: "nts_fixture_error_free" },
      },
      ...directSignature([
        { name: "code", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: { kind: "errorChannel" },
      },
    },
    {
      /* The shape an absorbing adapter cannot serve: failure arrives in a
       * slot, so the result stays the call's own. */
      id: "scriptc.fixture.c-v1@0.0.0#error_out_divide",
      declaration: { module: nativePackage, name: "errorOutDivide" },
      entry: { symbol: "nts_error_out_divide" },
      sourceCall: { kind: "function" },
      error: {
        detect: { kind: "outParameterIsNotNull", parameter: 2 },
        message: { kind: "symbol", symbol: "nts_fixture_error_message" },
        release: { kind: "symbol", symbol: "nts_fixture_error_free" },
      },
      arguments: [
        { name: "numerator", type: I32 },
        { name: "divisor", type: I32 },
      ],
      parameters: [
        {
          name: "numerator",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "divisor",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 1 },
        },
        {
          name: "error",
          type: { kind: "nativeErrorOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "errorOut" },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    /* The same failure channel with a SUB-WORD result — the pair that had no
     * representative until now. The extension attribute a u8/i8 result
     * carries belongs on a call and on a declare, and is a syntax error in
     * every position that wants a bare type; the failure slot is what drives
     * the emitter into one of those positions. */
    ...([
      ["u8", U8, "errorOutU8", "nts_error_out_u8"],
      ["i8", I8, "errorOutI8", "nts_error_out_i8"],
    ] as const).map(([scalar, type, declaration, symbol]) => ({
      id: `scriptc.fixture.c-v1@0.0.0#error_out_${scalar}`,
      declaration: { module: nativePackage, name: declaration },
      entry: { symbol },
      sourceCall: { kind: "function" as const },
      error: {
        detect: { kind: "outParameterIsNotNull" as const, parameter: 1 },
        message: { kind: "symbol" as const, symbol: "nts_fixture_error_message" },
        release: { kind: "symbol" as const, symbol: "nts_fixture_error_free" },
      },
      arguments: [{ name: "value", type: I32 }],
      parameters: [
        {
          name: "value",
          type: I32,
          passMode: "value" as const,
          ownership: { kind: "value" as const },
          projection: { kind: "argument" as const, argument: 0 },
        },
        {
          name: "error",
          type: { kind: "nativeErrorOut" as const, addressSpace: 0 },
          passMode: "pointer" as const,
          ownership: { kind: "value" as const },
          projection: { kind: "errorOut" as const },
        },
      ],
      result: {
        type,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    })),
    {
      /* The same failure channel with a STRING result the caller must free.
       * The failure arrives in a slot and reads nothing, so the result is
       * free to mean something — and the unwind has to precede both the copy
       * and the release, which the fixture makes observable by answering a
       * dangling non-null pointer on the failing path. */
      id: "scriptc.fixture.c-v1@0.0.0#error_out_label",
      declaration: { module: nativePackage, name: "errorOutLabel" },
      entry: { symbol: "nts_error_out_label" },
      sourceCall: { kind: "function" },
      error: {
        detect: { kind: "outParameterIsNotNull", parameter: 1 },
        message: { kind: "symbol", symbol: "nts_fixture_error_message" },
        release: { kind: "symbol", symbol: "nts_fixture_error_free" },
      },
      arguments: [{ name: "code", type: I32 }],
      parameters: [
        {
          name: "code",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "error",
          type: { kind: "nativeErrorOut", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "errorOut" },
        },
      ],
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "utf8CString",
          nullable: false,
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#fixture_errors_outstanding",
      declaration: { module: nativePackage, name: "fixtureErrorsOutstanding" },
      entry: { symbol: "nts_fixture_errors_outstanding" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#fail_errno",
      declaration: { module: nativePackage, name: "failErrno" },
      entry: { symbol: "nts_fail_errno" },
      sourceCall: { kind: "function" },
      error: errnoFailure("-1"),
      ...directSignature([
        { name: "error_number", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* A callee that takes ownership of a handle argument: the reference
       * moves at the call and the handle is spent afterwards, which is the
       * shape `gtk_widget_add_controller` has. */
      id: "scriptc.fixture.c-v1@0.0.0#vault_create",
      declaration: { module: nativePackage, name: "createVault" },
      entry: { symbol: "nts_vault_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      ...directSignature([]),
      result: {
        type: VAULT,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#vault_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#vault_adopt",
      declaration: { module: nativePackage, name: "Vault.adopt" },
      entry: { symbol: "nts_vault_adopt" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "vault", type: VAULT },
        { name: "counter", type: COUNTER },
      ],
      parameters: [
        {
          name: "vault",
          type: VAULT,
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "counter",
          type: COUNTER,
          passMode: "pointer",
          ownership: { kind: "owned", transfer: "to-native" },
          projection: { kind: "argument", argument: 1 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#vault_value",
      declaration: { module: nativePackage, name: "Vault.value" },
      entry: { symbol: "nts_vault_value" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "vault", type: VAULT, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#vault_destroy",
      declaration: { module: nativePackage, name: "Vault.dispose" },
      entry: { symbol: "nts_vault_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        {
          name: "vault",
          type: VAULT,
          passMode: "pointer",
          ownership: { kind: "owned", transfer: "to-native" },
        },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* Registration for a callback the emitter asks. The handle it returns
       * owns the registration, and disposing it is the cancellation. */
      id: "scriptc.fixture.c-v1@0.0.0#asker_create",
      declaration: { module: nativePackage, name: "askFor" },
      entry: { symbol: "nts_asker_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        { name: "callback", type: ASK_I32_SOURCE, callback: ASK_I32_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: ASK_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: ASKER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#asker_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      /* The boolean flavor of the same registration, over the same C
       * symbols: the handler answers true or false and the emitter reads the
       * exact storage value each one means. */
      /* The two synchronous registrations that hold an object. Their callbacks
       * differ only in what comes back, which is the axis these fixtures
       * exist to separate. */
      /* Called by the handler, so the mark appearing before `tell` returns is
       * what separates synchronous delivery from queued. */
      /* A registration nothing owns, reached through a MANIFEST rather than a
       * hand-built module — which is the path materializeNativeCallbackContract
       * takes and the one no test travelled. */
      id: "scriptc.fixture.c-v1@0.0.0#notice_register",
      declaration: { module: nativePackage, name: "noticeWith" },
      entry: { symbol: "nts_notice_register" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: TELL_SOURCE, callback: NOTICE_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: TELL_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#maybe_register",
      declaration: { module: nativePackage, name: "maybeWith" },
      entry: { symbol: "nts_maybe_register" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: MAYBE_SOURCE, callback: MAYBE_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: TELL_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    /* TWO registrations on one class, which is what makes a field observable:
     * one dispatch writes it and a later one reads it. `onSettle` is the
     * TERMINAL dispatch — the platform is finished with the object, and it is
     * where a peer's last reference has to go. */
    {
      id: HOST_PEER_READ,
      declaration: { module: nativePackage, name: "Host.peerSlotRead" },
      entry: { symbol: "nts_host_peer" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: HOST_RECEIVER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "ptr", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: { kind: "peerSlotValue" },
      },
    },
    {
      id: HOST_PEER_WRITE,
      declaration: { module: nativePackage, name: "Host.peerSlotWrite" },
      entry: { symbol: "nts_host_set_peer" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [{ name: "self", type: HOST_RECEIVER }],
      parameters: [
        {
          name: "self",
          type: HOST_RECEIVER,
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "peer",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "value" },
          projection: { kind: "peerSlotValue" },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#host_register_open",
      declaration: { module: nativePackage, name: "Widget.onOpen" },
      entry: { symbol: "nts_host_register_open" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: HOST_OPEN_SOURCE, callback: HOST_OPEN_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: HOST_OPEN_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#host_register_settle",
      terminal: true,
      declaration: { module: nativePackage, name: "Widget.onSettle" },
      entry: { symbol: "nts_host_register_settle" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: HOST_SETTLE_SOURCE, callback: HOST_SETTLE_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: HOST_SETTLE_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: HOST_RELEASE,
      declaration: { module: nativePackage, name: "Host.dispose" },
      entry: { symbol: "nts_host_release" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: HOST, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#host_report",
      declaration: { module: nativePackage, name: "Host.report" },
      entry: { symbol: "nts_host_report" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: HOST, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#host_run",
      declaration: { module: nativePackage, name: "hostRun" },
      entry: { symbol: "nts_host_run" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#host_outstanding",
      declaration: { module: nativePackage, name: "hostOutstanding" },
      entry: { symbol: "nts_host_outstanding" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* The platform shape: a registration whose handler is a MEMBER of the
       * receiver's own class. The callback takes the receiver first and the
       * call's argument after, which is the order a lowered method already
       * has — its `this` is parameter zero — so an override lowers straight
       * into this slot with no adapter between. */
      id: "scriptc.fixture.c-v1@0.0.0#tick_register",
      declaration: { module: nativePackage, name: "Ticker.onTick" },
      /* The binding `super.onTick(...)` reaches. A DISTINCT operation from the
       * one the platform calls, which is what stops super redispatching to the
       * override — and stated here because a class file cannot say which
       * method is another method's base. */
      baseCall: "scriptc.fixture.c-v1@0.0.0#tick_base",
      entry: { symbol: "nts_tick_register" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "callback", type: TICK_SOURCE_TYPE, callback: TICK_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: TICK_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#tick_base",
      declaration: { module: nativePackage, name: "TickSource.baseTick" },
      entry: { symbol: "nts_tick_base" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        /* Declared over the BASE, which is what a superclass bridge is: the
         * receiver widens on its way in, exactly as it does for an inherited
         * member reached through `this`. */
        { name: "self", type: COUNTER_MIDDLE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* A binding on a class the surface maps NO handle type to. The pairing
       * is what a selection that dropped a type produces: members bind, the
       * import resolves, and nothing names the object they are members of. */
      id: "scriptc.fixture.c-v1@0.0.0#unmapped_value",
      declaration: { module: nativePackage, name: "UnmappedSource.value" },
      entry: { symbol: "nts_counter_value" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: COUNTER_MIDDLE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* The base's OWN member, callable and virtual — the shape a platform
       * surface always has, because a base that declares a lifecycle member
       * declares it as a method. `super.onTick(...)` must reach the bridge
       * above and never this, and without this binding present nothing in the
       * fixture could tell the two apart. */
      id: "scriptc.fixture.c-v1@0.0.0#tick_virtual",
      declaration: { module: nativePackage, name: "TickSource.onTick" },
      entry: { symbol: "nts_tick_virtual" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: COUNTER_MIDDLE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#tick_mark",
      declaration: { module: nativePackage, name: "tickMark" },
      entry: { symbol: "nts_tick_mark" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#tick_fire",
      declaration: { module: nativePackage, name: "tickFire" },
      entry: { symbol: "nts_tick_fire" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#tick_value",
      declaration: { module: nativePackage, name: "TickSource.value" },
      entry: { symbol: "nts_counter_value" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "self", type: COUNTER_MIDDLE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* A nested class reached as a RESULT and then as a RECEIVER: the first
       * needs its dotted type name to resolve as a RESULT, the second as a
       * PARAMETER — which is the position the platform case fails in, where a
       * listener is handed to `setOnClickListener`. */
      id: "scriptc.fixture.c-v1@0.0.0#nested_create",
      declaration: { module: nativePackage, name: "makeNested" },
      entry: { symbol: "nts_counter_create" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "initial_value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: COUNTER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#nested_value",
      declaration: { module: nativePackage, name: "useNested" },
      entry: { symbol: "nts_counter_value" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* A second registration over the same C constructor, differing only in
       * what its handler is handed. Two bindings may name one symbol because a
       * binding declares a contract rather than a symbol — but only one of
       * them may be REACHED per module: the validator refuses a duplicate
       * Native IR C symbol, so a program picks the contract it means. */
      id: "scriptc.fixture.c-v1@0.0.0#maybe_judge_create",
      declaration: { module: nativePackage, name: "maybeJudgeWith" },
      entry: { symbol: "nts_judge_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        { name: "callback", type: MAYBE_JUDGE_SOURCE, callback: MAYBE_JUDGE_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: JUDGE_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: JUDGE,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#judge_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#judge_ask_maybe",
      declaration: { module: nativePackage, name: "Judge.askMaybe" },
      entry: { symbol: "nts_judge_ask_maybe" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "judge", type: JUDGE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "code", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#maybe_mark",
      declaration: { module: nativePackage, name: "maybeMark" },
      entry: { symbol: "nts_maybe_mark" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#maybe_fire",
      declaration: { module: nativePackage, name: "maybeFire" },
      entry: { symbol: "nts_maybe_fire" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#notice_mark",
      declaration: { module: nativePackage, name: "noticeMark" },
      entry: { symbol: "nts_notice_mark" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#notice_fire",
      declaration: { module: nativePackage, name: "noticeFire" },
      entry: { symbol: "nts_notice_fire" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#tell_mark",
      declaration: { module: nativePackage, name: "tellMark" },
      entry: { symbol: "nts_tell_mark" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#teller_create",
      declaration: { module: nativePackage, name: "tellWith" },
      entry: { symbol: "nts_teller_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        { name: "callback", type: TELL_SOURCE, callback: TELL_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: TELL_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: TELLER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#teller_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#teller_destroy",
      declaration: { module: nativePackage, name: "Teller.dispose" },
      entry: { symbol: "nts_teller_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "teller", type: TELLER, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#teller_tell",
      declaration: { module: nativePackage, name: "Teller.tell" },
      entry: { symbol: "nts_teller_tell" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "teller", type: TELLER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#judge_create",
      declaration: { module: nativePackage, name: "judgeWith" },
      entry: { symbol: "nts_judge_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        { name: "callback", type: JUDGE_SOURCE, callback: JUDGE_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: JUDGE_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: JUDGE,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#judge_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#judge_destroy",
      declaration: { module: nativePackage, name: "Judge.dispose" },
      entry: { symbol: "nts_judge_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "judge", type: JUDGE, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#judge_ask",
      declaration: { module: nativePackage, name: "Judge.ask" },
      entry: { symbol: "nts_judge_ask" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "judge", type: JUDGE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "code", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "seed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#answerer_create",
      declaration: { module: nativePackage, name: "answerWith" },
      entry: { symbol: "nts_answerer_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        { name: "callback", type: ASK_BOOL_SOURCE, callback: ASK_BOOL_CONTRACT },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: ASK_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: ASKER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#answerer_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#answerer_destroy",
      declaration: { module: nativePackage, name: "Answerer.dispose" },
      entry: { symbol: "nts_answerer_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        {
          name: "asker",
          type: ASKER,
          passMode: "pointer",
          ownership: { kind: "owned", transfer: "to-native" },
        },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#asker_ask",
      declaration: { module: nativePackage, name: "Asker.ask" },
      entry: { symbol: "nts_asker_ask" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "asker", type: ASKER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#asker_asked",
      declaration: { module: nativePackage, name: "Asker.asked" },
      entry: { symbol: "nts_asker_asked" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "asker", type: ASKER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#asker_destroy",
      declaration: { module: nativePackage, name: "Asker.dispose" },
      entry: { symbol: "nts_asker_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        {
          name: "asker",
          type: ASKER,
          passMode: "pointer",
          ownership: { kind: "owned", transfer: "to-native" },
        },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#subscription_create",
      declaration: { module: nativePackage, name: "subscribe" },
      entry: { symbol: "nts_subscription_create" },
      sourceCall: { kind: "function" },
      error: NULL_IS_FAILURE,
      arguments: [
        {
          name: "callback",
          type: RETAINED_I32_SOURCE,
          callback: RETAINED_I32_CONTRACT,
        },
      ],
      parameters: [
        {
          name: "callback",
          type: { kind: "nativeCallback", signature: RETAINED_I32_CALLBACK },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback" },
          projection: { kind: "callbackContext", argument: 0 },
        },
      ],
      result: {
        type: SUBSCRIPTION,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor:
            "scriptc.fixture.c-v1@0.0.0#subscription_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#subscription_destroy",
      declaration: { module: nativePackage, name: "Subscription.dispose" },
      entry: { symbol: "nts_subscription_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        {
          name: "subscription",
          type: SUBSCRIPTION,
          passMode: "pointer",
          ownership: { kind: "owned", transfer: "to-native" },
        },
      ]),
      result: {
        type: NATIVE_VOID,
        passMode: "value",
        ownership: { kind: "value" },
        projection: DIRECT_RESULT,
      },
    },
    ...(["emit", "emitForeign"] as const).map((method) => ({
      id:
        `scriptc.fixture.c-v1@0.0.0#subscription_${method === "emit" ? "emit" : "emit_foreign"}`,
      declaration: { module: nativePackage, name: `Subscription.${method}` },
      entry: {
        kind: "c-symbol" as const,
        symbol:
          method === "emit"
            ? "nts_subscription_emit"
            : "nts_subscription_emit_foreign",
      },
      callingConvention: "c" as const,
      variadic: false as const,
      sourceCall: { kind: "method" as const, receiverArgument: 0 },
      error: errnoFailure("-1"),
      ...directSignature([
        {
          name: "subscription",
          type: SUBSCRIPTION,
          passMode: "pointer",
          ownership: { kind: "borrowed" as const, scope: "call" as const },
        },
        {
          name: "value",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" as const },
        },
      ]),
      result: {
        type: I32,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    })),
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_add",
      declaration: { module: nativePackage, name: "Counter.add" },
      entry: { symbol: "nts_counter_add" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "delta", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_create",
      declaration: { module: nativePackage, name: "createCounter" },
      entry: { symbol: "nts_counter_create" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "initial_value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: COUNTER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      /* One source constructor whose binding supplies both mechanics arms.
       * The compiler, not this manifest, decides which call sites may use the
       * frame-bounded entry. */
      id: "scriptc.fixture.c-v1@0.0.0#frame_counter_create",
      declaration: { module: nativePackage, name: "createFrameCounter" },
      entry: { symbol: "nts_frame_counter_create_stable" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "initial_value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: COUNTER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
        },
        projection: DIRECT_RESULT,
        frameBounded: {
          entry: { symbol: "nts_frame_counter_create_local" },
          release: { symbol: "nts_frame_counter_release_local" },
        },
      },
    },
    {
      /* The same capability with absence as a successful result. The raw
       * frame representation uses NULL for the absent source arm; only a
       * present pointer owns a resource that the release entry must end. */
      id: "scriptc.fixture.c-v1@0.0.0#frame_counter_create_maybe",
      declaration: { module: nativePackage, name: "createFrameCounterMaybe" },
      entry: { symbol: "nts_frame_counter_create_maybe_stable" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "initial_value", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: COUNTER,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
        },
        projection: { kind: "nullableHandle" },
        frameBounded: {
          entry: { symbol: "nts_frame_counter_create_maybe_local" },
          release: { symbol: "nts_frame_counter_release_local" },
        },
      },
    },
    ...([
      ["frameResourceReset", "nts_frame_resource_reset", NATIVE_VOID],
      ["frameGlobalPromotions", "nts_frame_global_promotion_count", I32],
      ["frameLocalReleases", "nts_frame_local_release_count", I32],
      ["frameManagedCells", "nts_frame_managed_cell_count", I32],
    ] as const).map(([name, symbol, resultType]) => ({
      id: `scriptc.fixture.c-v1@0.0.0#${name}`,
      declaration: { module: nativePackage, name },
      entry: { symbol },
      sourceCall: { kind: "function" as const },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: {
        type: resultType,
        passMode: "value" as const,
        ownership: { kind: "value" as const },
        projection: DIRECT_RESULT,
      },
    })),
    {
      id: "scriptc.fixture.c-v1@0.0.0#frameExpectedManagedCells",
      declaration: { module: nativePackage, name: "frameExpectedManagedCells" },
      entry: { symbol: "nts_frame_expected_managed_cells" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "expected", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* Hands out the SAME pointer every time, under a reference count. Under
       * a `pointer` handle the second call would find the first cell; under
       * `none` it builds another, and the count proves two references really
       * were taken rather than one being handed back twice. */
      id: "scriptc.fixture.c-v1@0.0.0#token_acquire",
      declaration: { module: nativePackage, name: "tokenAcquire" },
      entry: { symbol: "nts_token_acquire" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: {
        type: TOKEN,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#token_release",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#shared_acquire",
      declaration: { module: nativePackage, name: "sharedAcquire" },
      entry: { symbol: "nts_shared_acquire" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: {
        type: SHARED,
        passMode: "pointer",
        ownership: {
          kind: "owned",
          transfer: "to-runtime",
          destructor: "scriptc.fixture.c-v1@0.0.0#shared_release",
        },
        projection: DIRECT_RESULT,
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#shared_release",
      declaration: { module: nativePackage, name: "Shared.dispose" },
      entry: { symbol: "nts_shared_release" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "token", type: SHARED, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#token_release",
      declaration: { module: nativePackage, name: "Token.dispose" },
      entry: { symbol: "nts_token_release" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "token", type: TOKEN, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#token_value",
      declaration: { module: nativePackage, name: "Token.value" },
      entry: { symbol: "nts_token_value" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "token", type: TOKEN, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#token_outstanding",
      declaration: { module: nativePackage, name: "tokenOutstanding" },
      entry: { symbol: "nts_token_outstanding" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
      declaration: { module: nativePackage, name: "Counter.dispose" },
      entry: { symbol: "nts_counter_destroy" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_destroyed_count",
      declaration: { module: nativePackage, name: "counterDestroyedCount" },
      entry: { symbol: "nts_counter_destroyed_count" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_value_or",
      declaration: { module: nativePackage, name: "counterValueOr" },
      entry: { symbol: "nts_counter_value_or" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      // The source argument is optional while the ABI slot stays one pointer,
      // so arguments and parameters differ here and directSignature does not
      // apply.
      arguments: [
        { name: "counter", type: { kind: "nullableNativeHandle", typeId: COUNTER_ID } },
        { name: "fallback", type: I32 },
      ],
      parameters: [
        {
          name: "counter",
          type: COUNTER,
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "fallback",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 1 },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      /* The same optional slot declared over the base of the hierarchy: a
       * Counter argument is two identity upcasts below the arm it has to
       * take, which is the shape any nullable base-typed object input has. */
      id: "scriptc.fixture.c-v1@0.0.0#counter_base_value_or",
      declaration: { module: nativePackage, name: "counterBaseValueOr" },
      entry: { symbol: "nts_counter_base_value_or" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      arguments: [
        { name: "counter", type: { kind: "nullableNativeHandle", typeId: COUNTER_BASE_ID } },
        { name: "fallback", type: I32 },
      ],
      parameters: [
        {
          name: "counter",
          type: COUNTER_BASE,
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "call" },
          projection: { kind: "argument", argument: 0 },
        },
        {
          name: "fallback",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: { kind: "argument", argument: 1 },
        },
      ],
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_value",
      declaration: { module: nativePackage, name: "CounterBase.value" },
      entry: { symbol: "nts_counter_value" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER_BASE, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_label",
      declaration: { module: nativePackage, name: "Counter.label" },
      entry: { symbol: "nts_counter_label" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
        projection: { kind: "utf8CString", nullable: true, release: { kind: "none" } },
      },
    },
    {
      /* Borrowed: the receiver keeps the vector, so nothing is freed and the
       * result anchors to the counter exactly as a borrowed string does. */
      id: "scriptc.fixture.c-v1@0.0.0#counter_tags",
      declaration: { module: nativePackage, name: "Counter.tags" },
      entry: { symbol: "nts_counter_tags" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "ptr", const: true, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
        projection: {
          kind: "utf8CStringArray",
          nullable: false,
          release: { kind: "none" },
        },
      },
    },
    {
      /* Freed by the caller once its bytes are copied. Same field, same
       * question as the vector below — one element instead of many. */
      id: "scriptc.fixture.c-v1@0.0.0#cstring_made",
      declaration: { module: nativePackage, name: "cstringMade" },
      entry: { symbol: "nts_cstring_made" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "count", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "utf8CString",
          nullable: true,
          release: { kind: "symbol", symbol: "nts_cstring_free" },
        },
      },
    },
    {
      /* Freed by the caller: the projection consumes the vector, so the
       * result is a `value` and the symbol that frees it is named on the
       * projection. A handle's `destructor` names a BINDING instead, which
       * this could not be — no argument can carry a raw vector. */
      id: "scriptc.fixture.c-v1@0.0.0#cstring_array_made",
      declaration: { module: nativePackage, name: "cstringArrayMade" },
      entry: { symbol: "nts_cstring_array_made" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "count", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "ptr", const: false, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "value" },
        projection: {
          kind: "utf8CStringArray",
          nullable: true,
          release: { kind: "symbol", symbol: "nts_cstring_array_free" },
        },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_required_label",
      declaration: { module: nativePackage, name: "Counter.requiredLabel" },
      entry: { symbol: "nts_counter_required_label" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
        projection: { kind: "utf8CString", nullable: false, release: { kind: "none" } },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_verify",
      declaration: { module: nativePackage, name: "counterVerify" },
      entry: { symbol: "nts_counter_verify" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "actual_value", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "actual_destroyed", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "expected_value", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "expected_destroyed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
  ],
};

function frontendNativeInput(): NativeFrontendInput {
  const configured = process.env["SCRIPTC_NATIVE_FRONTEND_INPUT"];
  const translated = configured === undefined
    ? localNativeInput
    : JSON.parse(configured) as NativeFrontendInput;
  return {
    target: translated.target,
    sourceTypes: [
      ...translated.sourceTypes,
      {
        declaration: { module: "scriptc-native-test", name: "isize" },
        type: ISIZE,
      },
    ],
    constants: translated.constants,
    operations: translated.operations,
    types: translated.types,
    exports: translated.exports,
    bindings: [
      ...translated.bindings,
      {
        id: "scriptc-test@1#isize-identity",
        declaration: { module: "scriptc-native-test", name: "isizeIdentity" },
        entry: { symbol: "scriptc_test_isize_identity" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: ISIZE, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: ISIZE, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#exit",
        declaration: { module: "scriptc-native-test", name: "exit" },
        entry: { symbol: "exit" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "status", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#unused",
        declaration: { module: "scriptc-native-test", name: "unused" },
        entry: { symbol: "scriptc_test_unlinked" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-exact-integers",
        declaration: { module: "scriptc-native-test", name: "verifyExactIntegers" },
        entry: { symbol: "scriptc_test_verify_exact_integers" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "signed8", type: I8, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsigned8", type: U8, passMode: "value", ownership: { kind: "value" as const } },
          { name: "signed16", type: I16, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsigned16", type: U16, passMode: "value", ownership: { kind: "value" as const } },
          { name: "signed32", type: I32, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsigned32", type: U32, passMode: "value", ownership: { kind: "value" as const } },
          { name: "signed64", type: I64, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsigned64", type: U64, passMode: "value", ownership: { kind: "value" as const } },
          { name: "signedSize", type: ISIZE, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsignedSize", type: USIZE, passMode: "value", ownership: { kind: "value" as const } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-padded",
        declaration: { module: "scriptc-native-test", name: "verifyPadded" },
        entry: { symbol: "scriptc_test_verify_padded" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "value", type: PADDED, passMode: "value", ownership: { kind: "value" as const } },
          { name: "tag", type: U8, passMode: "value", ownership: { kind: "value" as const } },
          { name: "scalarValue", type: U64, passMode: "value", ownership: { kind: "value" as const } },
          { name: "ratio", type: NATIVE_F64, passMode: "value", ownership: { kind: "value" as const } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-utf8-hash",
        declaration: { module: "scriptc-native-test", name: "verifyUtf8Hash" },
        entry: { symbol: "scriptc_test_verify_utf8_hash" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "actual", type: U64, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-bytes-hash",
        declaration: { module: "scriptc-native-test", name: "verifyBytesHash" },
        entry: { symbol: "scriptc_test_verify_bytes_hash" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "actual", type: U64, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-call-scoped",
        declaration: { module: "scriptc-native-test", name: "verifyCallScoped" },
        entry: { symbol: "scriptc_test_verify_call_scoped" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "forwarded", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "captured", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#callback-errno",
        declaration: { module: "scriptc-native-test", name: "callbackErrno" },
        entry: { symbol: "scriptc_test_callback_errno" },
        sourceCall: { kind: "function" },
        error: errnoFailure("-1"),
        arguments: [
          { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
          { name: "value", type: I32 },
        ],
        parameters: [
          {
            name: "callback",
            type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackFunction", argument: 0 },
          },
          {
            name: "context",
            type: { kind: "nativeContext", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackContext", argument: 0 },
          },
          {
            name: "value",
            type: I32,
            passMode: "value",
            ownership: { kind: "value" },
            projection: { kind: "argument", argument: 1 },
          },
        ],
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#nullable-counter",
        declaration: { module: "scriptc-native-test", name: "createNullableCounter" },
        entry: { symbol: "scriptc_test_nullable_counter" },
        sourceCall: { kind: "function" },
        error: NULL_IS_FAILURE,
        ...directSignature([
          { name: "succeed", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: {
          type: COUNTER,
          passMode: "pointer",
          ownership: {
            kind: "owned",
            transfer: "to-runtime",
            destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
          },
          projection: DIRECT_RESULT,
        },
      },
      {
        id: "scriptc-test@1#callback-nullable-counter",
        declaration: { module: "scriptc-native-test", name: "callbackNullableCounter" },
        entry: { symbol: "scriptc_test_callback_nullable_counter" },
        sourceCall: { kind: "function" },
        error: NULL_IS_FAILURE,
        arguments: [
          { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
          { name: "succeed", type: I32 },
        ],
        parameters: [
          {
            name: "callback",
            type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackFunction", argument: 0 },
          },
          {
            name: "context",
            type: { kind: "nativeContext", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "callback" },
            projection: { kind: "callbackContext", argument: 0 },
          },
          {
            name: "succeed",
            type: I32,
            passMode: "value",
            ownership: { kind: "value" },
            projection: { kind: "argument", argument: 1 },
          },
        ],
        result: {
          type: COUNTER,
          passMode: "pointer",
          ownership: {
            kind: "owned",
            transfer: "to-runtime",
            destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
          },
          projection: DIRECT_RESULT,
        },
      },
      ...([
        ["callbacksConfigure", "scriptc_test_callbacks_configure", []],
        [
          "callbacksWaitAndDispatch",
          "scriptc_test_callbacks_wait_and_dispatch",
          [
            {
              name: "expectedWakes",
              type: I32,
              passMode: "value",
              ownership: { kind: "value" },
            },
          ],
        ],
        ["callbacksActive", "scriptc_test_callbacks_active", []],
        ["callbacksShutdown", "scriptc_test_callbacks_shutdown", []],
      ] as const).map(([name, symbol, parameters]) => ({
        id: `scriptc-test@1#${name}`,
        declaration: { module: "scriptc-native-test", name },
        entry: { kind: "c-symbol" as const, symbol },
        callingConvention: "c" as const,
        variadic: false as const,
        sourceCall: { kind: "function" as const },
        error: NO_NATIVE_ERROR,
        ...directSignature(parameters),
        result: {
          type: I32,
          passMode: "value" as const,
          ownership: { kind: "value" as const },
          projection: DIRECT_RESULT,
        },
      })),
      {
        id: "scriptc-test@1#callbacksConfigureAttached",
        declaration: {
          module: "scriptc-native-test",
          name: "callbacksConfigureAttached",
        },
        entry: { symbol: "scriptc_test_callbacks_configure_attached",
        },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([]),
        result: {
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: DIRECT_RESULT,
        },
      },
      {
        id: "scriptc-test@1#callbacksConfigureAttachedTimer",
        declaration: {
          module: "scriptc-native-test",
          name: "callbacksConfigureAttachedTimer",
        },
        entry: { symbol: "scriptc_test_callbacks_configure_attached_timer",
        },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([]),
        result: {
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
          projection: DIRECT_RESULT,
        },
      },
      {
        id: "scriptc-test@1#callbacksObserveAttached",
        declaration: {
          module: "scriptc-native-test",
          name: "callbacksObserveAttached",
        },
        entry: { symbol: "scriptc_test_callbacks_observe_attached",
        },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{
          name: "value",
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
        }]),
        result: {
          type: NATIVE_VOID,
          passMode: "value",
          ownership: { kind: "value" },
          projection: DIRECT_RESULT,
        },
      },
      {
        id: "scriptc-test@1#verify-retained",
        declaration: { module: "scriptc-native-test", name: "verifyRetained" },
        entry: { symbol: "scriptc_test_verify_retained" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "total", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "activeBefore", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "activeAfter", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "shutdown", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      },
    ],
  };
}

/** A few compiler-focused cases intentionally extend the in-tree fixture
 * with declarations and C symbols that an embedder-supplied fixture does
 * not promise. Keep those cases in the ordinary suite, but do not treat
 * absent test-only symbols as failures of an externally supplied frontend
 * program. */
const localFixtureTest = process.env["SCRIPTC_NATIVE_FRONTEND_INPUT"] === undefined
  ? test
  : test.skip;

function nativeExternalTypes(): Record<string, string> {
  const declarations =
    process.env["SCRIPTC_NATIVE_IR_DECLARATIONS"] ??
    join(repoRoot, "tests/native-ir/package.d.ts");
  return {
    "@scriptc/native-abi-fixture": declarations,
    "scriptc-native-test": join(repoRoot, "tests/native-ir/support.d.ts"),
  };
}

afterAll(() => { if (process.env["AB_KEEP"] !== "1") rmSync(scratch, { recursive: true, force: true }); });

describe.each(["llvm", "c"] as const)("exact Native IR library exports, %s emission", (emission) => {
  test("exports an exact i32 TypeScript function to a C host", async () => {
    const outDir = join(scratch, `native-export-${emission}`);
    mkdirSync(outDir, { recursive: true });
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "native-ir-export-conformance",
      entry: join(repoRoot, "tests/native-ir/export-library.ts"),
      emission,
      abi: {
        prefix: "nx_",
        init_symbol: "nx_init",
        sink_register_symbol: "nx_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
      },
      exports: [],
    }, null, 2));

    const configuredNative = process.env["SCRIPTC_NATIVE_EXPORT_FRONTEND_INPUT"];
    const native: NativeFrontendInput = configuredNative === undefined
      ? {
          target: localNativeInput.target,
          sourceTypes: localNativeInput.sourceTypes,
          types: [],
          bindings: [],
          exports: [{
            id: "scriptc.fixture.c-v1@0.0.0#ts_add_i32",
            sourceExport: "ntsTsAddI32",
            declaration: {
              module: nativePackage,
              name: "FixtureLibraryExports.ntsTsAddI32",
            },
            entry: { symbol: "nts_ts_add_i32" },
            error: NO_NATIVE_ERROR,
            parameters: [
              { name: "left", type: I32, passMode: "value", ownership: { kind: "value" } },
              { name: "right", type: I32, passMode: "value", ownership: { kind: "value" } },
            ],
            result: { type: I32, passMode: "value", ownership: { kind: "value" } },
          }],
        }
      : JSON.parse(configuredNative) as NativeFrontendInput;
    const result = await compileLibrary({
      profilePath,
      outDir,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native,
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok) return;

    const defined = execFileSync("nm", ["-g", "--defined-only", result.archivePath], {
      encoding: "utf8",
    });
    expect(defined).toMatch(/\bnts_ts_add_i32\b/);

    const probePath = join(outDir, "probe.c");
    const probeBin = join(outDir, "probe");
    writeFileSync(probePath, `
#include <stdint.h>
#include <stddef.h>
#include <limits.h>

extern void nx_init(void);
extern void nx_set_panic_sink(
  void (*fn)(void *, const uint8_t *, size_t, uint64_t),
  void *ctx
);
extern int32_t nts_ts_add_i32(int32_t left, int32_t right);

static int sink_called = 0;
static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)msg; (void)len; (void)addr;
  sink_called = 1;
}

int main(void) {
  nx_set_panic_sink(sink, NULL);
  nx_init();
  if (nts_ts_add_i32(20, 22) != 42) return 1;
  if (nts_ts_add_i32(INT32_MAX, 43) != INT32_MIN + 42) return 2;
  if (nts_ts_add_i32(INT32_MIN, -1) != INT32_MAX) return 3;
  return sink_called ? 4 : 0;
}
`);
    execFileSync("clang", [
      "-std=c11",
      ...(sanitize ? ["-fsanitize=address"] : []),
      probePath,
      result.archivePath,
      "-lm",
      "-o",
      probeBin,
    ]);
    const run = spawnSync(probeBin, [], { encoding: "utf8", timeout: 60_000 });
    expect({ status: run.status, signal: run.signal, stderr: run.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
    });

    if (result.irPath !== undefined) {
      const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(mod.lib?.nativeExports).toEqual([
        expect.objectContaining({
          id: "scriptc.fixture.c-v1@0.0.0#ts_add_i32",
          symbol: "nts_ts_add_i32",
          fnName: "ntsTsAddI32",
          returns: I32,
        }),
      ]);
      expect(validateModule(mod)).toEqual([]);
    }
  });
});

function exactI32Module(value = "42"): IrModule {
  const literal: IrExpr = { kind: "nativeScalarLit", value, type: I32, loc };
  const identity: IrExpr = {
    kind: "nativeCall",
    binding: "fixture.i32_identity",
    args: [literal],
    type: I32,
    loc,
  };
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    nativeTarget: { pointerBits: 64, abi: "sysv-amd64" },
    nativeBindings: [
      {
        id: "fixture.i32_identity",
        declaration: { module: "@scriptc/native-abi-fixture", name: "i32Identity" },
        sourceAccess: "call",
        entry: { symbol: "nts_i32_identity" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "process.exit",
        declaration: { module: "scriptc:test", name: "exit" },
        sourceAccess: "call",
        entry: { symbol: "exit" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "status", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
    ],
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "nativeCall",
              binding: "process.exit",
              args: [identity],
              type: NATIVE_VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function exactF64EqualityModule(): IrModule {
  const mod = exactI32Module();
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR exit call");
  }
  statement.expr.args[0] = {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "!==",
      left: { kind: "nativeScalarLit", value: "1.5", type: NATIVE_F64, loc },
      right: { kind: "nativeScalarLit", value: "1.25", type: NATIVE_F64, loc },
      type: { kind: "bool" },
      loc,
    },
    then: { kind: "nativeScalarLit", value: "42", type: I32, loc },
    else_: { kind: "nativeScalarLit", value: "1", type: I32, loc },
    type: I32,
    loc,
  };
  return mod;
}

function borrowedUtf8Module(): IrModule {
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  binding.arguments = [{ name: "data", type: { kind: "string" } }];
  binding.parameters = [
    {
      name: "data",
      type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
      passMode: "pointer",
      ownership: { kind: "borrowed", scope: "call" },
      projection: { kind: "utf8Data", argument: 0 },
    },
    {
      name: "length",
      type: USIZE,
      passMode: "value",
      ownership: { kind: "value" },
      projection: { kind: "utf8ByteLength", argument: 0 },
    },
  ];
  const exit = mod.functions[0]!.body[0]!;
  if (exit.kind !== "exprStmt" || exit.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR exit call");
  }
  const call = exit.expr.args[0]!;
  if (call.kind !== "nativeCall") throw new Error("test fixture lost its nested native call");
  call.args = [{ kind: "strLit", value: "hello", type: { kind: "string" }, loc }];
  return mod;
}

function borrowedCStringModule(): IrModule {
  const mod = borrowedUtf8Module();
  mod.nativeBindings![0]!.parameters = [
    {
      name: "data",
      type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
      passMode: "pointer",
      ownership: { kind: "borrowed", scope: "call" },
      projection: { kind: "utf8CString", argument: 0 },
    },
  ];
  return mod;
}

function exactScalarLiteralModule(
  scalar: IrNativeScalar,
  value: string,
  pointerBits: 32 | 64 = 64,
): IrModule {
  const type = nativeScalarType(scalar);
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    ...(scalar === "isize" || scalar === "usize"
      ? { nativeTarget: { pointerBits, abi: "test" } }
      : {}),
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "nativeScalarLit", value, type, loc },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function pointerScalarCallModule(pointerBits: 32 | 64): IrModule {
  const signedMin = pointerBits === 32 ? "-2147483648" : "-9223372036854775808";
  const unsignedMax = pointerBits === 32 ? "4294967295" : "18446744073709551615";
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    nativeTarget: { pointerBits, abi: "test" },
    nativeBindings: [
      {
        id: "fixture.pointer_sizes",
        declaration: { module: "scriptc:test", name: "pointerSizes" },
        sourceAccess: "call",
        entry: { symbol: "scriptc_test_pointer_sizes" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "signedSize", type: ISIZE, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsignedSize", type: USIZE, passMode: "value", ownership: { kind: "value" as const } },
        ]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
    ],
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "nativeCall",
              binding: "fixture.pointer_sizes",
              args: [
                { kind: "nativeScalarLit", value: signedMin, type: ISIZE, loc },
                { kind: "nativeScalarLit", value: unsignedMax, type: USIZE, loc },
              ],
              type: NATIVE_VOID,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function compileNativeObject(
  source: string,
  objectName: string,
  includeDir?: string,
): string {
  const object = join(scratch, objectName);
  execFileSync("clang", [
    "-std=c11",
    ...(sanitize ? ["-O1", "-fsanitize=address", "-DSCR_RC_AUDIT"] : ["-O2"]),
    ...(includeDir === undefined ? [] : ["-I", includeDir]),
    "-c",
    source,
    "-o",
    object,
  ]);
  return object;
}

function fixtureObject(): string {
  const source =
    process.env["SCRIPTC_NATIVE_IR_FIXTURE_SOURCE"] ??
    join(repoRoot, "tests/native-ir/native.c");
  return compileNativeObject(
    source,
    "native.o",
    process.env["SCRIPTC_NATIVE_IR_FIXTURE_INCLUDE"],
  );
}

function supportObject(): string {
  return compileNativeObject(
    join(repoRoot, "tests/native-ir/native-support.c"),
    "native-support.o",
  );
}

function frameFixtureObject(): string {
  return compileNativeObject(
    join(repoRoot, "tests/native-ir/native-frame.c"),
    "native-frame.o",
  );
}

function retainedSupportObject(): string {
  return compileNativeObject(
    join(repoRoot, "tests/native-ir/native-retained-support.c"),
    "native-retained-support.o",
  );
}

/** A module whose one statement CALLS a binding returning UTF-8 text carried
 * as a pointer and a length. `nullable` selects between a plain string result
 * and a string|null union. */
function utf8SpanCallModule(nullable: boolean): IrModule {
  const stringOrNull: IrType = { kind: "union", unionId: "u-span-text" };
  const resultType: IrType = nullable ? stringOrNull : { kind: "string" };
  const call: IrExpr = {
    kind: "nativeCall",
    binding: "fixture.span_text",
    args: [],
    type: resultType,
    loc,
  };
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "__main",
    nativeTarget: { pointerBits: 64, abi: "sysv-amd64" },
    unions: nullable
      ? [{ id: "u-span-text", arms: [{ kind: "nullT" }, { kind: "string" }] }]
      : [],
    nativeBindings: [
      {
        id: "fixture.span_text",
        declaration: { module: "@scriptc/native-abi-fixture", name: "spanText" },
        sourceAccess: "call",
        entry: { symbol: "nts_span_text" },
        error: NO_NATIVE_ERROR,
        arguments: [],
        parameters: [
          {
            name: "out_length",
            type: { kind: "nativeBytesLengthOut", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "value" as const },
            projection: { kind: "bytesLengthOut" },
          },
        ],
        result: {
          type: {
            kind: "nativePointer",
            pointee: "u8",
            const: false,
            addressSpace: 0,
            ...(nullable ? { nullable: true } : {}),
          },
          passMode: "pointer",
          ownership: { kind: "value" as const },
          projection: {
            kind: "utf8Span",
            nullable,
            release: { kind: "symbol", symbol: "nts_cstring_free" },
          },
        },
      },
    ],
    functions: [
      {
        name: "__main",
        params: [],
        returnType: NATIVE_VOID,
        locals: [{ id: "text", name: "text", type: resultType, mutable: true }],
        body: [
          { kind: "assign", localId: "text", value: call, loc },
        ],
        loc,
      },
    ],
  } as IrModule;
}

test("a CALL to a UTF-8 span binding validates in both nullabilities", () => {
  /* The binding-level arm and both backend decodes shipped without this one,
   * and nothing here could see the gap: a manifest translation produces a
   * BINDING, while the call-site rule is reached only by a program that calls
   * it. The first such program belonged to another repository, which is why
   * the miss surfaced as a downstream lane failing rather than a test here.
   *
   * The same instrument lesson as the archive that linked only into
   * executables: a check that no local consumer exercises is a check no local
   * suite can falsify. */
  expect(validateModule(utf8SpanCallModule(false)).map((e) => e.message)).toEqual([]);
  expect(validateModule(utf8SpanCallModule(true)).map((e) => e.message)).toEqual([]);

  /* And the rule is real in both directions: a nullable projection whose call
   * site takes a bare string is refused, since absence would have nowhere to
   * go. */
  const mismatched = utf8SpanCallModule(true);
  const statement = mismatched.functions[0]!.body[0]!;
  if (statement.kind !== "assign" || statement.value.kind !== "nativeCall") {
    throw new Error("fixture shape changed");
  }
  (statement.value as { type: IrType }).type = { kind: "string" };
  (mismatched.functions[0]!.locals[0] as { type: IrType }).type = { kind: "string" };
  expect(
    validateModule(mismatched).some((e) =>
      e.message.includes("Native IR call fixture.span_text must project to string | null")
    ),
  ).toBe(true);
});

test("Native IR validates and serializes an exact i32 call without a number carrier", () => {
  const mod = exactI32Module("-2147483648");
  expect(validateModule(mod)).toEqual([]);
  const json = serializeModule(mod);
  expect(json).toContain('"value": "-2147483648"');
  expect(deserializeModule(json)).toEqual(mod);
});

/* Builds the owner-scoped synchronous binding both forms share, differing only
 * in what the handler gives back. */
function ownerSynchronousModule(result: IrType, executor = "same-as-caller"): IrModule {
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  (binding as { arguments: unknown }).arguments = [{
    name: "callback",
    type: { kind: "func", params: [], ret: result },
    callback: {
      owner: { kind: "result" },
      cancellationBinding: binding.id,
      allowedInvocationExecutors: [executor],
      synchronousReturn: true,
      sourceArguments: [],
    },
  }];
  (binding as { parameters: unknown }).parameters = [{
    name: "callback",
    type: {
      kind: "nativeCallback",
      signature: { parameters: [CONTEXT], result },
    },
    passMode: "pointer",
    ownership: { kind: "callback" },
    projection: { kind: "callbackFunction", argument: 0 },
  }];
  return mod;
}

/* A registration nothing in the program owns, carrying an object.
 *
 * The shape a framework dispatch takes when the PLATFORM constructs the
 * receiver: there is no instance to anchor a registration to at the moment
 * one could be made, so the owner is the process and the receiver arrives as
 * an ordinary payload instead of an injected registration-owner. */
function processCallbackModule(
  payload: IrType | null,
  result: IrType = { kind: "void" },
): IrModule {
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  const params = payload === null ? [] : [payload];
  (binding as { arguments: unknown }).arguments = [{
    name: "callback",
    type: { kind: "func", params, ret: result },
    callback: {
      owner: { kind: "process" },
      allowedInvocationExecutors: ["same-as-caller"],
      synchronousReturn: true,
      sourceArguments: payload === null
        ? []
        : [{ kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY }],
    },
  }];
  (binding as { parameters: unknown }).parameters = [{
    name: "callback",
    type: {
      kind: "nativeCallback",
      signature: { parameters: [...params, CONTEXT], result },
    },
    passMode: "pointer",
    ownership: { kind: "callback" },
    projection: { kind: "callbackFunction", argument: 0 },
  }];
  return mod;
}

test("a process-owned registration may carry a handle payload", () => {
  /* No test anywhere reached a process-owned Native IR contract before this
   * one — the arm was declared, validated and produced by the FFI desugar
   * path, and exercised through Native IR by nothing. The Android acceptance
   * app needs exactly this shape, because the platform constructs the
   * receiver: at the moment a registration could be made there is no
   * instance, and at the moment the instance exists the callback has already
   * fired. The receiver therefore arrives as a payload rather than as an
   * injected registration-owner, which is what makes the owner the process. */
  const refused = (mod: IrModule): boolean =>
    validateModule(mod).some(({ message }) =>
      message.includes(`argument "callback" has an invalid callback contract`)
    );
  expect(refused(processCallbackModule(null))).toBe(false);
  expect(refused(processCallbackModule(COUNTER))).toBe(false);
});

test("a process-owned registration answers nothing and injects no owner", () => {
  /* The two facts the arm rests on, asserted rather than read off a key list.
   * A library calling a stored callback at a moment of its own choosing has
   * nowhere to put an answer, and there is no owner whose disposal could
   * cancel it — which is why a release names the function VALUE back instead,
   * and why this arm carries no cancellation binding to omit. */
  const refused = (mod: IrModule): boolean =>
    validateModule(mod).some(({ message }) =>
      message.includes(`argument "callback" has an invalid callback contract`)
    );
  expect(refused(processCallbackModule(COUNTER, I32))).toBe(true);
});

test("a synchronous retained callback may tell as well as ask", () => {
  /* This refused until a program needed it, on the ground that a void answer
   * is the queued contract's business and one delivery should not have two
   * spellings. The ground was right; the premise was not. For a framework
   * lifecycle method the two are not one delivery — the caller invokes the
   * handler and then reads state it was supposed to establish, so a queued
   * delivery arrives after the reading. `fixture/Lifecycle.start` in the JVM
   * suite is that program, and it is committed. */
  /* Asserted as the ABSENCE of the contract refusal rather than as a clean
   * module: the shared fixture's call site still passes an exact scalar where
   * this binding now takes a function, which is a fixture fact and not the
   * rule under test. Naming the message keeps the assertion pointed at the
   * rule that changed. */
  const contractRefusal = (mod: IrModule): boolean =>
    validateModule(mod).some(({ message }) =>
      message.includes(`argument "callback" has an invalid callback contract`)
    );
  expect(contractRefusal(ownerSynchronousModule({ kind: "void" }))).toBe(false);
  expect(contractRefusal(ownerSynchronousModule(I32))).toBe(false);
});

test("telling synchronously relaxes nothing else about the delivery", () => {
  /* The result is the only axis that moved. Synchronous delivery is
   * admissible for one reason — the invocation is same-as-caller on the
   * owner's thread, because reaching the handler means reading a closure and
   * a foreign producer may never read one. That reason does not weaken when
   * nothing is answered, so the executor restriction stands. */
  const foreign = ownerSynchronousModule({ kind: "void" }, "any-attached-thread");
  expect(
    validateModule(foreign).some(({ message }) =>
      message.includes(`argument "callback" has an invalid callback contract`)
    ),
  ).toBe(true);
});

test("Native IR rejects an f32 slot outside the number projection", () => {
  /* A 32-bit float has no source form — no literal, no arithmetic, no
   * declared type — so a direct projection would have nothing to hand over.
   * The number projection is the only door, and this pins that it is. */
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  const parameter = binding.parameters[0]!;
  (parameter as { type: unknown }).type = nativeScalarType("f32");
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    `Native IR binding "${binding.id}" parameter "${parameter.name}" is an f32 slot without the number projection`,
  );
});

test("Native IR rejects unknown exact integer operators", () => {
  const mod = exactI32Module();
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR exit call");
  }
  /* `>>>` is JavaScript's unsigned shift, whose whole content is a ToUint32
   * reinterpretation — an exact integer already has a signedness, so the
   * operator has nothing left to mean at this width. */
  statement.expr.args[0] = {
    kind: "nativeIntegerBin",
    op: ">>>" as "+",
    left: { kind: "nativeScalarLit", value: "4", type: I32, loc },
    right: { kind: "nativeScalarLit", value: "2", type: I32, loc },
    type: I32,
    loc,
  };
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    'in __main: native integer operation has unsupported operator ">>>"',
  );
});

test("Native IR rejects equality between different exact native scalar types", () => {
  const mod = exactF64EqualityModule();
  const statement = mod.functions[0]!.body[0]!;
  if (statement.kind !== "exprStmt" || statement.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR exit call");
  }
  const result = statement.expr.args[0]!;
  if (result.kind !== "ternary" || result.cond.kind !== "bin") {
    throw new Error("test fixture lost its exact scalar equality");
  }
  result.cond.right = { kind: "nativeScalarLit", value: "1", type: I32, loc };
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    "in __main: bin !== on native scalars: operand types differ",
  );
});

test("Native IR validates exact integer-backed boolean results", () => {
  const mod = exactI32Module();
  const frontendBinding = structuredClone(localNativeInput.bindings.find(
    ({ declaration }) => declaration.name === "nativeTrue",
  ));
  if (frontendBinding === undefined) throw new Error("test fixture lost nativeTrue");
  const binding = { ...frontendBinding, sourceAccess: "call" as const };
  mod.nativeBindings = [...mod.nativeBindings!, binding];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);

  const malformed = structuredClone(binding);
  malformed.result.projection = {
    kind: "boolean",
    conversion: "exact",
    falseValue: "1",
    trueValue: "1",
  };
  mod.nativeBindings = [mod.nativeBindings[0]!, malformed];
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    `Native IR binding "${binding.id}" has an invalid boolean result projection`,
  );
});

test("Native IR validates exact integer-backed boolean parameters", () => {
  const mod = exactI32Module();
  const frontendBinding = structuredClone(localNativeInput.bindings.find(
    ({ declaration }) => declaration.name === "nativeNot",
  ));
  if (frontendBinding === undefined) throw new Error("test fixture lost nativeNot");
  const binding = { ...frontendBinding, sourceAccess: "call" as const };
  mod.nativeBindings = [...mod.nativeBindings!, binding];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);

  const malformed = structuredClone(binding);
  const projection = malformed.parameters[0]?.projection;
  if (projection?.kind !== "boolean") throw new Error("test fixture lost boolean input");
  projection.trueValue = projection.falseValue;
  mod.nativeBindings = [mod.nativeBindings[0]!, malformed];
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    `Native IR binding "${binding.id}" parameter "value" has an invalid boolean projection`,
  );
});

test("Native IR refuses a handle payload on a call-scoped delivery", () => {
  /* The call-scoped trampoline READS its payloads and invokes; it builds no
   * managed cell, because nothing outlives the call for a cell to own. A
   * handle payload therefore has no form there — the handler would receive the
   * foreign pointer where a cell is expected, which is a type confusion no
   * diagnostic reports.
   *
   * The SCABI translator already refuses a non-scalar call-scoped payload, so
   * no manifest reaches this. That is exactly why it is worth asserting here:
   * this validator is the backstop for a FRONTEND bug, and a backstop that
   * holds only while another layer is correct is not one. */
  const mod = exactI32Module();
  mod.nativeTypes = [COUNTER_DEFINITION, COUNTER_MIDDLE_DEFINITION, COUNTER_BASE_DEFINITION];
  mod.nativeBindings = [{
    id: "scriptc.fixture.c-v1@0.0.0#call_scoped_handle",
    declaration: { module: nativePackage, name: "callScopedHandle" },
    sourceAccess: "call",
    entry: { symbol: "nts_call_scoped" },
    error: NO_NATIVE_ERROR,
    arguments: [{
      name: "callback",
      type: {
        ...nativeCallbackArgumentType({ parameters: [COUNTER, CONTEXT], result: I32 }),
      },
      callback: {
        owner: { kind: "call" },
        allowedInvocationExecutors: ["same-as-caller"],
        synchronousReturn: true,
        sourceArguments: [
          { kind: "callback-parameter", parameter: 0, destructor: COUNTER_DESTROY },
        ],
      },
    }],
    parameters: [
      {
        name: "callback",
        type: { kind: "nativeCallback", signature: { parameters: [COUNTER, CONTEXT], result: I32 } },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: { kind: "callbackFunction", argument: 0 },
      },
      {
        name: "context",
        type: { kind: "nativeContext", addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "callback" },
        projection: { kind: "callbackContext", argument: 0 },
      },
    ],
    result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
  }];
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    `Native IR binding "scriptc.fixture.c-v1@0.0.0#call_scoped_handle" argument ` +
      `"callback" has an invalid callback contract`,
  );
});

test("Native IR validates explicit identity handle upcast graphs", () => {
  const base = {
    ...COUNTER_DEFINITION,
    id: `${COUNTER_ID}:base`,
    declaration: { module: nativePackage, name: "CounterBase" },
    nativeName: "NtsCounterBase",
    upcasts: [],
  };
  const derived = {
    ...COUNTER_DEFINITION,
    upcasts: [{ kind: "identity" as const, target: base.id }],
  };
  const mod = exactI32Module();
  mod.nativeTypes = [base, derived];
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);

  const incompatible = structuredClone(mod);
  const incompatibleBase = incompatible.nativeTypes![0]!;
  if (incompatibleBase.kind !== "handle") throw new Error("test fixture lost its handle type");
  incompatibleBase.identity = "platform";
  expect(validateModule(incompatible).map(({ message }) => message)).toContain(
    `Native IR handle type "${COUNTER_ID}" has an invalid identity upcast to "${base.id}": ` +
      `identity differs ("pointer" upcasting to "platform")`,
  );

  const incompatibleCollection = structuredClone(mod);
  const collectionBase = incompatibleCollection.nativeTypes![0]!;
  if (collectionBase.kind !== "handle") throw new Error("test fixture lost its handle type");
  collectionBase.cycleCollection = "traceable";
  expect(validateModule(incompatibleCollection).map(({ message }) => message)).toContain(
    `Native IR handle type "${COUNTER_ID}" has an invalid identity upcast to "${base.id}": ` +
      `cycle collection differs ("none" upcasting to "traceable")`,
  );

  /* Every remaining rule on the edge, each asserted through the reason it
   * gives. A generated hierarchy breaks these — not the hand-written ones
   * above — and until each named itself, all six failures read alike.
   */
  function upcastErrors(mutate: (module: IrModule) => void): string[] {
    const mutated = structuredClone(mod);
    mutate(mutated);
    const prefix = `Native IR handle type "${COUNTER_ID}" has an invalid identity upcast to `;
    return validateModule(mutated).map(({ message }) => message)
      .filter((message) => message.startsWith(prefix))
      .map((message) => message.slice(prefix.length));
  }
  function setUpcasts(module: IrModule, targets: string[]): void {
    const handle = module.nativeTypes![1]!;
    if (handle.kind !== "handle") throw new Error("test fixture lost its handle type");
    handle.upcasts = targets.map((target) => ({ kind: "identity", target }));
  }
  expect(upcastErrors((module) => setUpcasts(module, [COUNTER_ID]))).toEqual([
    `"${COUNTER_ID}": a handle cannot upcast to itself`,
  ]);
  expect(upcastErrors((module) => setUpcasts(module, [base.id, base.id]))).toEqual([
    `"${base.id}": the target is named twice`,
  ]);
  expect(upcastErrors((module) => setUpcasts(module, [`${base.id}z`, base.id]))).toEqual([
    `"${`${base.id}z`}": the target is not a Native IR type in this module`,
    `"${base.id}": targets must ascend, and this one follows "${`${base.id}z`}"`,
  ]);
  expect(upcastErrors((module) => {
    const target = module.nativeTypes![0]!;
    if (target.kind !== "handle") throw new Error("test fixture lost its handle type");
    target.threadSafety = "shared";
  })).toEqual([
    `"${base.id}": thread safety differs ("confined" upcasting to "shared")`,
  ]);
  expect(upcastErrors((module) => {
    module.nativeTypes!.push({
      ...PADDED_DEFINITION,
      fields: PADDED_DEFINITION.fields.map((field) => ({ ...field, type: { ...field.type } })),
    });
    setUpcasts(module, [PADDED_ID]);
  })).toEqual([
    `"${PADDED_ID}": the target is a struct, and only handles carry identity`,
  ]);

  const cyclic = structuredClone(mod);
  const cyclicBase = cyclic.nativeTypes![0]!;
  if (cyclicBase.kind !== "handle") throw new Error("test fixture lost its handle type");
  cyclicBase.upcasts = [{ kind: "identity", target: COUNTER_ID }];
  expect(validateModule(cyclic).map(({ message }) => message)).toContain(
    `Native IR handle upcast graph contains a cycle through "${COUNTER_ID}"`,
  );
});

test("Native IR requires explicit, range-checked error contracts", () => {
  const missing = exactI32Module();
  delete (missing.nativeBindings![0]! as unknown as { error?: unknown }).error;
  expect(validateModule(missing).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" has no valid error contract',
  );

  const outOfRange = exactI32Module();
  outOfRange.nativeBindings![0]!.error = errnoFailure("2147483648");
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" has an invalid sentinel failure contract',
  );
});

test("Native IR pairs an optional handle argument with its own handle", () => {
  // The direct projection admits differing argument and parameter types only
  // for an optional handle, and only when the identities agree. Without the
  // identity check it would silently accept an unrelated handle.
  const mismatched = exactI32Module();
  const binding = mismatched.nativeBindings![0]!;
  binding.arguments = [
    { name: "value", type: { kind: "nullableNativeHandle", typeId: "fixture#type:a" } },
  ];
  binding.parameters = [
    {
      name: "value",
      type: { kind: "nativeHandle", typeId: "fixture#type:b" },
      passMode: "pointer",
      ownership: { kind: "borrowed", scope: "call" },
      projection: { kind: "argument", argument: 0 },
    },
  ];
  expect(validateModule(mismatched).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "value" has an inconsistent direct projection',
  );

  // A required parameter never accepts an optional argument.
  const required = exactI32Module();
  const requiredBinding = required.nativeBindings![0]!;
  requiredBinding.arguments = [
    { name: "value", type: { kind: "nullableNativeHandle", typeId: "fixture#type:a" } },
  ];
  expect(validateModule(required).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "value" has an inconsistent direct projection',
  );
});

test("Native IR validates every exact integer's signed bounds", () => {
  const cases: readonly [IrNativeScalar, string, string][] = [
    ["i8", "-128", "127"],
    ["u8", "0", "255"],
    ["i16", "-32768", "32767"],
    ["u16", "0", "65535"],
    ["i32", "-2147483648", "2147483647"],
    ["u32", "0", "4294967295"],
    ["i64", "-9223372036854775808", "9223372036854775807"],
    ["u64", "0", "18446744073709551615"],
    ["isize", "-9223372036854775808", "9223372036854775807"],
    ["usize", "0", "18446744073709551615"],
  ];
  for (const [scalar, min, max] of cases) {
    for (const value of [min, max]) {
      const mod = exactScalarLiteralModule(scalar, value);
      expect(validateModule(mod), `${scalar} ${value}`).toEqual([]);
      expect(deserializeModule(serializeModule(mod))).toEqual(mod);
    }
  }
});

test("Native IR resolves pointer-sized bounds from the module target", () => {
  expect(validateModule(exactScalarLiteralModule("isize", "-2147483648", 32))).toEqual([]);
  expect(validateModule(exactScalarLiteralModule("usize", "4294967295", 32))).toEqual([]);
  expect(
    validateModule(exactScalarLiteralModule("usize", "4294967296", 32)).map(
      (error) => error.message,
    ),
  ).toContain("in __main: native usize literal 4294967296 is out of range");
});

test("C and LLVM lower pointer-sized scalars at the selected width", () => {
  const mod = pointerScalarCallModule(32);
  expect(validateModule(mod)).toEqual([]);

  const c = emitModule(mod);
  expect(c).toContain("sizeof(uintptr_t) * CHAR_BIT == 32");
  expect(c).toContain("extern void scriptc_test_pointer_sizes(intptr_t, uintptr_t);");
  expect(c).toContain("INT32_C(2147483647)");
  expect(c).toContain("UINT32_C(4294967295)");

  const llvm = emitLlvmModule(mod, { pointerBits: 32 });
  expect(llvm).toContain("declare void @scriptc_test_pointer_sizes(i32, i32)");
  expect(llvm).toContain(
    "call void @scriptc_test_pointer_sizes(i32 -2147483648, i32 4294967295)",
  );
});

test("Native IR requires target facts for bindings and backends reject width mismatch", () => {
  const missingTarget = exactI32Module();
  delete missingTarget.nativeTarget;
  expect(validateModule(missingTarget).map((error) => error.message)).toContain(
    "Native IR bindings and exports require module target ABI facts",
  );
  expect(() => emitLlvmModule(exactI32Module(), { pointerBits: 32 })).toThrow(
    /target mismatch/,
  );
});

test("Native IR rejects invalid binding identity, exact types, and i32 literals", () => {
  const invalidId = exactI32Module();
  invalidId.nativeBindings![0]!.id = "bad id";
  expect(validateModule(invalidId).map((error) => error.message)).toContain(
    'invalid Native IR binding id "bad id"',
  );

  const duplicateDeclaration = exactI32Module();
  duplicateDeclaration.nativeBindings![1]!.declaration = {
    ...duplicateDeclaration.nativeBindings![0]!.declaration,
  };
  expect(validateModule(duplicateDeclaration).map((error) => error.message)).toContain(
    'duplicate Native IR declaration "@scriptc/native-abi-fixture"::"i32Identity"',
  );

  const outOfRange = exactI32Module("2147483648");
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    "in __main: native i32 literal 2147483648 is out of range",
  );

  const wrongResult = exactI32Module();
  const exit = wrongResult.functions[0]!.body[0]!;
  if (exit.kind !== "exprStmt" || exit.expr.kind !== "nativeCall") {
    throw new Error("test fixture lost its Native IR call shape");
  }
  exit.expr.type = I32;
  expect(validateModule(wrongResult).map((error) => error.message)).toContain(
    "in __main: Native IR call process.exit type native:i32 does not match its direct result",
  );
});

test("Native IR admits only an exact frame-bounded handle-result capability", () => {
  const native = structuredClone(localNativeInput);
  const create = native.bindings.find(
    (candidate) =>
      candidate.id === "scriptc.fixture.c-v1@0.0.0#frame_counter_create",
  );
  const destroy = native.bindings.find(
    (candidate) => candidate.id === "scriptc.fixture.c-v1@0.0.0#counter_destroy",
  );
  if (create === undefined || destroy === undefined) {
    throw new Error("test fixture lost its frame-bounded construction pair");
  }
  const mod = exactI32Module();
  mod.nativeTypes = native.types
    .filter((definition) => definition.kind !== "handle" || definition.peerSlot === undefined)
    .map((definition) => structuredClone(definition));
  mod.nativeBindings = [create, destroy].map((binding) =>
    materializeNativeBinding(binding)
  );
  mod.functions = [];
  expect(validateModule(mod)).toEqual([]);

  const malformed = structuredClone(mod);
  malformed.nativeBindings![0]!.result.frameBounded = {
    entry: { symbol: malformed.nativeBindings![0]!.entry.symbol },
    release: { symbol: "not-a-c-symbol" },
  };
  expect(validateModule(malformed).map(({ message }) => message)).toContain(
    'Native IR binding "scriptc.fixture.c-v1@0.0.0#frame_counter_create" has an invalid frame-bounded result capability',
  );

  const colliding = structuredClone(mod);
  colliding.nativeBindings![0]!.result.frameBounded!.entry.symbol =
    colliding.nativeBindings![1]!.entry.symbol;
  expect(validateModule(colliding).map(({ message }) => message)).toContain(
    `duplicate Native IR frame-bounded C symbol "${colliding.nativeBindings![1]!.entry.symbol}"`,
  );
});

test("a handle may be released as any type it identity-upcasts to", () => {
  /* A platform whose release is ONE function — `g_object_unref` for every
   * GObject, `DeleteGlobalRef` for every Java object — should be able to name
   * it once. Requiring the destructor's exact type forced a wrapper per class
   * whose body was byte-identical, in both binding families.
   *
   * It is sound rather than lenient. An identity upcast preserves the
   * representation by definition, and the upcast edge validation refuses a
   * target that disagrees about thread safety, identity, or cycle collection
   * — the three properties a release could care about. Nothing in emission
   * reads the destructor's declared parameter type: it takes `entry.symbol`,
   * and the handle definition comes from the RESULT's own type. */
  const native = structuredClone(localNativeInput);
  const create = native.bindings.find(
    (candidate) => candidate.id === "scriptc.fixture.c-v1@0.0.0#counter_create",
  );
  const destroy = native.bindings.find(
    (candidate) => candidate.id === "scriptc.fixture.c-v1@0.0.0#counter_destroy",
  );
  if (create === undefined || destroy === undefined) {
    throw new Error("test fixture lost its handle construction pair");
  }
  const mod = exactI32Module();
  /* This unit fixture deliberately keeps only the two bindings under test.
   * A slot-bearing handle is a contract with its accessor bindings, so it
   * cannot be copied into that reduced module without those bindings. */
  mod.nativeTypes = native.types
    .filter((definition) => definition.kind !== "handle" || definition.peerSlot === undefined)
    .map((definition) => structuredClone(definition));
  mod.nativeBindings = [create, destroy].map((binding) =>
    materializeNativeBinding(binding)
  );
  mod.functions = [];
  expect(validateModule(mod)).toEqual([]);

  /* Retyped to the BASE the counter identity-upcasts to, which is the shape a
   * one-release platform wants. */
  const base = structuredClone(mod);
  const retyped = base.nativeBindings![1]!;
  const baseHandle = { kind: "nativeHandle", typeId: COUNTER_BASE_ID } as const;
  retyped.arguments = [{ name: "counter", type: baseHandle }];
  retyped.parameters = [{
    ...retyped.parameters[0]!,
    type: baseHandle,
  }];
  expect(validateModule(base)).toEqual([]);

  /* An UNRELATED handle type is still refused: nothing says its
   * representation matches, so nothing says the pointer is the one the
   * destructor expects. */
  const unrelated = structuredClone(base);
  const strayId = "scriptc.fixture.c-v1@0.0.0#type:vault";
  const stray = unrelated.nativeBindings![1]!;
  const strayHandle = { kind: "nativeHandle", typeId: strayId } as const;
  stray.arguments = [{ name: "counter", type: strayHandle }];
  stray.parameters = [{ ...stray.parameters[0]!, type: strayHandle }];
  expect(validateModule(unrelated).map((error) => error.message)).toContain(
    'Native IR binding "scriptc.fixture.c-v1@0.0.0#counter_create" names an invalid handle destructor "scriptc.fixture.c-v1@0.0.0#counter_destroy"',
  );
});

test("Native IR rejects malformed borrowed UTF-8 C-string results", () => {
  const native = structuredClone(localNativeInput);
  const binding = native.bindings.find(
    (candidate) => candidate.id === "scriptc.fixture.c-v1@0.0.0#counter_label",
  );
  if (binding === undefined) throw new Error("test fixture lost its C-string-result binding");
  const mod = exactI32Module();
  /* As above, keep a reduced binding module contract-complete rather than
   * carrying the peer handle without the two accessors it names. */
  mod.nativeTypes = native.types
    .filter((definition) => definition.kind !== "handle" || definition.peerSlot === undefined)
    .map((definition) => structuredClone(definition));
  mod.nativeBindings = [materializeNativeBinding(binding)];
  mod.functions = [];
  expect(validateModule(mod)).toEqual([]);

  const missingProjection = structuredClone(mod);
  Reflect.deleteProperty(missingProjection.nativeBindings![0]!.result, "projection");
  expect(() => validateModule(missingProjection)).not.toThrow();
  expect(validateModule(missingProjection).map((error) => error.message)).toContain(
    'Native IR binding "scriptc.fixture.c-v1@0.0.0#counter_label" has no valid result projection',
  );

  const missingAnchor = structuredClone(mod);
  const ownership = missingAnchor.nativeBindings![0]!.result.ownership;
  if (ownership.kind !== "borrowed") throw new Error("test fixture lost its borrowed result");
  ownership.anchor = "missing";
  expect(validateModule(missingAnchor).map((error) => error.message)).toContain(
    'Native IR binding "scriptc.fixture.c-v1@0.0.0#counter_label" has an invalid UTF-8 C-string result projection',
  );

  const mutablePointer = structuredClone(mod);
  const resultType = mutablePointer.nativeBindings![0]!.result.type;
  if (resultType.kind !== "nativePointer") throw new Error("test fixture lost its pointer result");
  resultType.const = false;
  expect(validateModule(mutablePointer).map((error) => error.message)).toContain(
    'Native IR binding "scriptc.fixture.c-v1@0.0.0#counter_label" has an invalid UTF-8 C-string result projection',
  );
});

test("Native IR rejects malformed or ambiguous UTF-8 projections", () => {
  expect(validateModule(borrowedUtf8Module())).toEqual([]);
  expect(validateModule(borrowedCStringModule())).toEqual([]);

  const mutablePointer = borrowedUtf8Module();
  const dataType = mutablePointer.nativeBindings![0]!.parameters[0]!.type;
  if (dataType.kind !== "nativePointer") throw new Error("test fixture lost its pointer type");
  dataType.const = false;
  expect(validateModule(mutablePointer).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "data" has an invalid UTF-8 data projection',
  );

  const missingLength = borrowedUtf8Module();
  missingLength.nativeBindings![0]!.parameters.pop();
  expect(validateModule(missingLength).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "data" has an incomplete or ambiguous ABI projection',
  );

  const outOfRange = borrowedUtf8Module();
  outOfRange.nativeBindings![0]!.parameters[1]!.projection.argument = 1;
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "length" projects an invalid argument index',
  );

  const mixed = borrowedCStringModule();
  mixed.nativeBindings![0]!.parameters.push(
    borrowedUtf8Module().nativeBindings![0]!.parameters[1]!,
  );
  expect(validateModule(mixed).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "data" has an incomplete or ambiguous ABI projection',
  );
});

test("Native IR rejects malformed or ambiguous borrowed-byte projections", () => {
  const mutablePointer = borrowedUtf8Module();
  const binding = mutablePointer.nativeBindings![0]!;
  binding.arguments = [{ name: "data", type: { kind: "bytes", elem: "u8" } }];
  binding.parameters[0] = {
    name: "data",
    type: { kind: "nativePointer", pointee: "u8", const: false, addressSpace: 0 },
    passMode: "pointer",
    ownership: { kind: "borrowed", scope: "call" },
    projection: { kind: "bytesData", argument: 0 },
  };
  binding.parameters[1]!.projection = { kind: "bytesLength", argument: 0, units: "elements" };
  expect(validateModule(mutablePointer).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "data" has an invalid byte-data projection',
  );

  const missingLength = structuredClone(mutablePointer);
  const missingDataType = missingLength.nativeBindings![0]!.parameters[0]!.type;
  if (missingDataType.kind !== "nativePointer") throw new Error("test fixture lost its pointer type");
  missingDataType.const = true;
  missingLength.nativeBindings![0]!.parameters.pop();
  expect(validateModule(missingLength).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "data" has an incomplete or ambiguous ABI projection',
  );

  const outOfRange = structuredClone(mutablePointer);
  outOfRange.nativeBindings![0]!.parameters[1]!.projection.argument = 1;
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "length" projects an invalid argument index',
  );
});

test("Native IR rejects malformed or ambiguous call-scoped callback projections", () => {
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  binding.arguments = [
    { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
  ];
  binding.parameters = [
    {
      name: "callback",
      type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
      passMode: "pointer",
      ownership: { kind: "borrowed", scope: "call" },
      projection: { kind: "callbackFunction", argument: 0 },
    },
    {
      name: "context",
      type: { kind: "nativeContext", addressSpace: 0 },
      passMode: "pointer",
      ownership: { kind: "callback" },
      projection: { kind: "callbackContext", argument: 0 },
    },
  ];
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "callback" has invalid ownership',
  );

  const missingContext = structuredClone(mod);
  missingContext.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback" };
  missingContext.nativeBindings![0]!.parameters.pop();
  expect(validateModule(missingContext).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "callback" has an incomplete or ambiguous ABI projection',
  );

  const wrongSignature = structuredClone(mod);
  wrongSignature.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback" };
  const callbackType = wrongSignature.nativeBindings![0]!.parameters[0]!.type;
  if (callbackType.kind !== "nativeCallback") throw new Error("test fixture lost its callback type");
  callbackType.signature.result = U32;
  expect(validateModule(wrongSignature).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "callback" has an invalid callback-function projection',
  );

  const missingSignature = structuredClone(mod);
  missingSignature.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback" };
  const malformedCallbackType = missingSignature.nativeBindings![0]!.parameters[0]!.type;
  Reflect.deleteProperty(malformedCallbackType, "signature");
  expect(() => validateModule(missingSignature)).not.toThrow();
  expect(validateModule(missingSignature).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "callback" has an unsupported exact type',
  );

  const missingLogicalParameters = structuredClone(wrongSignature);
  const malformedLogicalType = missingLogicalParameters.nativeBindings![0]!.arguments[0]!.type;
  Reflect.deleteProperty(malformedLogicalType, "params");
  expect(() => validateModule(missingLogicalParameters)).not.toThrow();
  expect(validateModule(missingLogicalParameters).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "callback" has an unsupported source type',
  );
});

test("Native IR rejects undeclared and internally inconsistent native structs", () => {
  const undeclared = exactI32Module();
  undeclared.nativeBindings![0]!.parameters[0]!.type = PADDED;
  expect(validateModule(undeclared).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "value" has an unsupported exact type',
  );

  const invalidLayout = exactI32Module();
  invalidLayout.nativeTypes = [
    {
      ...PADDED_DEFINITION,
      abi: { ...PADDED_ABI, parameters: [] },
      fields: PADDED_DEFINITION.fields.map((field) => ({ ...field, type: { ...field.type } })),
    },
  ];
  expect(validateModule(invalidLayout).map((error) => error.message)).toContain(
    `Native IR type "${PADDED_ID}" has unsupported value or ABI metadata`,
  );

  const recursive = exactI32Module();
  recursive.nativeTypes = [{
    ...PAIR32_DEFINITION,
    fields: [{ name: "self", type: PAIR32, offset: 0 }],
  }];
  expect(validateModule(recursive).map((error) => error.message)).toContain(
    `Native IR type "${PAIR32_ID}" has an invalid field "self"`,
  );
});

test("the frontend rejects an out-of-range exact i32 constructor before linking", async () => {
  const outDir = join(scratch, "frontend-out-of-range");
  const result = await compile(join(repoRoot, "tests/native-ir/out-of-range.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: frontendNativeInput(),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("the frontend rejects an out-of-range unsigned constructor before linking", async () => {
  const outDir = join(scratch, "frontend-unsigned-out-of-range");
  const result = await compile(
    join(repoRoot, "tests/native-ir/unsigned-out-of-range.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("the frontend rejects an out-of-range exact i64 BigInt constructor", async () => {
  const outDir = join(scratch, "frontend-i64-out-of-range");
  const result = await compile(
    join(repoRoot, "tests/native-ir/i64-out-of-range.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("the frontend rejects a usize constructor outside the selected target width", async () => {
  const outDir = join(scratch, "frontend-usize-out-of-range");
  const result = await compile(
    join(repoRoot, "tests/native-ir/usize-out-of-range.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

test("the compiler rejects Native IR input for a different pointer width", async () => {
  const outDir = join(scratch, "frontend-target-mismatch");
  const native = frontendNativeInput();
  const result = await compile(join(repoRoot, "tests/native-ir/missing-symbol.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: { ...native, target: { pointerBits: 32, abi: "test" } },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5101"]);

  const analysis = analyze(join(repoRoot, "tests/native-ir/missing-symbol.ts"), {
    externalTypes: nativeExternalTypes(),
    native: { ...native, target: { pointerBits: 32, abi: "test" } },
  });
  expect(analysis.coverage.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "SC5101",
  );
});

test("the compiler rejects a reached aggregate for a different target ABI", async () => {
  const outDir = join(scratch, "aggregate-target-mismatch");
  const native = frontendNativeInput();
  const result = await compile(join(repoRoot, "tests/native-ir/aggregate.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: { ...native, target: { ...native.target, abi: "ms-x64" } },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SC5101");
});

test("unused Native IR input remains inert even when its target differs", async () => {
  const outDir = join(scratch, "frontend-unused-target");
  const native = frontendNativeInput();
  const result = await compile(
    join(repoRoot, "tests/native-ir/unused-native-input.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: { ...native, target: { pointerBits: 32, abi: "test" } },
    },
  );
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
});

test("a pointer-sized literal without a native call still records target facts", async () => {
  const outDir = join(scratch, "frontend-pointer-literal-only");
  const result = await compile(
    join(repoRoot, "tests/native-ir/pointer-literal-only.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      emitIr: true,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (!result.ok || result.irPath === undefined) return;
  const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
  expect(mod.nativeTarget).toEqual({ pointerBits: 64, abi: "sysv-amd64" });
  expect(mod.nativeBindings).toBeUndefined();
  expect(validateModule(mod)).toEqual([]);
});

test("the frontend keeps number and BigInt exact-integer carriers distinct", async () => {
  const outDir = join(scratch, "frontend-carrier-mismatch");
  const result = await compile(
    join(repoRoot, "tests/native-ir/carrier-mismatch.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "SC0001",
    "SC0001",
  ]);
});

test("a reached native symbol missing from the link fails as SC5105", async () => {
  const outDir = join(scratch, "frontend-missing-symbol");
  const result = await compile(join(repoRoot, "tests/native-ir/missing-symbol.ts"), {
    outDir,
    outPath: join(outDir, "program"),
    backend: "c",
    externalTypes: nativeExternalTypes(),
    native: frontendNativeInput(),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5105"]);
});

test("the frontend refuses to reinterpret an ordinary object as a native struct", async () => {
  const outDir = join(scratch, "aggregate-object-reinterpret");
  const result = await compile(
    join(repoRoot, "tests/native-ir/aggregate-object-reinterpret.ts"),
    {
      outDir,
      outPath: join(outDir, "program"),
      backend: "c",
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
    },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SC5104"]);
});

describe.each(["c", "llvm"] as const)("Native IR exact integers, %s backend", (backend) => {
  test("round-trips the identity result as the observable process status", async () => {
    const mod = exactI32Module();
    expect(validateModule(mod)).toEqual([]);
    const outDir = join(scratch, backend);
    mkdirSync(outDir, { recursive: true });
    const sourcePath = join(outDir, backend === "c" ? "program.c" : "program.ll");
    writeFileSync(
      sourcePath,
      backend === "c" ? emitModule(mod) : emitLlvmModule(mod, { pointerBits: 64 }),
    );
    const binaryPath = join(outDir, "program");
    await compileC({
      cPath: sourcePath,
      outPath: binaryPath,
      linkInputs: [fixtureObject()],
      sanitize,
    });
    const result = spawnSync(binaryPath);
    expect({ status: result.status, signal: result.signal, stderr: result.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("lowers exact declaration symbols and literals through the TypeScript frontend", async () => {
    const outDir = join(scratch, `frontend-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/program.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings?.map((binding) => binding.id).sort()).toEqual([
      "scriptc-test@1#exit",
      "scriptc-test@1#isize-identity",
      "scriptc-test@1#verify-exact-integers",
      "scriptc.fixture.c-v1@0.0.0#i16_identity",
      "scriptc.fixture.c-v1@0.0.0#i32_identity",
      "scriptc.fixture.c-v1@0.0.0#i64_identity",
      "scriptc.fixture.c-v1@0.0.0#i8_identity",
      "scriptc.fixture.c-v1@0.0.0#u16_identity",
      "scriptc.fixture.c-v1@0.0.0#u32_identity",
      "scriptc.fixture.c-v1@0.0.0#u64_identity",
      "scriptc.fixture.c-v1@0.0.0#u8_identity",
      "scriptc.fixture.c-v1@0.0.0#usize_identity",
    ]);
    const json = serializeModule(mod);
    expect(json).toContain('"kind": "nativeScalarLit"');
    expect(json).not.toContain('"kind": "numLit"');

    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("lowers an external native constant as an exact literal", async () => {
    const outDir = join(scratch, `native-constant-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/native-constant.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native constant frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(serializeModule(mod)).toMatch(
      /"kind": "nativeScalarLit",\s+"value": "42"/,
    );
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("divides, shifts, and converts an exact integer", async () => {
    const outDir = join(scratch, `native-scalar-operations-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/native-scalar-operations.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native scalar operations frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const ir = serializeModule(mod);
    /* The trapping four are the same IR node the wrapping six use, reached
     * by the same construction form rather than by a declared operation. */
    for (const marker of ['"op": "/"', '"op": "%"', '"op": "<<"', '"op": ">>"']) {
      expect(ir).toContain(marker);
    }
    expect(ir).toContain('"kind": "nativeScalarToNumber"');
    expect(ir).toContain('"kind": "nativeScalarFromNumber"');
    const generated = readFileSync(
      join(outDir, backend === "c" ? "native-scalar-operations.c" : "native-scalar-operations.ll"),
      "utf8",
    );
    /* Both backends reach one out-of-line definition of the trapping
     * semantics, so the two cannot drift on which cases throw. */
    expect(generated).toContain("scr_native_i32_div");
    expect(generated).toContain("scr_native_i64_to_number");
    /* Widening up to 32 bits is a conversion instruction, not a call. */
    expect(generated).not.toContain("scr_native_i32_to_number");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  /* The registration and its C symbols are in-tree only: an embedder-supplied
   * fixture does not promise them. */
  localFixtureTest("moves a handle's reference into the callee", async () => {
    const outDir = join(scratch, `handle-transfer-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/handle-transfer.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("handle transfer frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "handle-transfer.c" : "handle-transfer.ll"),
      "utf8",
    );
    /* The consuming call surrenders the reference and then calls the
     * function; only a destructor is performed by the runtime instead. */
    expect(generated).toContain("scr_native_handle_surrender");
    expect(generated).toContain("nts_vault_adopt");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("answers a native question from a retained callback", async () => {
    const outDir = join(scratch, `callback-answer-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/callback-answer.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("synchronous callback frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "callback-answer.c" : "callback-answer.ll"),
      "utf8",
    );
    /* The answer has to exist before the emitting call returns, so the
     * trampoline reads the closure and calls it rather than queueing an
     * invocation for a later turn. */
    expect(generated).toContain("scr_callback_table_acquire");
    expect(generated).not.toContain("scr_callback_token_admit");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("orders exact native scalars at their declared width and signedness", async () => {
    const outDir = join(scratch, `native-scalar-ordering-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/native-scalar-ordering.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native scalar ordering frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "native-scalar-ordering.c" : "native-scalar-ordering.ll"),
      "utf8",
    );
    if (backend === "llvm") {
      /* Signedness is the whole point: the unsigned comparisons must not
       * reach for a signed predicate, and neither may reach for a floating
       * one, which would be the JavaScript-number answer. */
      expect(generated).toContain("icmp slt i32");
      expect(generated).toContain("icmp ult i32");
      expect(generated).toContain("icmp ult i64");
      expect(generated).not.toContain("fcmp olt");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("compares exact native scalars without a JavaScript-number conversion", async () => {
    const outDir = join(scratch, `native-scalar-equality-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/native-scalar-equality.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native scalar equality frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(serializeModule(mod)).toContain('"op": "==="');
    expect(serializeModule(mod)).toContain('"op": "!=="');
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("folds a declaration-backed exact integer reduction without a runtime symbol", async () => {
    const outDir = join(scratch, `native-integer-reduce-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/native-integer-reduce.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native integer reduction frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings?.some(
      ({ id }) => id === "scriptc.fixture.c-v1@0.0.0#fixture_value_combine",
    )).toBe(false);
    expect(serializeModule(mod).match(/"kind": "nativeIntegerBin"/gu)).toHaveLength(2);
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("emits exact native f64 equality in the selected backend", async () => {
    const mod = exactF64EqualityModule();
    expect(validateModule(mod)).toEqual([]);
    const outDir = join(scratch, `native-f64-equality-${backend}`);
    mkdirSync(outDir, { recursive: true });
    const sourcePath = join(outDir, backend === "c" ? "program.c" : "program.ll");
    writeFileSync(
      sourcePath,
      backend === "c" ? emitModule(mod) : emitLlvmModule(mod, { pointerBits: 64 }),
    );
    const binaryPath = join(outDir, "program");
    await compileC({
      cPath: sourcePath,
      outPath: binaryPath,
      linkInputs: [fixtureObject()],
      sanitize,
    });
    const run = spawnSync(binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("refuses a peer when the platform declares no terminal event", async () => {
    const native = frontendNativeInput();
    const result = await compile(
      join(repoRoot, "tests/native-ir/native-base-refused.ts"),
      {
        outDir: join(scratch, `native-base-refused-${backend}`),
        outPath: join(scratch, `native-base-refused-${backend}`, "program"),
        backend,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: {
          ...native,
          sourceTypes: [
            ...native.sourceTypes,
            {
              declaration: { module: nativePackage, name: "NativeCounter" },
              type: COUNTER,
            },
          ],
          bindings: [
            ...native.bindings,
            {
              id: "scriptc.fixture.c-v1@0.0.0#counter_construct",
              declaration: { module: nativePackage, name: "NativeCounter" },
              entry: { symbol: "nts_counter_create_with_initial_value" },
              sourceCall: { kind: "constructor" },
              error: NO_NATIVE_ERROR,
              ...directSignature([{
                name: "initial_value",
                type: I32,
                passMode: "value",
                ownership: { kind: "value" },
              }]),
              result: {
                type: COUNTER,
                passMode: "pointer" as const,
                ownership: {
                  kind: "owned" as const,
                  transfer: "to-runtime" as const,
                  destructor: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
                },
                projection: DIRECT_RESULT,
              },
            },
          ],
        },
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a native base compiled");
    /* WHICH refusal is the whole point. The old message described the base's
     * TypeScript declaration as absent, which is both true and useless when
     * that declaration is imported and correct — it sends a reader hunting for
     * an import they already wrote. */
    const messages = result.diagnostics.map(({ message }) => message);
    /* The blanket member refusal is gone. This platform shape still cannot
     * host a peer because its selection states no event that releases the
     * registration's strong root. */
    expect(messages.some((message) =>
      message.includes("instance fields on 'Ticker'") &&
      message.includes("declares no terminal event")
    )).toBe(true);
    expect(messages.some((message) =>
      message.includes("not declared in the program")
    )).toBe(false);
  });

  localFixtureTest("lowers native class construction and static factories through a namespace import", async () => {
    const destructor = "scriptc.fixture.c-v1@0.0.0#counter_destroy";
    const resultType = {
      type: COUNTER,
      passMode: "pointer" as const,
      ownership: {
        kind: "owned" as const,
        transfer: "to-runtime" as const,
        destructor,
      },
      projection: DIRECT_RESULT,
    };
    const native = frontendNativeInput();
    const result = await compile(
      join(repoRoot, "tests/native-ir/class-construction.ts"),
      {
        outDir: join(scratch, `class-construction-${backend}`),
        outPath: join(scratch, `class-construction-${backend}`, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: {
          ...native,
          sourceTypes: [
            ...native.sourceTypes,
            {
              declaration: { module: nativePackage, name: "NativeCounter" },
              type: COUNTER,
            },
          ],
          bindings: [
            ...native.bindings,
            {
              id: "scriptc.fixture.c-v1@0.0.0#counter_construct",
              declaration: { module: nativePackage, name: "NativeCounter" },
              entry: { symbol: "nts_counter_create_with_initial_value",
              },
              sourceCall: { kind: "constructor" },
              error: NO_NATIVE_ERROR,
              ...directSignature([{
                name: "initial_value",
                type: I32,
                passMode: "value",
                ownership: { kind: "value" },
              }]),
              result: resultType,
            },
            {
              id: "scriptc.fixture.c-v1@0.0.0#counter_with_initial_value",
              declaration: {
                module: nativePackage,
                name: "NativeCounter.withInitialValue",
              },
              entry: { symbol: "nts_counter_create_static" },
              sourceCall: { kind: "function" },
              error: NO_NATIVE_ERROR,
              ...directSignature([{
                name: "initial_value",
                type: I32,
                passMode: "value",
                ownership: { kind: "value" },
              }]),
              result: resultType,
            },
          ],
        },
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) return;
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(mod.nativeBindings?.map((binding) => binding.id).sort()).toEqual([
      "scriptc.fixture.c-v1@0.0.0#counter_construct",
      "scriptc.fixture.c-v1@0.0.0#counter_destroy",
      "scriptc.fixture.c-v1@0.0.0#counter_with_initial_value",
    ]);
    expect(spawnSync(result.binaryPath).status).toBe(0);
  });

  test("preserves exact-width integer arithmetic and bitwise operations", async () => {
    const outDir = join(scratch, `arithmetic-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/arithmetic.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native arithmetic frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(serializeModule(mod)).toContain('"kind": "nativeIntegerBin"');
    const generated = readFileSync(
      join(outDir, backend === "c" ? "arithmetic.c" : "arithmetic.ll"),
      "utf8",
    );
    if (backend === "c") {
      for (const helper of [
        "scr_native_i8_add",
        "scr_native_i8_or",
        "scr_native_u8_and",
        "scr_native_u8_mul",
        "scr_native_i16_mul",
        "scr_native_i16_xor",
        "scr_native_u16_or",
        "scr_native_u16_sub",
        "scr_native_i32_add",
        "scr_native_i32_and",
        "scr_native_i32_sub",
        "scr_native_i32_mul",
        "scr_native_u32_xor",
        "scr_native_u32_mul",
        "scr_native_i64_or",
        "scr_native_i64_mul",
        "scr_native_u64_and",
        "scr_native_u64_sub",
        "scr_native_isize_xor",
        "scr_native_isize_mul",
        "scr_native_usize_or",
        "scr_native_usize_sub",
      ]) {
        expect(generated).toContain(helper);
      }
    } else {
      expect(generated).toMatch(/= add i8/);
      expect(generated).toMatch(/= mul i8/);
      expect(generated).toMatch(/= or i8/);
      expect(generated).toMatch(/= and i8/);
      expect(generated).toMatch(/= mul i16/);
      expect(generated).toMatch(/= xor i16/);
      expect(generated).toMatch(/= or i16/);
      expect(generated).toMatch(/= sub i16/);
      expect(generated).toMatch(/= add i32/);
      expect(generated).toMatch(/= and i32/);
      expect(generated).toMatch(/= sub i32/);
      expect(generated).toMatch(/= mul i32/);
      expect(generated).toMatch(/= xor i32/);
      expect(generated).toMatch(/= or i64/);
      expect(generated).toMatch(/= mul i64/);
      expect(generated).toMatch(/= and i64/);
      expect(generated).toMatch(/= sub i64/);
      expect(generated).toMatch(/= xor i64/);
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR boolean projections, %s backend", (backend) => {
  test("projects TypeScript boolean parameters and exact native results", async () => {
    const outDir = join(scratch, `boolean-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/boolean-result.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native boolean frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(serializeModule(mod)).toContain('"kind": "boolean"');
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR checked-number boundary, %s backend", (backend) => {
  localFixtureTest("converts plain numbers at the boundary and widens results", async () => {
    const outDir = join(scratch, `number-boundary-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-boundary.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("checked-number frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(serializeModule(mod)).toContain('"kind": "number"');
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("widens number-projected callback payloads in both trampolines", async () => {
    const outDir = join(scratch, `number-callback-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-callback.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("elides the boundary check for proven literal arguments", async () => {
    const outDir = join(scratch, `number-literal-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-literal.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "number-literal.c" : "number-literal.ll"),
      "utf8",
    );
    /* Every call in the fixture passes a proven literal, so no conversion
     * machinery may survive anywhere in the translation unit. */
    if (backend === "c") {
      expect(generated).not.toContain("_from_number(");
    } else {
      expect(generated).not.toContain("@llvm.trunc.f64");
    }
    expect(generated).not.toContain("scr_native_throw_number");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("borrows a managed string array as a NUL-terminated vector", async () => {
    const outDir = join(scratch, `cstring-array-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/cstring-array.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "cstring-array.c" : "cstring-array.ll"),
      "utf8",
    );
    /* A borrowed vector has TWO ways out, so releases outnumber borrows: the
     * teardown after the call, and — for the calls that convert another
     * argument after the borrow — the unwind of a conversion that throws.
     * A raw allocation is invisible to the unwind, so if the second site were
     * missing the count would fall back to equal here and the leak would show
     * up only in the sanitized lane. */
    const borrows = generated.split("scr_native_cstring_array_borrow").length - 1;
    const releases = generated.split("scr_native_cstring_array_release").length - 1;
    expect(borrows).toBeGreaterThan(0);
    expect(releases).toBeGreaterThan(borrows);
    /* The nullable call site reads its tag at RUNTIME. The program feeds it a
     * variable the emitter cannot narrow, so a build that folded the arm away
     * would still exit 42 while testing nothing — this is what says the union
     * path ran rather than a constant. */
    expect(generated).toMatch(
      backend === "c" ? /tag == \d+ \? scr_native_cstring_array_borrow/u : /native\.cstrv\.present/u,
    );
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("copies a returned byte span whose length arrives beside it", async () => {
    const outDir = join(scratch, `bytes-result-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/bytes-result.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("keeps a string result across a failure that arrives in a slot", async () => {
    const outDir = join(scratch, `error-out-string-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/error-out-string.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (backend === "c") {
      /* The ordering, pinned structurally rather than left to the fixture's
       * dangling pointer to catch at runtime: the error slot is read and the
       * unwind emitted BEFORE the string is copied or freed. The runtime
       * check would crash if this were wrong, but only while the fixture
       * keeps answering an unmapped pointer — this stays true regardless. */
      const generated = readFileSync(join(outDir, "error-out-string.c"), "utf8");
      /* The CALL, not the extern prototype the file opens with. */
      const call = generated.indexOf("= nts_error_out_label(");
      const unwind = generated.indexOf("scr_exc_pending()", call);
      const copy = generated.indexOf("scr_str_from_c_data", call);
      const release = generated.indexOf("nts_cstring_free", call);
      expect(unwind).toBeGreaterThan(-1);
      expect(copy).toBeGreaterThan(unwind);
      expect(release).toBeGreaterThan(unwind);
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("copies a returned vector out of the callee's storage", async () => {
    const outDir = join(scratch, `cstring-array-result-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/cstring-array-result.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "cstring-array-result.c" : "cstring-array-result.ll"),
      "utf8",
    );
    /* The disposal is the symbol the binding names, at exactly the call sites
     * whose binding names it. Counting it against the owned call itself is
     * what makes that checkable without pinning a number: both counts include
     * one declaration, so they cancel, and an emitter that grew a POLICY —
     * freeing what it decided rather than what it was told — would release
     * the borrowed vectors too and push the release count above it. The
     * fixture's borrowed vector is static storage, so that mistake is a crash
     * rather than a wrong answer, and this catches it before the run does. */
    const releases = generated.split("nts_cstring_array_free").length - 1;
    const ownedCalls = generated.split("nts_cstring_array_made").length - 1;
    expect(releases).toBeGreaterThan(0);
    expect(releases).toEqual(ownedCalls);
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("reads an answer beside the value it answers about", async () => {
    const outDir = join(scratch, `answered-field-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/answered-field.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "answered-field.c" : "answered-field.ll"),
      "utf8",
    );
    /* C's truth test is total, so a boolean field read emits no validation
     * and no throw — including in the sanitized build, where a reading that
     * COULD fail would keep its check. That is the difference between this
     * projection and the exact one a boolean result may declare. */
    expect(generated).not.toContain("scr_native_throw_boolean");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("elides the boundary check the number facts prove", async () => {
    const outDir = join(scratch, `number-proven-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-proven.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "number-proven.c" : "number-proven.ll"),
      "utf8",
    );
    const checkMarker = backend === "c" ? "_from_number(" : "@llvm.trunc.f64";
    /* Every crossing in the fixture is proven, so an ordinary build emits
     * no conversion machinery at all. The sanitized build keeps every
     * check: a proof that was wrong throws there instead of quietly
     * converting a value the slot cannot hold, which is what makes the
     * same fixture a soundness test rather than only a codegen one. */
    if (sanitize) {
      expect(generated).toContain(checkMarker);
    } else {
      expect(generated).not.toContain(checkMarker);
      expect(generated).not.toContain("scr_native_throw_number");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("refuses the decimal spelling of a bit pattern it admits in hex", async () => {
    const outDir = join(scratch, `bit-pattern-decimal-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/bit-pattern-decimal-refused.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    /* Without this the rule would read as "large literals are fine now", and
     * the next person would widen it to computed values, where nobody can see
     * what width the bits were meant for. */
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a decimal quantity out of range must not compile");
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("which no 'i32' value represents") &&
        diagnostic.message.includes("hex, binary or octal")
      ),
    ).toBe(true);
  });

  localFixtureTest("refuses a literal argument no native value can hold", async () => {
    const outDir = join(scratch, `number-literal-refused-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-literal-refused.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unrepresentable literal must not compile");
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("which no 'u8' value represents")
      ),
    ).toBe(true);
  });

  /* Local-only, like every other number-projection case: the parent's fixture
   * manifest deliberately keeps its scalars exact, so the number flavors of
   * these symbols exist only in this harness. */
  localFixtureTest("carries a number over a 64-bit slot, checked in both directions", async () => {
    const outDir = join(scratch, `number-wide-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/number-wide.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("the wide number projection failed to compile");
    // 42 only if every ingress, egress, and refusal above answered.
    const run = spawnSync(join(outDir, "program"));
    expect({
      status: run.status,
      signal: run.signal,
      stderr: run.stderr.toString(),
    }).toEqual({ status: 42, signal: null, stderr: "" });
  });
});

describe.each(["c", "llvm"] as const)("Native IR aggregate ABI, %s backend", (backend) => {
  test("constructs and round-trips the authoritative padded struct by value", async () => {
    const outDir = join(scratch, `aggregate-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/aggregate.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native aggregate frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeTypes).toEqual([
      expect.objectContaining({
        id: PADDED_ID,
        size: 24,
        alignment: 8,
        abi: PADDED_ABI,
      }),
    ]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "aggregate.c" : "aggregate.ll"),
      "utf8",
    );
    if (backend === "c") {
      expect(generated).toContain("Native IR aggregate field offset mismatch");
    } else {
      expect(generated).toContain("sret(");
      expect(generated).toContain("byval(");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("coerces a direct-register struct exactly as target Clang classified it", async () => {
    const outDir = join(scratch, `aggregate-direct-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/aggregate-direct.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("direct native aggregate frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeTypes).toEqual([
      expect.objectContaining({ id: PAIR32_ID, abi: DIRECT_I64_AGGREGATE_ABI }),
    ]);
    if (backend === "llvm") {
      const generated = readFileSync(join(outDir, "aggregate-direct.ll"), "utf8");
      expect(generated).toContain("declare i64 @nts_pair32_transform(i64)");
      expect(generated).not.toContain("sret(");
      expect(generated).not.toContain("byval(");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("expands one logical struct into multiple physical ABI values", async () => {
    const outDir = join(scratch, `aggregate-expanded-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/aggregate-expanded.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("expanded native aggregate frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeTypes).toEqual([
      expect.objectContaining({ id: PAIR_F64_ID, abi: EXPANDED_F64_AGGREGATE_ABI }),
    ]);
    if (backend === "llvm") {
      const generated = readFileSync(join(outDir, "aggregate-expanded.ll"), "utf8");
      expect(generated).toContain("declare { double, double } @nts_pair_f64_transform(double, double)");
      expect(generated).toContain("declare i32 @nts_pair_f64_verify(double, double)");
      expect(generated).toContain("extractvalue { double, double }");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("constructs and reads nested nominal aggregate fields", async () => {
    const outDir = join(scratch, `aggregate-nested-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/aggregate-nested.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("nested native aggregate frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeTypes).toEqual([
      expect.objectContaining({ id: PAIR32_ID }),
      expect.objectContaining({
        id: NESTED_PAIR32_ID,
        fields: [
          { name: "left", type: PAIR32, offset: 0 },
          { name: "right", type: PAIR32, offset: 8 },
          { name: "marker", type: I64, offset: 16 },
        ],
      }),
    ]);
    const generated = readFileSync(
      join(outDir, backend === "c" ? "aggregate-nested.c" : "aggregate-nested.ll"),
      "utf8",
    );
    if (backend === "c") {
      expect(generated.indexOf(`} ${mangleNativeStruct(PAIR32_ID)};`)).toBeLessThan(
        generated.indexOf(`} ${mangleNativeStruct(NESTED_PAIR32_ID)};`),
      );
    } else {
      expect(generated).toContain(`%${mangleNativeStruct(NESTED_PAIR32_ID)} = type { %${mangleNativeStruct(PAIR32_ID)}`);
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR borrowed UTF-8, %s backend", (backend) => {
  test("evaluates once and passes exact UTF-8 bytes including embedded NUL", async () => {
    const outDir = join(scratch, `utf8-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/utf8.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native UTF-8 frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#hash_utf8",
        arguments: [{ name: "data", type: { kind: "string" } }],
        parameters: [
          expect.objectContaining({ projection: { kind: "utf8Data", argument: 0 } }),
          expect.objectContaining({ projection: { kind: "utf8ByteLength", argument: 0 } }),
        ],
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? "utf8.c" : "utf8.ll"),
      "utf8",
    );
    if (backend === "c") {
      expect(generated).toContain("->data");
      expect(generated).toContain("->len");
    } else {
      expect(generated).toContain("getelementptr inbounds %ScrStr");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR checked UTF-8 C strings, %s backend", (backend) => {
  test("passes the trailing NUL and rejects an embedded NUL before native entry", async () => {
    const outDir = join(scratch, `utf8-c-string-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/utf8-c-string.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native UTF-8 C-string frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#c_string_observe",
        arguments: [{ name: "data", type: { kind: "string" } }],
        parameters: [
          expect.objectContaining({ projection: { kind: "utf8CString", argument: 0 } }),
        ],
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? "utf8-c-string.c" : "utf8-c-string.ll"),
      "utf8",
    );
    expect(generated).toContain("scr_str_c_data");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  localFixtureTest("projects direct and union string/null values to a nullable native pointer", async () => {
    const outDir = join(scratch, `nullable-utf8-c-string-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/nullable-utf8-c-string.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("nullable native UTF-8 C-string frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#nullable_c_string_observe",
        arguments: [{ name: "data", type: { kind: "nullableString" } }],
        parameters: [
          expect.objectContaining({ projection: { kind: "utf8CString", argument: 0 } }),
        ],
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? "nullable-utf8-c-string.c" : "nullable-utf8-c-string.ll"),
      "utf8",
    );
    expect(generated).toContain("scr_str_c_data");
    expect(generated).toContain(backend === "c" ? "scr_union_peek" : "phi ptr");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR borrowed UTF-8 C-string results, %s backend", (backend) => {
  test("copies before disposal and enforces nullable and non-null contracts", async () => {
    const outDir = join(scratch, `c-string-result-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/c-string-result.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native C-string-result frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#counter_label",
        result: {
          type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
          projection: { kind: "utf8CString", nullable: true, release: { kind: "none" } },
        },
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? "c-string-result.c" : "c-string-result.ll"),
      "utf8",
    );
    expect(generated).toContain("scr_str_from_c_data");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR borrowed bytes, %s backend", (backend) => {
  test.each([
    ["Uint8Array", "bytes.ts"],
    ["Buffer", "bytes-buffer.ts"],
  ] as const)("passes an offset %s view once and observes backing-store mutation", async (_kind, source) => {
    const stem = source.slice(0, -3);
    const outDir = join(scratch, `${stem}-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir", source), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native borrowed-byte frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#hash_bytes",
        arguments: [{ name: "data", type: { kind: "bytes", elem: "u8" } }],
        parameters: [
          expect.objectContaining({ projection: { kind: "bytesData", argument: 0 } }),
          expect.objectContaining({
            projection: { kind: "bytesLength", argument: 0, units: "elements" },
          }),
        ],
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? `${stem}.c` : `${stem}.ll`),
      "utf8",
    );
    if (backend === "c") {
      expect(generated).toContain("->data");
      expect(generated).toContain("->len");
    } else {
      expect(generated).toContain("getelementptr inbounds %ScrBytes");
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR call-scoped callbacks, %s backend", (backend) => {
  test.each([
    ["forwards exact values and captured closure state", "callback-call-scoped.ts"],
    ["propagates a callback exception after native return", "callback-call-scoped-throw.ts"],
  ] as const)("%s", async (_label, source) => {
    const stem = source.slice(0, -3);
    const outDir = join(scratch, `${stem}-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir", source), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native call-scoped callback compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#call_scoped",
        arguments: [
          {
            name: "callback",
            type: CALL_I32_SOURCE,
            callback: CALL_I32_CONTRACT,
          },
          { name: "value", type: I32 },
        ],
        parameters: [
          expect.objectContaining({ projection: { kind: "callbackFunction", argument: 0 } }),
          expect.objectContaining({ projection: { kind: "callbackContext", argument: 0 } }),
          expect.objectContaining({ projection: { kind: "argument", argument: 1 } }),
        ],
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? `${stem}.c` : `${stem}.ll`),
      "utf8",
    );
    expect(generated).toContain("sc_native_cb_");
    expect(generated).toContain("scr_exc_pending");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)(
  "Native IR retained callbacks, %s backend",
  (backend) => {
    test("hands executable liveness to an attached owner loop", async () => {
      const outDir = join(scratch, `callback-attached-loop-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/callback-attached-loop.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [
            fixtureObject(),
            supportObject(),
            retainedSupportObject(),
          ],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) {
        throw new Error("native attached-loop compile failed");
      }
      const generated = readFileSync(
        join(
          outDir,
          backend === "c"
            ? "callback-attached-loop.c"
            : "callback-attached-loop.ll",
        ),
        "utf8",
      );
      expect(generated).toContain("scr_loop_run");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 0, signal: null, stderr: "" });
    });

    test("hands its next timer deadline to the attached owner loop", async () => {
      const outDir = join(scratch, `callback-attached-timer-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/callback-attached-timer.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [
            fixtureObject(),
            supportObject(),
            retainedSupportObject(),
          ],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) {
        throw new Error("native attached-loop timer compile failed");
      }
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 0, signal: null, stderr: "" });
    });

    test("copies foreign-thread payloads and invokes the rooted closure on the owner", async () => {
      const outDir = join(scratch, `callback-retained-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/callback-retained.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [
            fixtureObject(),
            supportObject(),
            retainedSupportObject(),
          ],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("native retained callback compile did not emit IR");
      }
      const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(validateModule(mod)).toEqual([]);
      expect(mod.nativeBindings).toContainEqual(
        expect.objectContaining({
          id: "scriptc.fixture.c-v1@0.0.0#subscription_create",
          arguments: [
            {
              name: "callback",
              type: RETAINED_I32_SOURCE,
              callback: RETAINED_I32_CONTRACT,
            },
          ],
        }),
      );
      const generated = readFileSync(
        join(outDir, backend === "c" ? "callback-retained.c" : "callback-retained.ll"),
        "utf8",
      );
      expect(generated).toContain("scr_callback_invocation_alloc");
      expect(generated).toContain("scr_retained_callbacks_prepare");
      expect(generated).toContain("scr_native_handle_commit");
      expect(generated).toContain("scr_native_handle_abandon");
      const prepareCall = backend === "c"
        ? generated.indexOf("= scr_native_handle_prepare(")
        : generated.indexOf("= call ptr @scr_native_handle_prepare(");
      const factoryCall = backend === "c"
        ? generated.indexOf("= nts_subscription_create(")
        : generated.indexOf("= call ptr @nts_subscription_create(");
      const commitCall = backend === "c"
        ? generated.indexOf("scr_native_handle_commit(")
        : generated.indexOf("call void @scr_native_handle_commit(");
      expect(prepareCall).toBeGreaterThanOrEqual(0);
      expect(factoryCall).toBeGreaterThan(prepareCall);
      expect(commitCall).toBeGreaterThan(factoryCall);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 94, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR error-object failures, %s backend",
  (backend) => {
    test("throws the object's message and releases it exactly once", async () => {
      const outDir = join(scratch, `error-handle-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/error-handle.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("native error-handle frontend compile did not emit IR");
      }
      const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(validateModule(mod)).toEqual([]);
      expect(mod.nativeBindings).toContainEqual(
        expect.objectContaining({
          id: "scriptc.fixture.c-v1@0.0.0#error_handle_fail",
          error: {
            detect: { kind: "resultIsNotNull" },
            message: { kind: "symbol", symbol: "nts_fixture_error_message" },
            release: { kind: "symbol", symbol: "nts_fixture_error_free" },
          },
        }),
      );
      const generated = readFileSync(
        join(outDir, backend === "c" ? "error-handle.c" : "error-handle.ll"),
        "utf8",
      );
      expect(generated).toContain("scr_native_throw_native_error");
      expect(generated).toContain("nts_fixture_error_free");
      // 42 only if the success path did not throw, the failure path threw the
      // object's message, and the outstanding count returned to zero.
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR nullable handle arguments, %s backend",
  (backend) => {
    test("passes null without consulting the handle table", async () => {
      const outDir = join(scratch, `nullable-handle-arg-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/nullable-handle-argument.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("nullable handle compile failed");
      // 42 only if a present handle borrowed, a literal null passed NULL, and
      // a union carrying either arm did the right thing at one call site.
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR nullable handle arguments reached by nothing else, %s backend",
  (backend) => {
    test("keeps the nominal type a null-only slot is the sole mention of", async () => {
      const outDir = join(scratch, `nullable-handle-only-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/nullable-handle-only.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("null-only handle compile did not emit IR");
      }
      /* The module has to CARRY the type, not merely compile. A strip that
       * dropped it left the binding pointing at a type the table no longer
       * had, which is an internal error rather than a wrong answer. */
      const module = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(validateModule(module)).toEqual([]);
      expect((module.nativeTypes ?? []).map(({ id }) => id))
        .toContain(COUNTER_ID);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR untouched handle payloads, %s backend",
  (backend) => {
    test("keeps the payload's nominal type when the handler never reads it", async () => {
      const outDir = join(scratch, `payload-untouched-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/payload-untouched.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("untouched payload compile did not emit IR");
      }
      const module = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(validateModule(module)).toEqual([]);
      expect((module.nativeTypes ?? []).map(({ id }) => id))
        .toContain(COUNTER_ID);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR withheld handle payloads, %s backend",
  (backend) => {
    test("hands the handler null and an object through one registration", async () => {
      const outDir = join(scratch, `payload-absent-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/payload-absent.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("withheld payload compile did not emit IR");
      }
      const module = deserializeModule(readFileSync(result.irPath, "utf8"));
      expect(validateModule(module)).toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR withheld payloads an owner anchors, %s backend",
  (backend) => {
    test("answers while holding a subject that may not be there", async () => {
      const outDir = join(scratch, `payload-absent-answered-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/payload-absent-answered.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("owner-anchored withheld payload compile did not emit IR");
      }
      expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
        .toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR constants declared as numbers, %s backend",
  (backend) => {
    test("admits an exact integer constant a surface can only spell as number", async () => {
      const outDir = join(scratch, `constant-number-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/constant-number.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("number-declared constant compile failed");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR bit-pattern literals, %s backend",
  (backend) => {
    test("admits a radix-spelled literal that fills a signed slot", async () => {
      const outDir = join(scratch, `bit-pattern-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/bit-pattern-literal.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("bit-pattern literal compile failed");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR nested class declarations, %s backend",
  (backend) => {
    /* Local-only: a C fixture has no nested classes and no reason to grow
     * them, so this shape extends the in-tree fixture with declarations an
     * embedder-supplied one does not promise. Its contract-level proof is the
     * JVM lane, where a platform's inner classes are the reason the spelling
     * exists at all. */
    localFixtureTest("resolves a dotted type name through its owner's value side", async () => {
      const outDir = join(scratch, `nested-class-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/nested-class.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("nested class compile failed");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR peer fields, %s backend",
  (backend) => {
    /* The observer for instance fields: the local C fixture supplies an
     * identity:none host, a generated-receiver-shaped peer slot, and two
     * deliveries on one object. The parent cross-gate supplies a different
     * generated package, so this exact platform mechanism remains local. */
    localFixtureTest("keeps a field across two lifecycle dispatches on one object", async () => {
      const outDir = join(scratch, `native-peer-fields-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/native-peer-fields.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("peer field compile failed");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR uninterned handles, %s backend",
  (backend) => {
    /* The identity arm every other fixture handle cannot express. Until this
     * existed both fixtures declared `pointer` everywhere, so the whole
     * non-interning path — a cell per arrival, each owning its own reference —
     * ran only end to end through the Android lanes, where a defect in it
     * surfaces as a leak or a double release far from its cause. */
    test("builds a cell per arrival and releases each exactly once", async () => {
      const outDir = join(scratch, `uninterned-handle-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/uninterned-handle.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok) throw new Error("uninterned handle compile failed");
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)(
  "Native IR native base classes, %s backend",
  (backend) => {
    /* NOT a local-fixture test: the parent's SCABI fixture declares the same
     * tick surface, so the cross-gate runs `baseCall` through the manifest,
     * its validation and the translator rather than only through the IR the
     * fork hands itself. A field no gate reads is a field that cannot fail. */
    test("registers an override and reaches an inherited member through this", async () => {
      const outDir = join(scratch, `native-subclass-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/native-subclass.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("native base class compile failed");
      }
      expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
        .toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({
        status: run.status,
        signal: run.signal,
        stderr: run.stderr.toString(),
      }).toEqual({ status: 42, signal: null, stderr: "" });
    });

    /* The surface declares the base and maps no handle type to it. This
     * compiled SILENTLY before it refused — no registration, no diagnostic,
     * and a link error naming a support symbol as the first sign. Cross-gated
     * for the same reason as the test above: both fixtures declare the class,
     * so the parent's substituted surface reaches the same refusal. */
    test("refuses a base the native surface maps no handle type to", async () => {
      const outDir = join(scratch, `native-base-unmapped-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/native-base-unmapped.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unmapped native base compiled");
      expect(
        result.diagnostics.some(({ code, message }) =>
          code === "SC1090" &&
          message.includes("'UnmappedSource'") &&
          message.includes("maps no handle type to it")
        ),
      ).toBe(true);
    });
  },
);

describe.each(["c", "llvm"] as const)("Native IR errno errors, %s backend", (backend) => {
  test("snapshots errno and throws a catchable operation-qualified Error", async () => {
    const outDir = join(scratch, `errno-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir/errno.ts"), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native errno frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeBindings).toContainEqual(
      expect.objectContaining({
        id: "scriptc.fixture.c-v1@0.0.0#fail_errno",
        error: errnoFailure("-1"),
        result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
      }),
    );
    const generated = readFileSync(
      join(outDir, backend === "c" ? "errno.c" : "errno.ll"),
      "utf8",
    );
    expect(generated).toContain("scr_native_errno_snapshot");
    expect(generated).toContain("scr_native_throw_errno");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });

  test("preserves an exception already pending from the same native call", async () => {
    const outDir = join(scratch, `errno-callback-precedence-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/errno-callback-precedence.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("native errno callback-precedence compile failed");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

describe.each(["c", "llvm"] as const)("Native IR nullable handles, %s backend", (backend) => {
  test.each([
    ["throws before wrapping a null owned result", "nullable-handle.ts"],
    ["wraps and destroys a non-null owned result", "nullable-handle-success.ts"],
    [
      "wraps a non-null result before unwinding a pending callback exception",
      "nullable-handle-callback-throw.ts",
    ],
  ] as const)("%s", async (_label, source) => {
    const stem = source.slice(0, -3);
    const outDir = join(scratch, `${stem}-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir", source), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error("native nullable-handle compile failed");
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});

/* A registration nothing owns, through every layer at once.
 *
 * The validator's case builds a module directly and the translator's builds a
 * manifest, so materialization — the step between them — was exercised by
 * neither, and a contract that passed both met an internal error there. Three
 * layers on one contract, each with a passing test of its own arm. This is the
 * program that travels all of them.
 */
describe.each(["c", "llvm"] as const)(
  "Native IR process-owned registrations, %s backend",
  (backend) => {
    test("a registration nothing owns delivers, twice, and releases its payloads", async () => {
      const outDir = join(scratch, `process-owned-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/process-owned.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("process-owned frontend compile did not emit IR");
      }
      expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
        .toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() })
        .toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

/* A UTF-8 span result, which had no running program until now.
 *
 * The arm shipped and was exercised only by `validateModule` here — its
 * emission ran solely through the parent's lanes, so this fork refactored the
 * family into a shared copy description with no program able to say the
 * lowering still worked. That is the gap
 * [0012](../../../../docs/records/0012-checks-that-cannot-fail.md) names,
 * closed rather than recorded. */
describe.each(["c", "llvm"] as const)(
  "Native IR UTF-8 span results, %s backend",
  (backend) => {
    test("text containing NUL survives the copy in both nullabilities", async () => {
      const outDir = join(scratch, `span-result-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/span-result.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("span result frontend compile did not emit IR");
      }
      expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
        .toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() })
        .toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

/* Synchronous delivery holding an OBJECT, in both of its forms.
 *
 * The pair is what matters. Handle payloads were reachable on the queued path
 * and synchronous delivery was reachable with exact scalars, so two complete
 * lists agreed while the shape they imply — a handler that runs inside the
 * caller's frame with a managed cell in its hands — was reachable from
 * neither. That is the same trap as a sub-word result with a failure slot, and
 * the reason this program exists rather than a wider unit assertion.
 *
 * It also gives the queued handle-payload machinery its first running program
 * in this repository, which it had never had. */
describe.each(["c", "llvm"] as const)(
  "Native IR synchronous handle payloads, %s backend",
  (backend) => {
    test("a handler told and a handler asked both receive a managed cell", async () => {
      const outDir = join(scratch, `synchronous-payload-${backend}`);
      const result = await compile(
        join(repoRoot, "tests/native-ir/synchronous-payload.ts"),
        {
          outDir,
          outPath: join(outDir, "program"),
          backend,
          emitIr: true,
          sanitize,
          externalTypes: nativeExternalTypes(),
          native: frontendNativeInput(),
          nativeLinkInputs: [fixtureObject(), supportObject(), retainedSupportObject()],
        },
      );
      expect(result.ok ? [] : result.diagnostics).toEqual([]);
      if (!result.ok || result.irPath === undefined) {
        throw new Error("synchronous payload frontend compile did not emit IR");
      }
      expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
        .toEqual([]);
      const run = spawnSync(result.binaryPath);
      expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() })
        .toEqual({ status: 42, signal: null, stderr: "" });
    });
  },
);

describe.each(["c", "llvm"] as const)("Native IR opaque handles, %s backend", (backend) => {
  localFixtureTest("keeps a non-escaping result frame-bounded and an escaping sibling stable", async () => {
    const outDir = join(scratch, `handle-frame-bounded-${backend}`);
    const result = await compile(
      join(repoRoot, "tests/native-ir/handle-frame-bounded.ts"),
      {
        outDir,
        outPath: join(outDir, "program"),
        backend,
        emitIr: true,
        sanitize,
        externalTypes: nativeExternalTypes(),
        native: frontendNativeInput(),
        nativeLinkInputs: [fixtureObject(), frameFixtureObject(), supportObject()],
      },
    );
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("frame-bounded handle observer did not emit IR");
    }
    expect(validateModule(deserializeModule(readFileSync(result.irPath, "utf8"))))
      .toEqual([]);
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() })
      .toEqual({ status: 42, signal: null, stderr: "" });
  });

  test.each([
    ["identity upcasts preserve the managed cell and validate base calls", "handle-upcast.ts"],
    ["explicit disposal is alias-safe and idempotent", "handle-explicit.ts"],
    ["last-reference release runs the destructor", "handle-automatic.ts"],
    ["captured mutable aliases share ownership", "handle-captured.ts"],
    ["records and arrays retain the managed cell", "handle-stored.ts"],
    ["use after dispose throws through the ordinary catch path", "handle-use-after-dispose.ts"],
  ] as const)("%s", async (_label, source) => {
    const stem = source.slice(0, -3);
    const outDir = join(scratch, `${stem}-${backend}`);
    const result = await compile(join(repoRoot, "tests/native-ir", source), {
      outDir,
      outPath: join(outDir, "program"),
      backend,
      emitIr: true,
      sanitize,
      externalTypes: nativeExternalTypes(),
      native: frontendNativeInput(),
      nativeLinkInputs: [fixtureObject(), supportObject()],
    });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    if (!result.ok || result.irPath === undefined) {
      throw new Error("native handle frontend compile did not emit IR");
    }
    const mod = deserializeModule(readFileSync(result.irPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(mod.nativeTypes).toContainEqual(
      expect.objectContaining({
        kind: "handle",
        id: "scriptc.fixture.c-v1@0.0.0#type:counter",
      }),
    );
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
  });
});
