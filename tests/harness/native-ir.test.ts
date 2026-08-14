/* Native IR is tested below the TypeScript frontend on purpose: this suite
 * proves the serialized compiler/backend contract independently of any
 * particular binding manifest or declaration package. Native TypeScript's
 * SCABI fixture can replace the tiny standalone C source through the two
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
import type { NativeFrontendInput } from "../../packages/compiler/src/frontend/native.js";
import { analyze, compile, compileLibrary } from "../../packages/compiler/src/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-native-ir-"));
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const loc: SrcLoc = { file: "native-ir.ts", start: 0, end: 0 };
const nativePackage = "@native-typescript/scabi-c-v1-fixture";
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
const NATIVE_F64 = nativeScalarType("f64");
const CALL_I32_CALLBACK = {
  callingConvention: "c",
  parameters: [I32],
  result: I32,
  context: { placement: "last" },
} as const;
const CALL_I32_SOURCE = nativeCallbackArgumentType(CALL_I32_CALLBACK);
const CALL_I32_CONTRACT = {
  lifetime: "call",
  registrationOwner: { kind: "native-call" },
  allowedInvocationExecutors: ["same-as-caller"],
  deliveryExecutor: "same-as-caller",
  synchronousReturn: true,
  transports: [{ kind: "borrow" }],
  reentrancy: "required",
  postDisposal: "not-invoked",
  shutdown: "drain",
} as const satisfies IrNativeCallbackContract;
const RETAINED_I32_CALLBACK = {
  callingConvention: "c",
  parameters: [I32],
  result: { kind: "void" },
  context: { placement: "last" },
} as const;
const RETAINED_I32_SOURCE = nativeCallbackArgumentType(RETAINED_I32_CALLBACK);
const RETAINED_I32_CONTRACT = {
  lifetime: "until-cancelled",
  registrationOwner: { kind: "result" },
  cancellationBinding:
    "native-typescript.fixture.c-v1@0.0.0#subscription_destroy",
  allowedInvocationExecutors: [
    "same-as-caller",
    "any-attached-thread",
  ],
  deliveryExecutor: "runtime-owner",
  synchronousReturn: false,
  transports: [{ kind: "copy" }],
  reentrancy: "allowed",
  postDisposal: "not-invoked",
  shutdown: "drain",
} as const satisfies IrNativeCallbackContract;
const PADDED_ID = "native-typescript.fixture.c-v1@0.0.0#type:padded";
const PADDED = { kind: "nativeStruct", typeId: PADDED_ID } as const;
const COUNTER_ID = "native-typescript.fixture.c-v1@0.0.0#type:counter";
const COUNTER = { kind: "nativeHandle", typeId: COUNTER_ID } as const;
const SUBSCRIPTION_ID =
  "native-typescript.fixture.c-v1@0.0.0#type:subscription";
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
  abi: { kind: "indirect", alignment: 8 },
  fields: [
    { name: "tag", type: U8, offset: 0 },
    { name: "value", type: U64, offset: 8 },
    { name: "ratio", type: NATIVE_F64, offset: 16 },
  ],
} as const satisfies NativeFrontendInput["types"][number];
const COUNTER_DEFINITION = {
  kind: "handle",
  id: COUNTER_ID,
  declaration: { module: nativePackage, name: "Counter" },
  nativeName: "NtsCounter",
  threadSafety: "confined",
  identity: "pointer",
} as const satisfies NativeFrontendInput["types"][number];
const SUBSCRIPTION_DEFINITION = {
  kind: "handle",
  id: SUBSCRIPTION_ID,
  declaration: { module: nativePackage, name: "Subscription" },
  nativeName: "NtsSubscription",
  threadSafety: "shared",
  identity: "pointer",
} as const satisfies NativeFrontendInput["types"][number];
const NATIVE_VOID = { kind: "void" } as const;
const NO_NATIVE_ERROR = { kind: "no-fail" } as const;

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
    { declaration: { module: nativePackage, name: "Counter" }, type: COUNTER },
    {
      declaration: { module: nativePackage, name: "Subscription" },
      type: SUBSCRIPTION,
    },
  ],
  types: [PADDED_DEFINITION, COUNTER_DEFINITION, SUBSCRIPTION_DEFINITION],
  exports: [],
  bindings: [
    ...exactIntegerBindings.map(({ scalar, declaration, symbol }) => {
      const type = nativeScalarType(scalar);
      return {
        id: `native-typescript.fixture.c-v1@0.0.0#${scalar}_identity`,
        declaration: { module: nativePackage, name: declaration },
        entry: { kind: "c-symbol" as const, symbol },
        callingConvention: "c" as const,
        variadic: false as const,
        sourceCall: { kind: "function" as const },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type, passMode: "value", ownership: { kind: "value" } }]),
        result: { type, passMode: "value" as const, ownership: { kind: "value" as const } },
      };
    }),
    {
      id: "native-typescript.fixture.c-v1@0.0.0#padded_roundtrip",
      declaration: { module: nativePackage, name: "paddedRoundtrip" },
      entry: { kind: "c-symbol", symbol: "nts_padded_roundtrip" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([{ name: "value", type: PADDED, passMode: "value", ownership: { kind: "value" } }]),
      result: { type: PADDED, passMode: "value", ownership: { kind: "value" as const } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#hash_utf8",
      declaration: { module: nativePackage, name: "hashUtf8" },
      entry: { kind: "c-symbol", symbol: "nts_hash_utf8" },
      callingConvention: "c",
      variadic: false,
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
      result: { type: U64, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#hash_bytes",
      declaration: { module: nativePackage, name: "hashBytes" },
      entry: { kind: "c-symbol", symbol: "nts_hash_bytes" },
      callingConvention: "c",
      variadic: false,
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
      result: { type: U64, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#call_scoped",
      declaration: { module: nativePackage, name: "callScoped" },
      entry: { kind: "c-symbol", symbol: "nts_call_scoped" },
      callingConvention: "c",
      variadic: false,
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
          ownership: { kind: "callback", lifetime: "call" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback", lifetime: "call" },
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
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#fail_errno",
      declaration: { module: nativePackage, name: "failErrno" },
      entry: { kind: "c-symbol", symbol: "nts_fail_errno" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "errno", failureValue: "-1" },
      ...directSignature([
        { name: "error_number", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#subscription_create",
      declaration: { module: nativePackage, name: "subscribe" },
      entry: { kind: "c-symbol", symbol: "nts_subscription_create" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: { kind: "nullable" },
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
          ownership: { kind: "callback", lifetime: "until-cancelled" },
          projection: { kind: "callbackFunction", argument: 0 },
        },
        {
          name: "context",
          type: { kind: "nativeContext", addressSpace: 0 },
          passMode: "pointer",
          ownership: { kind: "callback", lifetime: "until-cancelled" },
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
            "native-typescript.fixture.c-v1@0.0.0#subscription_destroy",
        },
      },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#subscription_destroy",
      declaration: { module: nativePackage, name: "Subscription.dispose" },
      entry: { kind: "c-symbol", symbol: "nts_subscription_destroy" },
      callingConvention: "c",
      variadic: false,
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
      },
    },
    ...(["emit", "emitForeign"] as const).map((method) => ({
      id:
        `native-typescript.fixture.c-v1@0.0.0#subscription_${method === "emit" ? "emit" : "emit_foreign"}`,
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
      error: { kind: "errno" as const, failureValue: "-1" },
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
      },
    })),
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_add",
      declaration: { module: nativePackage, name: "Counter.add" },
      entry: { kind: "c-symbol", symbol: "nts_counter_add" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
        { name: "delta", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_create",
      declaration: { module: nativePackage, name: "createCounter" },
      entry: { kind: "c-symbol", symbol: "nts_counter_create" },
      callingConvention: "c",
      variadic: false,
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
          destructor: "native-typescript.fixture.c-v1@0.0.0#counter_destroy",
        },
      },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_destroy",
      declaration: { module: nativePackage, name: "Counter.dispose" },
      entry: { kind: "c-symbol", symbol: "nts_counter_destroy" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "owned", transfer: "to-native" } },
      ]),
      result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_destroyed_count",
      declaration: { module: nativePackage, name: "counterDestroyedCount" },
      entry: { kind: "c-symbol", symbol: "nts_counter_destroyed_count" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_value",
      declaration: { module: nativePackage, name: "Counter.value" },
      entry: { kind: "c-symbol", symbol: "nts_counter_value" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "method", receiverArgument: 0 },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "counter", type: COUNTER, passMode: "pointer", ownership: { kind: "borrowed", scope: "call" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
    },
    {
      id: "native-typescript.fixture.c-v1@0.0.0#counter_verify",
      declaration: { module: nativePackage, name: "counterVerify" },
      entry: { kind: "c-symbol", symbol: "nts_counter_verify" },
      callingConvention: "c",
      variadic: false,
      sourceCall: { kind: "function" },
      error: NO_NATIVE_ERROR,
      ...directSignature([
        { name: "actual_value", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "actual_destroyed", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "expected_value", type: I32, passMode: "value", ownership: { kind: "value" } },
        { name: "expected_destroyed", type: I32, passMode: "value", ownership: { kind: "value" } },
      ]),
      result: { type: I32, passMode: "value", ownership: { kind: "value" } },
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
    types: translated.types,
    exports: translated.exports,
    bindings: [
      ...translated.bindings,
      {
        id: "scriptc-test@1#isize-identity",
        declaration: { module: "scriptc-native-test", name: "isizeIdentity" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_isize_identity" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: ISIZE, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: ISIZE, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "scriptc-test@1#exit",
        declaration: { module: "scriptc-native-test", name: "exit" },
        entry: { kind: "c-symbol", symbol: "exit" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "status", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "scriptc-test@1#unused",
        declaration: { module: "scriptc-native-test", name: "unused" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_unlinked" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "scriptc-test@1#verify-exact-integers",
        declaration: { module: "scriptc-native-test", name: "verifyExactIntegers" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_exact_integers" },
        callingConvention: "c",
        variadic: false,
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
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "scriptc-test@1#verify-padded",
        declaration: { module: "scriptc-native-test", name: "verifyPadded" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_padded" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "value", type: PADDED, passMode: "value", ownership: { kind: "value" as const } },
          { name: "tag", type: U8, passMode: "value", ownership: { kind: "value" as const } },
          { name: "scalarValue", type: U64, passMode: "value", ownership: { kind: "value" as const } },
          { name: "ratio", type: NATIVE_F64, passMode: "value", ownership: { kind: "value" as const } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "scriptc-test@1#verify-utf8-hash",
        declaration: { module: "scriptc-native-test", name: "verifyUtf8Hash" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_utf8_hash" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "actual", type: U64, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
      },
      {
        id: "scriptc-test@1#verify-bytes-hash",
        declaration: { module: "scriptc-native-test", name: "verifyBytesHash" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_bytes_hash" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "actual", type: U64, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
      },
      {
        id: "scriptc-test@1#verify-call-scoped",
        declaration: { module: "scriptc-native-test", name: "verifyCallScoped" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_call_scoped" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "forwarded", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "captured", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
      },
      {
        id: "scriptc-test@1#callback-errno",
        declaration: { module: "scriptc-native-test", name: "callbackErrno" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_callback_errno" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: { kind: "errno", failureValue: "-1" },
        arguments: [
          { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
          { name: "value", type: I32 },
        ],
        parameters: [
          {
            name: "callback",
            type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
            passMode: "pointer",
            ownership: { kind: "callback", lifetime: "call" },
            projection: { kind: "callbackFunction", argument: 0 },
          },
          {
            name: "context",
            type: { kind: "nativeContext", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "callback", lifetime: "call" },
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
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
      },
      {
        id: "scriptc-test@1#nullable-counter",
        declaration: { module: "scriptc-native-test", name: "createNullableCounter" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_nullable_counter" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: { kind: "nullable" },
        ...directSignature([
          { name: "succeed", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: {
          type: COUNTER,
          passMode: "pointer",
          ownership: {
            kind: "owned",
            transfer: "to-runtime",
            destructor: "native-typescript.fixture.c-v1@0.0.0#counter_destroy",
          },
        },
      },
      {
        id: "scriptc-test@1#callback-nullable-counter",
        declaration: { module: "scriptc-native-test", name: "callbackNullableCounter" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_callback_nullable_counter" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: { kind: "nullable" },
        arguments: [
          { name: "callback", type: CALL_I32_SOURCE, callback: CALL_I32_CONTRACT },
          { name: "succeed", type: I32 },
        ],
        parameters: [
          {
            name: "callback",
            type: { kind: "nativeCallback", signature: CALL_I32_CALLBACK },
            passMode: "pointer",
            ownership: { kind: "callback", lifetime: "call" },
            projection: { kind: "callbackFunction", argument: 0 },
          },
          {
            name: "context",
            type: { kind: "nativeContext", addressSpace: 0 },
            passMode: "pointer",
            ownership: { kind: "callback", lifetime: "call" },
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
            destructor: "native-typescript.fixture.c-v1@0.0.0#counter_destroy",
          },
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
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([]),
        result: {
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
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
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([]),
        result: {
          type: I32,
          passMode: "value",
          ownership: { kind: "value" },
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
        callingConvention: "c",
        variadic: false,
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
        },
      },
      {
        id: "scriptc-test@1#verify-retained",
        declaration: { module: "scriptc-native-test", name: "verifyRetained" },
        entry: { kind: "c-symbol", symbol: "scriptc_test_verify_retained" },
        callingConvention: "c",
        variadic: false,
        sourceCall: { kind: "function" },
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "total", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "activeBefore", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "activeAfter", type: I32, passMode: "value", ownership: { kind: "value" } },
          { name: "shutdown", type: I32, passMode: "value", ownership: { kind: "value" } },
        ]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
      },
    ],
  };
}

function nativeExternalTypes(): Record<string, string> {
  const declarations =
    process.env["SCRIPTC_NATIVE_IR_DECLARATIONS"] ??
    join(repoRoot, "tests/native-ir/package.d.ts");
  return {
    "@native-typescript/scabi-c-v1-fixture": declarations,
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
            id: "native-typescript.fixture.c-v1@0.0.0#ts_add_i32",
            sourceExport: "ntsTsAddI32",
            declaration: {
              module: nativePackage,
              name: "FixtureLibraryExports.ntsTsAddI32",
            },
            entry: { kind: "c-symbol", symbol: "nts_ts_add_i32" },
            callingConvention: "c",
            variadic: false,
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
          id: "native-typescript.fixture.c-v1@0.0.0#ts_add_i32",
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
        declaration: { module: "@native-typescript/scabi-c-v1-fixture", name: "i32Identity" },
        entry: { kind: "c-symbol", symbol: "nts_i32_identity" },
        callingConvention: "c",
        variadic: false,
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "value", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: I32, passMode: "value", ownership: { kind: "value" as const } },
      },
      {
        id: "process.exit",
        declaration: { module: "scriptc:test", name: "exit" },
        entry: { kind: "c-symbol", symbol: "exit" },
        callingConvention: "c",
        variadic: false,
        error: NO_NATIVE_ERROR,
        ...directSignature([{ name: "status", type: I32, passMode: "value", ownership: { kind: "value" } }]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const } },
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
        entry: { kind: "c-symbol", symbol: "scriptc_test_pointer_sizes" },
        callingConvention: "c",
        variadic: false,
        error: NO_NATIVE_ERROR,
        ...directSignature([
          { name: "signedSize", type: ISIZE, passMode: "value", ownership: { kind: "value" as const } },
          { name: "unsignedSize", type: USIZE, passMode: "value", ownership: { kind: "value" as const } },
        ]),
        result: { type: NATIVE_VOID, passMode: "value", ownership: { kind: "value" as const } },
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

test("Native IR requires explicit, range-checked error contracts", () => {
  const missing = exactI32Module();
  delete (missing.nativeBindings![0]! as unknown as { error?: unknown }).error;
  expect(validateModule(missing).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" has no valid error contract',
  );

  const outOfRange = exactI32Module();
  outOfRange.nativeBindings![0]!.error = {
    kind: "errno",
    failureValue: "2147483648",
  };
  expect(validateModule(outOfRange).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" has an invalid errno failure contract',
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
    'duplicate Native IR declaration "@native-typescript/scabi-c-v1-fixture"::"i32Identity"',
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
    "in __main: Native IR call process.exit type native:i32 != result void",
  );
});

test("Native IR rejects malformed or ambiguous UTF-8 projections", () => {
  expect(validateModule(borrowedUtf8Module())).toEqual([]);

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
      ownership: { kind: "callback", lifetime: "call" },
      projection: { kind: "callbackContext", argument: 0 },
    },
  ];
  expect(validateModule(mod).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "callback" has invalid ownership',
  );

  const missingContext = structuredClone(mod);
  missingContext.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback", lifetime: "call" };
  missingContext.nativeBindings![0]!.parameters.pop();
  expect(validateModule(missingContext).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" argument "callback" has an incomplete or ambiguous ABI projection',
  );

  const wrongSignature = structuredClone(mod);
  wrongSignature.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback", lifetime: "call" };
  const callbackType = wrongSignature.nativeBindings![0]!.parameters[0]!.type;
  if (callbackType.kind !== "nativeCallback") throw new Error("test fixture lost its callback type");
  callbackType.signature.result = U32;
  expect(validateModule(wrongSignature).map((error) => error.message)).toContain(
    'Native IR binding "fixture.i32_identity" parameter "callback" has an invalid callback-function projection',
  );

  const missingSignature = structuredClone(mod);
  missingSignature.nativeBindings![0]!.parameters[0]!.ownership = { kind: "callback", lifetime: "call" };
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
      abi: { kind: "indirect", alignment: 16 },
      fields: PADDED_DEFINITION.fields.map((field) => ({ ...field, type: { ...field.type } })),
    },
  ];
  expect(validateModule(invalidLayout).map((error) => error.message)).toContain(
    `Native IR type "${PADDED_ID}" has unsupported value or ABI metadata`,
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
  test("round-trips the SCABI identity result as the observable process status", async () => {
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
      "native-typescript.fixture.c-v1@0.0.0#i16_identity",
      "native-typescript.fixture.c-v1@0.0.0#i32_identity",
      "native-typescript.fixture.c-v1@0.0.0#i64_identity",
      "native-typescript.fixture.c-v1@0.0.0#i8_identity",
      "native-typescript.fixture.c-v1@0.0.0#u16_identity",
      "native-typescript.fixture.c-v1@0.0.0#u32_identity",
      "native-typescript.fixture.c-v1@0.0.0#u64_identity",
      "native-typescript.fixture.c-v1@0.0.0#u8_identity",
      "native-typescript.fixture.c-v1@0.0.0#usize_identity",
      "scriptc-test@1#exit",
      "scriptc-test@1#isize-identity",
      "scriptc-test@1#verify-exact-integers",
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

  test("wraps every exact integer width without signed overflow", async () => {
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
        "scr_native_u8_mul",
        "scr_native_i16_mul",
        "scr_native_u16_sub",
        "scr_native_i32_add",
        "scr_native_i32_sub",
        "scr_native_i32_mul",
        "scr_native_u32_mul",
        "scr_native_i64_mul",
        "scr_native_u64_sub",
        "scr_native_isize_mul",
        "scr_native_usize_sub",
      ]) {
        expect(generated).toContain(helper);
      }
    } else {
      expect(generated).toMatch(/= add i8/);
      expect(generated).toMatch(/= mul i8/);
      expect(generated).toMatch(/= mul i16/);
      expect(generated).toMatch(/= sub i16/);
      expect(generated).toMatch(/= add i32/);
      expect(generated).toMatch(/= sub i32/);
      expect(generated).toMatch(/= mul i32/);
      expect(generated).toMatch(/= mul i64/);
      expect(generated).toMatch(/= sub i64/);
    }
    const run = spawnSync(result.binaryPath);
    expect({ status: run.status, signal: run.signal, stderr: run.stderr.toString() }).toEqual({
      status: 42,
      signal: null,
      stderr: "",
    });
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
        abi: { kind: "indirect", alignment: 8 },
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
        id: "native-typescript.fixture.c-v1@0.0.0#hash_utf8",
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
        id: "native-typescript.fixture.c-v1@0.0.0#hash_bytes",
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
        id: "native-typescript.fixture.c-v1@0.0.0#call_scoped",
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
          id: "native-typescript.fixture.c-v1@0.0.0#subscription_create",
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
        id: "native-typescript.fixture.c-v1@0.0.0#fail_errno",
        error: { kind: "errno", failureValue: "-1" },
        result: { type: I32, passMode: "value", ownership: { kind: "value" } },
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
        id: "native-typescript.fixture.c-v1@0.0.0#type:counter",
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
