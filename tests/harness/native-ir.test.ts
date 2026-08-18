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
  transports: [{ kind: "borrow" }],
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
  transports: [{ kind: "copy" }],
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
  transports: [{ kind: "borrow" }],
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
    { declaration: { module: nativePackage, name: "PairF64" }, type: PAIR_F64 },
    { declaration: { module: nativePackage, name: "NestedPair32" }, type: NESTED_PAIR32 },
    { declaration: { module: nativePackage, name: "CounterBase" }, type: COUNTER_BASE },
    { declaration: { module: nativePackage, name: "CounterMiddle" }, type: COUNTER_MIDDLE },
    { declaration: { module: nativePackage, name: "Counter" }, type: COUNTER },
    {
      declaration: { module: nativePackage, name: "Subscription" },
      type: SUBSCRIPTION,
    },
    { declaration: { module: nativePackage, name: "Asker" }, type: ASKER },
    { declaration: { module: nativePackage, name: "Vault" }, type: VAULT },
  ],
  constants: [{
    id: "scriptc.fixture.c-v1@0.0.0#fixture_answer",
    declaration: { module: nativePackage, name: "FixtureValue.answer" },
    type: I32,
    value: "42",
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
    PAIR_F64_DEFINITION,
    NESTED_PAIR32_DEFINITION,
    COUNTER_BASE_DEFINITION,
    COUNTER_MIDDLE_DEFINITION,
    COUNTER_DEFINITION,
    SUBSCRIPTION_DEFINITION,
    ASKER_DEFINITION,
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
      entry: { kind: "c-symbol", symbol: "nts_i64_passthrough" },
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
      entry: { kind: "c-symbol", symbol: "nts_pair32_transform" },
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
      id: "scriptc.fixture.c-v1@0.0.0#subscribe_number",
      declaration: { module: nativePackage, name: "subscribeNumber" },
      entry: { kind: "c-symbol", symbol: "nts_subscription_create" },
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
      entry: { kind: "c-symbol", symbol: "nts_call_scoped" },
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
      entry: { kind: "c-symbol", symbol: "nts_call_scoped_f32" },
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
      entry: { kind: "c-symbol", symbol: "nts_boolean_not" },
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
      entry: { kind: "c-symbol", symbol: "nts_padded_roundtrip" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PADDED, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PADDED, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair32_transform",
      declaration: { module: nativePackage, name: "pair32Transform" },
      entry: { kind: "c-symbol", symbol: "nts_pair32_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR32, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PAIR32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair_f64_transform",
      declaration: { module: nativePackage, name: "pairF64Transform" },
      entry: { kind: "c-symbol", symbol: "nts_pair_f64_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR_F64, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PAIR_F64, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#pair_f64_verify",
      declaration: { module: nativePackage, name: "pairF64Verify" },
      entry: { kind: "c-symbol", symbol: "nts_pair_f64_verify" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PAIR_F64, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#nested_pair32_transform",
      declaration: { module: nativePackage, name: "nestedPair32Transform" },
      entry: { kind: "c-symbol", symbol: "nts_nested_pair32_transform" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: NESTED_PAIR32, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: NESTED_PAIR32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#hash_utf8",
      declaration: { module: nativePackage, name: "hashUtf8" },
      entry: { kind: "c-symbol", symbol: "nts_hash_utf8" },
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
      entry: { kind: "c-symbol", symbol: "nts_c_string_observe" },
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
      entry: { kind: "c-symbol", symbol: "nts_nullable_c_string_observe" },
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
      entry: { kind: "c-symbol", symbol: "nts_hash_bytes" },
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
          projection: { kind: "bytesByteLength", argument: 0 },
        },
      ],
      result: { type: U64, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#call_scoped",
      declaration: { module: nativePackage, name: "callScoped" },
      entry: { kind: "c-symbol", symbol: "nts_call_scoped" },
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
      entry: { kind: "c-symbol", symbol: "nts_error_handle_fail" },
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
      id: "scriptc.fixture.c-v1@0.0.0#fixture_errors_outstanding",
      declaration: { module: nativePackage, name: "fixtureErrorsOutstanding" },
      entry: { kind: "c-symbol", symbol: "nts_fixture_errors_outstanding" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#fail_errno",
      declaration: { module: nativePackage, name: "failErrno" },
      entry: { kind: "c-symbol", symbol: "nts_fail_errno" },
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
      entry: { kind: "c-symbol", symbol: "nts_vault_create" },
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
      entry: { kind: "c-symbol", symbol: "nts_vault_adopt" },
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
      entry: { kind: "c-symbol", symbol: "nts_vault_value" },
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
      entry: { kind: "c-symbol", symbol: "nts_vault_destroy" },
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
      entry: { kind: "c-symbol", symbol: "nts_asker_create" },
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
      id: "scriptc.fixture.c-v1@0.0.0#answerer_create",
      declaration: { module: nativePackage, name: "answerWith" },
      entry: { kind: "c-symbol", symbol: "nts_answerer_create" },
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
      entry: { kind: "c-symbol", symbol: "nts_answerer_destroy" },
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
      entry: { kind: "c-symbol", symbol: "nts_asker_ask" },
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
      entry: { kind: "c-symbol", symbol: "nts_asker_asked" },
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
      entry: { kind: "c-symbol", symbol: "nts_asker_destroy" },
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
      entry: { kind: "c-symbol", symbol: "nts_subscription_create" },
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
      entry: { kind: "c-symbol", symbol: "nts_subscription_destroy" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_add" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_create" },
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
      id: "scriptc.fixture.c-v1@0.0.0#counter_destroy",
      declaration: { module: nativePackage, name: "Counter.dispose" },
      entry: { kind: "c-symbol", symbol: "nts_counter_destroy" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_destroyed_count" },
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" }, projection: DIRECT_RESULT },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_value_or",
      declaration: { module: nativePackage, name: "counterValueOr" },
      entry: { kind: "c-symbol", symbol: "nts_counter_value_or" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_base_value_or" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_value" },
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
      entry: { kind: "c-symbol", symbol: "nts_counter_label" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
        projection: { kind: "utf8CString", nullable: true },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_required_label",
      declaration: { module: nativePackage, name: "Counter.requiredLabel" },
      entry: { kind: "c-symbol", symbol: "nts_counter_required_label" },
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: {
        type: { kind: "nativePointer", pointee: "i8", const: true, addressSpace: 0 },
        passMode: "pointer",
        ownership: { kind: "borrowed", scope: "receiver", anchor: "counter" },
        projection: { kind: "utf8CString", nullable: false },
      },
    },
    {
      id: "scriptc.fixture.c-v1@0.0.0#counter_verify",
      declaration: { module: nativePackage, name: "counterVerify" },
      entry: { kind: "c-symbol", symbol: "nts_counter_verify" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_isize_identity" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: ISIZE, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: ISIZE, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#exit",
        declaration: { module: "scriptc-native-test", name: "exit" },
        entry: { kind: "c-symbol", symbol: "exit" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "status", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#unused",
        declaration: { module: "scriptc-native-test", name: "unused" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_unlinked" },
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "scriptc-test@1#verify-exact-integers",
        declaration: { module: "scriptc-native-test", name: "verifyExactIntegers" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_exact_integers" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_padded" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_utf8_hash" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_bytes_hash" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_call_scoped" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_callback_errno" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_nullable_counter" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_callback_nullable_counter" },
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
        entry: {
          kind: "c-symbol",
          symbol: "scriptc_test_callbacks_configure_attached",
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
        entry: {
          kind: "c-symbol",
          symbol: "scriptc_test_callbacks_configure_attached_timer",
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
        entry: {
          kind: "c-symbol",
          symbol: "scriptc_test_callbacks_observe_attached",
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_retained" },
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

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
            entry: { kind: "c-symbol", symbol: "nts_ts_add_i32" },
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
        entry: { kind: "c-symbol", symbol: "nts_i32_identity" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const }, projection: DIRECT_RESULT },
      },
      {
        id: "process.exit",
        declaration: { module: "scriptc:test", name: "exit" },
        sourceAccess: "call",
        entry: { kind: "c-symbol", symbol: "exit" },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_pointer_sizes" },
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
    ...(sanitize ? ["-O1", "-fsanitize=address"] : ["-O2"]),
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

function retainedSupportObject(): string {
  return compileNativeObject(
    join(repoRoot, "tests/native-ir/native-retained-support.c"),
    "native-retained-support.o",
  );
}

test("Native IR validates and serializes an exact i32 call without a number carrier", () => {
  const mod = exactI32Module("-2147483648");
  expect(validateModule(mod)).toEqual([]);
  const json = serializeModule(mod);
  expect(json).toContain('"value": "-2147483648"');
  expect(deserializeModule(json)).toEqual(mod);
});

test("Native IR rejects a synchronously answered callback with no answer", () => {
  /* A void answer is the queued contract's business. Admitting it here would
   * give one delivery two spellings, and the choice between them would be
   * invisible at the call site. */
  const mod = exactI32Module();
  const binding = mod.nativeBindings![0]!;
  (binding as { arguments: unknown }).arguments = [{
    name: "callback",
    type: { kind: "func", params: [], ret: { kind: "void" } },
    callback: {
      owner: { kind: "result" },
      cancellationBinding: binding.id,
      allowedInvocationExecutors: ["same-as-caller"],
      synchronousReturn: true,
      transports: [],
      sourceArguments: [],
    },
  }];
  (binding as { parameters: unknown }).parameters = [{
    name: "callback",
    type: {
      kind: "nativeCallback",
      signature: {
        parameters: [CONTEXT],
        result: { kind: "void" },
            },
    },
    passMode: "pointer",
    ownership: { kind: "callback" },
    projection: { kind: "callbackFunction", argument: 0 },
  }];
  expect(validateModule(mod).map(({ message }) => message)).toContain(
    `Native IR binding "${binding.id}" argument "callback" has an invalid callback contract`,
  );
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
    `Native IR handle type "${COUNTER_ID}" has an invalid identity upcast to "${base.id}"`,
  );

  const incompatibleCollection = structuredClone(mod);
  const collectionBase = incompatibleCollection.nativeTypes![0]!;
  if (collectionBase.kind !== "handle") throw new Error("test fixture lost its handle type");
  collectionBase.cycleCollection = "traceable";
  expect(validateModule(incompatibleCollection).map(({ message }) => message)).toContain(
    `Native IR handle type "${COUNTER_ID}" has an invalid identity upcast to "${base.id}"`,
  );

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

test("Native IR rejects malformed borrowed UTF-8 C-string results", () => {
  const native = structuredClone(localNativeInput);
  const binding = native.bindings.find(
    (candidate) => candidate.id === "scriptc.fixture.c-v1@0.0.0#counter_label",
  );
  if (binding === undefined) throw new Error("test fixture lost its C-string-result binding");
  const mod = exactI32Module();
  mod.nativeTypes = native.types.map((definition) => structuredClone(definition));
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
  binding.parameters[1]!.projection = { kind: "bytesByteLength", argument: 0 };
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
              entry: {
                kind: "c-symbol",
                symbol: "nts_counter_create_with_initial_value",
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
              entry: { kind: "c-symbol", symbol: "nts_counter_create_static" },
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
          projection: { kind: "utf8CString", nullable: true },
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
          expect.objectContaining({ projection: { kind: "bytesByteLength", argument: 0 } }),
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

describe.each(["c", "llvm"] as const)("Native IR opaque handles, %s backend", (backend) => {
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
