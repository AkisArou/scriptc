import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrModule,
  IrNativeBinding,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import {
  machineIntegerFieldKey,
  machineIntegerFacts,
  machineIntegerMethodKey,
  type MachineIntegerFacts,
} from "../../ir/number-facts.js";
import { deserializeModule } from "../../ir/serialize.js";
import { validateModule } from "../../ir/validate.js";

/**
 * A valid ScriptC program surface the experimental JVM emitter does not yet
 * cover. This is a backend-tier refusal, not a source-language diagnostic:
 * the C and LLVM backends may still compile the same checked IR.
 */
export class JvmUnsupportedError extends Error {
  readonly surface: string;
  readonly loc: SrcLoc;

  constructor(surface: string, loc: SrcLoc) {
    super(`JVM backend does not support ${surface}`);
    this.name = "JvmUnsupportedError";
    this.surface = surface;
    this.loc = loc;
  }
}

export interface JvmEmissionOptions {
  /** Simple Java class name. Package qualification is supplied separately. */
  readonly className: string;
  readonly packageName?: string;
  /** Exact target coordinates joined to Native IR binding ids by the JVM
   * binding generator. This is target evidence, not a naming convention. */
  readonly nativeBindings?: readonly JvmDirectBinding[];
  /** Public Java wrappers a platform-owned harness may call after module
   * initialization. The IR function remains the semantic implementation. */
  readonly functionExports?: readonly {
    readonly functionName: string;
    readonly methodName: string;
  }[];
}

export type JvmDirectBinding =
  | {
      readonly id: string;
      readonly kind: "constructor";
      readonly ownerBinaryName: string;
      readonly name: "<init>";
      readonly descriptor: string;
      readonly nativeEntrySymbol: string;
    }
  | {
      readonly id: string;
      readonly kind: "static-method" | "instance-method";
      readonly ownerBinaryName: string;
      readonly name: string;
      readonly descriptor: string;
      readonly nativeEntrySymbol: string;
    }
  | {
      readonly id: string;
      readonly kind: "instance-callback";
      readonly ownerBinaryName: string;
      readonly name: string;
      readonly descriptor: string;
      readonly nativeEntrySymbol: string;
      readonly interfaceBinaryName: string;
      readonly cancellation: {
        readonly bindingId: string;
        readonly nativeEntrySymbol: string;
      };
    }
  | {
      readonly id: string;
      readonly kind: "class-callback";
      readonly ownerBinaryName: string;
      readonly sourceClassName: string;
      readonly superclassBinaryName: string;
      readonly interfaceBinaryNames: readonly string[];
      readonly name: string;
      readonly descriptor: string;
      readonly nativeEntrySymbol: string;
      readonly baseCall: {
        readonly bindingId: string;
        readonly name: string;
        readonly descriptor: string;
      } | null;
      readonly terminal: boolean;
    };

type JvmDirectCallbackBinding = Extract<
  JvmDirectBinding,
  { readonly kind: "instance-callback" }
>;

type JvmDirectClassCallbackBinding = Extract<
  JvmDirectBinding,
  { readonly kind: "class-callback" }
>;

interface JvmDirectCallbackPlan {
  readonly binding: JvmDirectCallbackBinding;
  readonly adapterName: string;
  readonly descriptor: JvmMethodDescriptor;
}

interface JvmDirectCallbackCapturePlan {
  readonly fieldName: string;
  readonly javaType: string;
  readonly argument: string;
  readonly clearOnCancel: boolean;
}

interface JvmDirectCallbackSitePlan {
  readonly callback: JvmDirectCallbackPlan;
  readonly index: number;
  readonly registerName: string;
  readonly handlerName: string;
  readonly captures: readonly JvmDirectCallbackCapturePlan[];
}

interface JvmDirectClassCallbackPlan {
  readonly binding: JvmDirectClassCallbackBinding;
  readonly descriptor: JvmMethodDescriptor;
}

interface JvmDirectClassCallbackSitePlan {
  readonly callback: JvmDirectClassCallbackPlan;
  readonly index: number;
  readonly handlerName: string;
}

interface JvmNullableReference {
  readonly unionId: string;
  readonly valueTag: number;
  readonly unitTag: number;
  readonly unitKind: "nullT" | "undefinedT";
  readonly valueType: IrType;
}

function assertJavaIdentifier(value: string, role: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) {
    throw new Error(`Invalid JVM ${role} '${value}'`);
  }
}

function validateOptions(options: JvmEmissionOptions): void {
  assertJavaIdentifier(options.className, "class name");
  if (options.packageName !== undefined && options.packageName.length > 0) {
    for (const segment of options.packageName.split(".")) {
      assertJavaIdentifier(segment, "package segment");
    }
  }
  const exportedNames = new Set<string>();
  for (const exported of options.functionExports ?? []) {
    assertJavaIdentifier(exported.methodName, "exported method name");
    if (exportedNames.has(exported.methodName)) {
      throw new Error(`Duplicate JVM exported method '${exported.methodName}'`);
    }
    exportedNames.add(exported.methodName);
  }
}

/** Collision-free Java identifier over the UTF-8 spelling of an IR id. */
function encodedIdentifier(
  prefix: "c" | "d" | "f" | "g" | "l" | "m" | "n" | "r",
  value: string,
): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = `${prefix}_`;
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

function javaString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x08: out += "\\b"; break;
      case 0x09: out += "\\t"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0d: out += "\\r"; break;
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      default:
        out += code >= 0x20 && code <= 0x7e
          ? String.fromCharCode(code)
          : `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return `${out}"`;
}

function isJvmByteArray(type: IrType): boolean {
  return type.kind === "bytes" && type.elem === "u8";
}

function scalarJavaType(type: IrType, loc: SrcLoc): string {
  switch (type.kind) {
    case "void": return "void";
    case "f64": return "double";
    case "bool": return "boolean";
    case "string": return "String";
    case "nativeScalar":
      if (type.scalar === "i64") return "long";
      throw new JvmUnsupportedError(`native scalar '${type.scalar}'`, loc);
    case "bytes":
      if (type.elem === "u8") return "byte[]";
      throw new JvmUnsupportedError(`bytes element '${type.elem}'`, loc);
    default: throw new JvmUnsupportedError(`type '${type.kind}'`, loc);
  }
}

function numberLiteral(value: number): string {
  if (Number.isNaN(value)) return "Double.NaN";
  if (value === Infinity) return "Double.POSITIVE_INFINITY";
  if (value === -Infinity) return "Double.NEGATIVE_INFINITY";
  if (Object.is(value, -0)) return "-0.0d";
  return `${String(value)}d`;
}

function irContains(
  value: unknown,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean,
): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => irContains(entry, predicate));
  }
  if (value === null || typeof value !== "object") return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (predicate(record)) return true;
  return Object.values(record).some((entry) => irContains(entry, predicate));
}

function irStringIntrinsics(value: unknown, methods = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const entry of value) irStringIntrinsics(entry, methods);
    return methods;
  }
  if (value === null || typeof value !== "object") return methods;
  const record = value as Readonly<Record<string, unknown>>;
  if (record["kind"] === "strIntrinsic" && typeof record["method"] === "string") {
    methods.add(record["method"]);
  }
  for (const entry of Object.values(record)) irStringIntrinsics(entry, methods);
  return methods;
}

interface JvmMethodDescriptor {
  readonly parameters: readonly string[];
  readonly result: string;
}

interface JvmArrayPlan {
  readonly type: Extract<IrType, { readonly kind: "array" }>;
  readonly className: string;
}

interface JvmFunctionPlan {
  readonly type: Extract<IrType, { readonly kind: "func" }>;
  readonly interfaceName: string;
}

interface JvmFunctionValuePlan {
  readonly fnName: string;
  readonly type: Extract<IrType, { readonly kind: "func" }>;
  readonly fieldName: string;
}

interface JvmRecordPlan {
  readonly shape: IrRecordShape;
  readonly className: string;
}

interface JvmRecordLiteralPlan {
  readonly expression: Extract<IrExpr, { readonly kind: "recordLit" }>;
  readonly factoryName: string;
}

interface JvmUnionPlan {
  readonly definition: IrUnionDef;
  readonly className: string;
}

function irRecordTypes(
  shapes: readonly IrRecordShape[],
): ReadonlyMap<string, JvmRecordPlan> {
  return new Map(
    [...shapes]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((shape, index) => [shape.id, Object.freeze({
        shape,
        className: `NtsRecord${index}`,
      })]),
  );
}

function irRecordLiterals(
  value: unknown,
): ReadonlyMap<Extract<IrExpr, { readonly kind: "recordLit" }>, JvmRecordLiteralPlan> {
  const expressions: Extract<IrExpr, { readonly kind: "recordLit" }>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Readonly<Record<string, unknown>>;
    if (record["kind"] === "recordLit") {
      expressions.push(candidate as Extract<IrExpr, { readonly kind: "recordLit" }>);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return new Map(expressions.map((expression, index) => [expression, Object.freeze({
    expression,
    factoryName: `ntsRecordLiteral${index}`,
  })]));
}

function irUnionTypes(
  definitions: readonly IrUnionDef[],
): ReadonlyMap<string, JvmUnionPlan> {
  return new Map(
    [...definitions]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((definition, index) => [definition.id, Object.freeze({
        definition,
        className: `NtsUnion${index}`,
      })]),
  );
}

function irArrayTypes(value: unknown): ReadonlyMap<string, JvmArrayPlan> {
  const types = new Map<string, Extract<IrType, { readonly kind: "array" }>>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Readonly<Record<string, unknown>>;
    if (
      record["kind"] === "array" &&
      record["elem"] !== null &&
      typeof record["elem"] === "object" &&
      typeof (record["elem"] as Readonly<Record<string, unknown>>)["kind"] === "string"
    ) {
      const type = candidate as Extract<IrType, { readonly kind: "array" }>;
      types.set(typeKey(type), type);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return new Map(
    [...types.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, type], index) => [key, Object.freeze({
        type,
        className: `NtsArray${index}`,
      })]),
  );
}

function irFunctionTypes(value: unknown): ReadonlyMap<string, JvmFunctionPlan> {
  const types = new Map<string, Extract<IrType, { readonly kind: "func" }>>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Readonly<Record<string, unknown>>;
    if (
      record["kind"] === "func" &&
      Array.isArray(record["params"]) &&
      record["ret"] !== null &&
      typeof record["ret"] === "object"
    ) {
      const type = candidate as Extract<IrType, { readonly kind: "func" }>;
      types.set(typeKey(type), type);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return new Map(
    [...types.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, type], index) => [key, Object.freeze({
        type,
        interfaceName: `NtsFunction${index}`,
      })]),
  );
}

function irFunctionValues(
  value: unknown,
  functions: ReadonlyMap<string, IrFunction>,
): ReadonlyMap<string, JvmFunctionValuePlan> {
  const values = new Map<string, Extract<IrType, { readonly kind: "func" }>>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Readonly<Record<string, unknown>>;
    if (
      record["kind"] === "closure" &&
      typeof record["fnName"] === "string" &&
      record["type"] !== null &&
      typeof record["type"] === "object" &&
      (record["type"] as Readonly<Record<string, unknown>>)["kind"] === "func" &&
      functions.get(record["fnName"])?.captures === undefined
    ) {
      values.set(
        record["fnName"],
        record["type"] as Extract<IrType, { readonly kind: "func" }>,
      );
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return new Map(
    [...values.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([fnName, type], index) => [fnName, Object.freeze({
        fnName,
        type,
        fieldName: `ntsFunctionValue${index}`,
      })]),
  );
}

function parseJvmMethodDescriptor(descriptor: string): JvmMethodDescriptor {
  let cursor = 0;
  function type(allowVoid: boolean): string {
    const start = cursor;
    while (descriptor[cursor] === "[") cursor++;
    const head = descriptor[cursor++];
    if (head === undefined) throw new Error(`Malformed JVM descriptor '${descriptor}'`);
    if (head === "L") {
      const end = descriptor.indexOf(";", cursor);
      if (end < 0 || end === cursor) {
        throw new Error(`Malformed JVM descriptor '${descriptor}'`);
      }
      cursor = end + 1;
    } else if (!"ZBCSIJFD".includes(head) && !(allowVoid && head === "V")) {
      throw new Error(`Malformed JVM descriptor '${descriptor}'`);
    }
    return descriptor.slice(start, cursor);
  }
  if (descriptor[cursor++] !== "(") {
    throw new Error(`Malformed JVM method descriptor '${descriptor}'`);
  }
  const parameters: string[] = [];
  while (descriptor[cursor] !== ")") {
    if (cursor >= descriptor.length) {
      throw new Error(`Malformed JVM method descriptor '${descriptor}'`);
    }
    parameters.push(type(false));
  }
  cursor++;
  const result = type(true);
  if (cursor !== descriptor.length) {
    throw new Error(`Malformed JVM descriptor '${descriptor}'`);
  }
  return { parameters, result };
}

function javaOwner(binaryName: string): string {
  if (
    binaryName.length === 0 ||
    binaryName.split("/").some((segment) =>
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)
    )
  ) {
    throw new Error(`JVM direct binding has non-Java owner '${binaryName}'`);
  }
  return binaryName.replaceAll("/", ".");
}

const descriptorJavaTypes: Readonly<Record<string, string>> = Object.freeze({
  Z: "boolean",
  B: "byte",
  C: "char",
  S: "short",
  I: "int",
  J: "long",
  F: "float",
  D: "double",
  V: "void",
});

/** A descriptor carries a binary nested-class name (`Outer$Inner`), while
 * Java source names the same declaration `Outer.Inner`. */
function javaDescriptorType(descriptor: string): string {
  let dimensions = 0;
  while (descriptor[dimensions] === "[") dimensions++;
  const value = descriptor.slice(dimensions);
  const base = value.startsWith("L") && value.endsWith(";")
    ? value.slice(1, -1).replace(/[/$]/gu, ".")
    : descriptorJavaTypes[value];
  if (base === undefined || (base === "void" && dimensions !== 0)) {
    throw new Error(`Malformed JVM field descriptor '${descriptor}'`);
  }
  return `${base}${"[]".repeat(dimensions)}`;
}

class JavaEmitter {
  readonly #module: IrModule;
  readonly #options: JvmEmissionOptions;
  readonly #functions: ReadonlyMap<string, IrFunction>;
  readonly #classes: ReadonlyMap<string, IrClassDef>;
  readonly #nativeTypes: ReadonlyMap<string, NonNullable<IrModule["nativeTypes"]>[number]>;
  readonly #irNativeBindings: ReadonlyMap<string, IrNativeBinding>;
  readonly #jvmNativeBindings: ReadonlyMap<string, JvmDirectBinding>;
  readonly #directCallbacks: readonly JvmDirectCallbackPlan[];
  readonly #directClassCallbacks: readonly JvmDirectClassCallbackPlan[];
  readonly #directCallbackByOwner: ReadonlyMap<string, JvmDirectCallbackPlan>;
  readonly #directCancellationBindings: ReadonlyMap<string, {
    readonly nativeEntrySymbol: string;
    readonly connectionTypeId: string;
  }>;
  readonly #directConnectionTypeIds: ReadonlySet<string>;
  readonly #machineIntegers: MachineIntegerFacts;
  readonly #needsI64ToNumber: boolean;
  readonly #needsNumberToString: boolean;
  readonly #needsUint8ArrayLength: boolean;
  readonly #needsUint8SetHelper: boolean;
  readonly #stringIntrinsics: ReadonlySet<string>;
  readonly #arrayTypes: ReadonlyMap<string, JvmArrayPlan>;
  readonly #functionTypes: ReadonlyMap<string, JvmFunctionPlan>;
  readonly #functionValues: ReadonlyMap<string, JvmFunctionValuePlan>;
  readonly #recordTypes: ReadonlyMap<string, JvmRecordPlan>;
  readonly #unionTypes: ReadonlyMap<string, JvmUnionPlan>;
  readonly #recordLiterals: ReadonlyMap<
    Extract<IrExpr, { readonly kind: "recordLit" }>,
    JvmRecordLiteralPlan
  >;
  readonly #directCallbackSites: JvmDirectCallbackSitePlan[] = [];
  readonly #directClassCallbackSites: JvmDirectClassCallbackSitePlan[] = [];
  #integerLocals: ReadonlySet<string> = new Set();
  #mutableBoxedLocals: ReadonlySet<string> = new Set();
  #currentFunction: IrFunction | null = null;

  constructor(module: IrModule, options: JvmEmissionOptions) {
    this.#module = module;
    this.#options = options;
    this.#functions = new Map(module.functions.map((fn) => [fn.name, fn]));
    this.#classes = new Map(
      (module.classes ?? [])
        .filter((class_) => class_.runtime !== true)
        .map((class_) => [class_.name, class_]),
    );
    this.#nativeTypes = new Map(
      (module.nativeTypes ?? []).map((type) => [type.id, type]),
    );
    this.#irNativeBindings = new Map(
      (module.nativeBindings ?? []).map((binding) => [binding.id, binding]),
    );
    this.#jvmNativeBindings = new Map(
      (options.nativeBindings ?? []).map((binding) => [binding.id, binding]),
    );
    this.#directCallbacks = Object.freeze(
      (options.nativeBindings ?? [])
        .filter((binding): binding is JvmDirectCallbackBinding =>
          binding.kind === "instance-callback"
        )
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map((binding, index) => Object.freeze({
          binding,
          adapterName: `NtsCallbackAdapter${index}`,
          descriptor: parseJvmMethodDescriptor(binding.descriptor),
        })),
    );
    this.#directClassCallbacks = Object.freeze(
      (options.nativeBindings ?? [])
        .filter((binding): binding is JvmDirectClassCallbackBinding =>
          binding.kind === "class-callback" &&
          this.#irNativeBindings.has(binding.id)
        )
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map((binding) => Object.freeze({
          binding,
          descriptor: parseJvmMethodDescriptor(binding.descriptor),
        })),
    );
    const directSubclass = this.#directClassCallbacks[0]?.binding;
    if (directSubclass !== undefined) {
      const emittedBinaryName =
        (options.packageName === undefined || options.packageName.length === 0
          ? ""
          : `${options.packageName.replaceAll(".", "/")}/`) +
        options.className;
      if (directSubclass.ownerBinaryName !== emittedBinaryName) {
        throw new Error(
          `JVM direct subclass '${directSubclass.ownerBinaryName}' must be emitted ` +
            `as '${emittedBinaryName}', not as an unrelated wrapper class`,
        );
      }
      for (const callback of this.#directClassCallbacks.slice(1)) {
        const candidate = callback.binding;
        if (
          candidate.ownerBinaryName !== directSubclass.ownerBinaryName ||
          candidate.sourceClassName !== directSubclass.sourceClassName ||
          candidate.superclassBinaryName !== directSubclass.superclassBinaryName ||
          candidate.interfaceBinaryNames.length !==
            directSubclass.interfaceBinaryNames.length ||
          candidate.interfaceBinaryNames.some(
            (name, index) => name !== directSubclass.interfaceBinaryNames[index],
          )
        ) {
          throw new Error(
            "One JVM Java source can replace exactly one generated native subclass",
          );
        }
      }
    }
    const callbackByOwner = new Map<string, JvmDirectCallbackPlan>();
    const cancellationBindings = new Map<string, {
      readonly nativeEntrySymbol: string;
      readonly connectionTypeId: string;
    }>();
    const connectionTypeIds = new Set<string>();
    for (const callback of this.#directCallbacks) {
      if (callbackByOwner.has(callback.binding.ownerBinaryName)) {
        throw new Error(
          `JVM direct callback owner '${callback.binding.ownerBinaryName}' ` +
            "carries more than one substitutable callback",
        );
      }
      callbackByOwner.set(callback.binding.ownerBinaryName, callback);
      const semantic = this.#irNativeBindings.get(callback.binding.id);
      if (semantic === undefined) {
        /* The full sidecar may contain unreachable entries. Only entries in
         * this translated Native IR need a representation. */
        continue;
      }
      if (semantic.result.type.kind !== "nativeHandle") {
        throw new Error(
          `JVM direct callback '${callback.binding.id}' does not return a connection handle`,
        );
      }
      const connectionTypeId = semantic.result.type.typeId;
      connectionTypeIds.add(connectionTypeId);
      const prior = cancellationBindings.get(callback.binding.cancellation.bindingId);
      if (
        prior !== undefined &&
        (prior.connectionTypeId !== connectionTypeId ||
          prior.nativeEntrySymbol !== callback.binding.cancellation.nativeEntrySymbol)
      ) {
        throw new Error(
          `JVM direct cancellation '${callback.binding.cancellation.bindingId}' ` +
            "has conflicting callback coordinates",
        );
      }
      cancellationBindings.set(callback.binding.cancellation.bindingId, {
        nativeEntrySymbol: callback.binding.cancellation.nativeEntrySymbol,
        connectionTypeId,
      });
    }
    this.#directCallbackByOwner = callbackByOwner;
    this.#directCancellationBindings = cancellationBindings;
    this.#directConnectionTypeIds = connectionTypeIds;
    this.#machineIntegers = machineIntegerFacts(module);
    this.#needsI64ToNumber = irContains(
      module.functions,
      (record) => record["kind"] === "nativeScalarToNumber",
    );
    this.#needsUint8ArrayLength = irContains(
      module.functions,
      (record) => {
        if (record["kind"] !== "bytesNew") return false;
        const source = record["source"] as
          | Readonly<Record<string, unknown>>
          | null
          | undefined;
        const type = source?.["type"] as
          | Readonly<Record<string, unknown>>
          | undefined;
        return type?.["kind"] === "f64";
      },
    );
    this.#needsUint8SetHelper = irContains(
      module.functions,
      (record) => record["kind"] === "bytesSet",
    );
    this.#stringIntrinsics = irStringIntrinsics(module.functions);
    /* Scan only the language program. Native ABI metadata also has a
     * `kind: "func"` callback shape, but its parameters are physical ABI
     * types rather than IrType values and must never enter the JavaScript
     * function-value representation. */
    const programTypes = [
      module.functions,
      module.classes,
      module.globals,
      module.unions,
    ];
    this.#arrayTypes = irArrayTypes(programTypes);
    this.#functionTypes = irFunctionTypes(programTypes);
    this.#functionValues = irFunctionValues(module.functions, this.#functions);
    this.#recordTypes = irRecordTypes(module.records ?? []);
    this.#recordLiterals = irRecordLiterals(module.functions);
    this.#unionTypes = irUnionTypes(module.unions ?? []);
    this.#needsNumberToString = irContains(
      module.functions,
      (record) => {
        if (record["kind"] === "bytesNew") {
          const source = record["source"] as
            | Readonly<Record<string, unknown>>
            | null
            | undefined;
          const type = source?.["type"] as
            | Readonly<Record<string, unknown>>
            | undefined;
          return type?.["kind"] === "f64";
        }
        if (record["kind"] !== "toString") return false;
        const operand = record["operand"] as
          | Readonly<Record<string, unknown>>
          | undefined;
        const type = operand?.["type"] as
          | Readonly<Record<string, unknown>>
          | undefined;
        return type?.["kind"] === "f64";
      },
    );
    if (this.#jvmNativeBindings.size !== (options.nativeBindings?.length ?? 0)) {
      throw new Error("JVM emission received duplicate direct binding ids");
    }
  }

  emit(): string {
    const entry = this.#functions.get(this.#module.entry);
    if (entry === undefined) {
      throw new Error(`JVM emission found no entry function '${this.#module.entry}'`);
    }
    if (entry.params.length !== 0 || entry.returnType.kind !== "void") {
      throw new JvmUnsupportedError("a parameterized or value-returning module entry", entry.loc);
    }

    const lines: string[] = [];
    if (this.#options.packageName !== undefined && this.#options.packageName.length > 0) {
      lines.push(`package ${this.#options.packageName};`, "");
    }
    const directSubclass = this.#directClassCallbacks[0]?.binding;
    const inheritance = directSubclass === undefined
      ? ""
      : ` extends ${javaOwner(directSubclass.superclassBinaryName)}${
          directSubclass.interfaceBinaryNames.length === 0
            ? ""
            : ` implements ${directSubclass.interfaceBinaryNames.map(javaOwner).join(", ")}`
        }`;
    lines.push(`public final class ${this.#options.className}${inheritance} {`);
    lines.push(
      "  private static long ntsToUint32(double value) {",
      "    if (!Double.isFinite(value) || value == 0.0d) return 0L;",
      "    double whole = value < 0.0d ? Math.ceil(value) : Math.floor(value);",
      "    double modulo = whole % 4294967296.0d;",
      "    if (modulo < 0.0d) modulo += 4294967296.0d;",
      "    return (long)modulo;",
      "  }",
      "",
      "  private static int ntsToInt32(double value) {",
      "    return (int)ntsToUint32(value);",
      "  }",
      "",
      "  private static boolean ntsToBool(double value) {",
      "    return value != 0.0d && !Double.isNaN(value);",
      "  }",
      "",
    );

    if (this.#needsI64ToNumber) {
      lines.push(
        "  private static double ntsI64ToNumber(long value) {",
        "    if (value == Long.MIN_VALUE) return -9223372036854775808.0d;",
        "    long magnitude = Math.abs(value);",
        "    int discardedBits = (64 - Long.numberOfLeadingZeros(magnitude)) - 53;",
        "    if (discardedBits <= 0 ||",
        "        (magnitude & ((1L << discardedBits) - 1L)) == 0L) {",
        "      return (double)value;",
        "    }",
        "    throw new NtsRangeError(\"i64 value is not exactly representable as a number\");",
        "  }",
        "",
      );
    }
    if (this.#needsUint8ArrayLength) {
      lines.push(
        "  private static int ntsUint8ArrayLength(double value) {",
        "    if (Double.isNaN(value) || value == 0.0d) return 0;",
        "    if (!Double.isFinite(value)) {",
        "      throw new NtsRangeError(\"Invalid typed array length: \" + ntsNumberToString(value));",
        "    }",
        "    double whole = value < 0.0d ? Math.ceil(value) : Math.floor(value);",
        "    if (whole < 0.0d || whole > Integer.MAX_VALUE) {",
        "      throw new NtsRangeError(\"Invalid typed array length: \" + ntsNumberToString(value));",
        "    }",
        "    return (int)whole;",
        "  }",
        "",
      );
    }
    if (this.#needsUint8SetHelper) {
      lines.push(
        "  private static int ntsUint8Index(double value, int length) {",
        "    if (!Double.isFinite(value) || value != Math.rint(value) ||",
        "        value < 0.0d || value >= length) {",
        "      throw new NtsTrapError(\"Uint8Array index out of bounds\");",
        "    }",
        "    return (int)value;",
        "  }",
        "",
        "  private static void ntsSetUint8(byte[] array, double index, double value) {",
        "    array[ntsUint8Index(index, array.length)] = (byte)ntsToUint32(value);",
        "  }",
        "",
      );
    }
    if (this.#needsNumberToString) {
      lines.push(
        "  private static String ntsNumberToString(double value) {",
        "    if (Double.isNaN(value)) return \"NaN\";",
        "    if (value == 0.0d) return \"0\";",
        "    if (value == Double.POSITIVE_INFINITY) return \"Infinity\";",
        "    if (value == Double.NEGATIVE_INFINITY) return \"-Infinity\";",
        "    double magnitude = Math.abs(value);",
        "    java.math.BigDecimal decimal = java.math.BigDecimal.valueOf(value).stripTrailingZeros();",
        "    if (magnitude >= 0.000001d && magnitude < 1.0e21d) {",
        "      return decimal.toPlainString();",
        "    }",
        "    String scientific = decimal.toString().replace('E', 'e');",
        "    int exponent = scientific.indexOf('e');",
        "    if (exponent >= 0 && scientific.charAt(exponent + 1) != '-' &&",
        "        scientific.charAt(exponent + 1) != '+') {",
        "      scientific = scientific.substring(0, exponent + 1) + \"+\" +",
        "        scientific.substring(exponent + 1);",
        "    }",
        "    return scientific;",
        "  }",
        "",
      );
    }

    lines.push(...this.#emitStringIntrinsicSupport());

    lines.push(...this.#emitArraySupport());

    lines.push(...this.#emitFunctionSupport());

    lines.push(...this.#emitRecordSupport());

    lines.push(...this.#emitUnionSupport());

    lines.push(...this.#emitBoxSupport());

    lines.push(...this.#emitManagedClassSupport());

    for (const global of this.#module.globals ?? []) {
      const integer = this.#machineIntegers.globals.has(global.id);
      lines.push(
        `  private static ${integer ? "int" : this.#javaType(global.type, entry.loc)} ${encodedIdentifier("g", global.id)};`,
      );
    }
    if ((this.#module.globals?.length ?? 0) > 0) lines.push("");

    for (const fn of this.#module.functions) {
      lines.push(...this.#emitFunction(fn), "");
    }

    lines.push(...this.#emitDirectCallbackSupport());
    lines.push(...this.#emitDirectClassCallbackSupport());

    for (const exported of this.#options.functionExports ?? []) {
      const fn = this.#functions.get(exported.functionName);
      if (fn === undefined) {
        throw new Error(
          `JVM emission found no exported function '${exported.functionName}' ` +
            `(available: ${[...this.#functions.keys()].join(", ")})`,
        );
      }
      const params = fn.params.map((param, index) =>
        `${this.#javaType(param.type, fn.loc)} a${index}`
      ).join(", ");
      const args = fn.params.map((_, index) => `a${index}`).join(", ");
      const call = `${encodedIdentifier("f", fn.name)}(${args})`;
      lines.push(
        `  public static ${this.#javaType(fn.returnType, fn.loc)} ${exported.methodName}(${params}) {`,
        fn.returnType.kind === "void" ? `    ${call};` : `    return ${call};`,
        "  }",
        "",
      );
    }

    lines.push(
      "  static {",
      `    ${encodedIdentifier("f", entry.name)}();`,
      "  }",
      "",
      "  public static void main(String[] args) {",
      "  }",
      "}",
      "",
    );
    return lines.join("\n");
  }

  #emitStringIntrinsicSupport(): string[] {
    const methods = this.#stringIntrinsics;
    const has = (...names: string[]): boolean => names.some((name) => methods.has(name));
    const needsInteger = has(
      "charCodeAt",
      "charAt",
      "indexOf",
      "includes",
      "slice",
      "substring",
      "repeat",
      "padStart",
      "padEnd",
      "cpAt",
    );
    const needsPosition = has("indexOf", "includes", "substring");
    const lines: string[] = [];
    if (needsInteger) {
      lines.push(
        "  private static double ntsToIntegerOrInfinity(double value) {",
        "    if (Double.isNaN(value) || value == 0.0d) return 0.0d;",
        "    return value < 0.0d ? Math.ceil(value) : Math.floor(value);",
        "  }",
        "",
      );
    }
    if (needsPosition) {
      lines.push(
        "  private static int ntsStringPosition(double value, int length) {",
        "    double integer = ntsToIntegerOrInfinity(value);",
        "    if (integer <= 0.0d) return 0;",
        "    if (integer >= length) return length;",
        "    return (int)integer;",
        "  }",
        "",
      );
    }
    if (has("indexOf", "includes")) {
      lines.push(
        "  private static int ntsStringIndexOf(String value, String needle, double position) {",
        "    return value.indexOf(needle, ntsStringPosition(position, value.length()));",
        "  }",
        "",
      );
    }
    if (has("charCodeAt")) {
      lines.push(
        "  private static double ntsStringCharCodeAt(String value, double index) {",
        "    double integer = ntsToIntegerOrInfinity(index);",
        "    if (integer < 0.0d || integer >= value.length()) return Double.NaN;",
        "    return (double)value.charAt((int)integer);",
        "  }",
        "",
      );
    }
    if (has("charAt")) {
      lines.push(
        "  private static String ntsStringCharAt(String value, double index) {",
        "    double integer = ntsToIntegerOrInfinity(index);",
        "    if (integer < 0.0d || integer >= value.length()) return \"\";",
        "    int position = (int)integer;",
        "    return value.substring(position, position + 1);",
        "  }",
        "",
      );
    }
    if (has("slice")) {
      lines.push(
        "  private static int ntsStringRelativeIndex(double value, int length) {",
        "    double integer = ntsToIntegerOrInfinity(value);",
        "    if (integer < 0.0d) {",
        "      if (integer <= -length) return 0;",
        "      return length + (int)integer;",
        "    }",
        "    if (integer >= length) return length;",
        "    return (int)integer;",
        "  }",
        "",
        "  private static String ntsStringSlice(String value, double start, double end) {",
        "    int from = ntsStringRelativeIndex(start, value.length());",
        "    int to = ntsStringRelativeIndex(end, value.length());",
        "    return to <= from ? \"\" : value.substring(from, to);",
        "  }",
        "",
      );
    }
    if (has("substring")) {
      lines.push(
        "  private static String ntsStringSubstring(String value, double start, double end) {",
        "    int from = ntsStringPosition(start, value.length());",
        "    int to = ntsStringPosition(end, value.length());",
        "    return from <= to ? value.substring(from, to) : value.substring(to, from);",
        "  }",
        "",
      );
    }
    if (has("repeat")) {
      lines.push(
        "  private static String ntsStringRepeat(String value, double count) {",
        "    double integer = ntsToIntegerOrInfinity(count);",
        "    if (integer < 0.0d || integer == Double.POSITIVE_INFINITY ||",
        "        integer > Integer.MAX_VALUE ||",
        "        (integer > 0.0d && value.length() > Integer.MAX_VALUE / integer)) {",
        "      throw new NtsRangeError(\"Invalid count value\");",
        "    }",
        "    return value.repeat((int)integer);",
        "  }",
        "",
      );
    }
    if (has("padStart", "padEnd")) {
      lines.push(
        "  private static String ntsStringPad(String value, double target, String fill, boolean start) {",
        "    double integer = ntsToIntegerOrInfinity(target);",
        "    if (integer <= value.length() || fill.isEmpty()) return value;",
        "    if (!Double.isFinite(integer) || integer > Integer.MAX_VALUE) {",
        "      throw new NtsRangeError(\"Invalid string length\");",
        "    }",
        "    int paddingLength = (int)integer - value.length();",
        "    StringBuilder padding = new StringBuilder(paddingLength);",
        "    while (paddingLength >= fill.length()) {",
        "      padding.append(fill);",
        "      paddingLength -= fill.length();",
        "    }",
        "    if (paddingLength > 0) padding.append(fill, 0, paddingLength);",
        "    return start ? padding.append(value).toString() : value + padding;",
        "  }",
        "",
      );
    }
    if (has("trim", "trimStart", "trimEnd")) {
      lines.push(
        "  private static boolean ntsStringWhitespace(char value) {",
        "    return (value >= 0x0009 && value <= 0x000d) || value == 0x0020 ||",
        "      value == 0x00a0 || value == 0x1680 ||",
        "      (value >= 0x2000 && value <= 0x200a) ||",
        "      value == 0x2028 || value == 0x2029 || value == 0x202f ||",
        "      value == 0x205f || value == 0x3000 || value == 0xfeff;",
        "  }",
        "",
        "  private static String ntsStringTrim(String value, boolean start, boolean end) {",
        "    int from = 0;",
        "    int to = value.length();",
        "    if (start) while (from < to && ntsStringWhitespace(value.charAt(from))) from++;",
        "    if (end) while (to > from && ntsStringWhitespace(value.charAt(to - 1))) to--;",
        "    return from == 0 && to == value.length() ? value : value.substring(from, to);",
        "  }",
        "",
      );
    }
    if (has("split")) {
      const result = [...this.#arrayTypes.values()].find(
        ({ type }) => type.elem.kind === "string",
      );
      if (result === undefined) {
        throw new Error("JVM emitter bug: String.split has no string-array type");
      }
      lines.push(
        `  private static ${result.className} ntsStringSplit(String value, String separator, double limitValue) {`,
        `    ${result.className} result = new ${result.className}(new String[]{});`,
        "    long limit = ntsToUint32(limitValue);",
        "    if (limit == 0L) return result;",
        "    if (separator.isEmpty()) {",
        "      for (int index = 0; index < value.length() && result.length < limit; index++) {",
        "        result.push(value.substring(index, index + 1));",
        "      }",
        "      return result;",
        "    }",
        "    int start = 0;",
        "    while (result.length < limit) {",
        "      int match = value.indexOf(separator, start);",
        "      if (match < 0) break;",
        "      result.push(value.substring(start, match));",
        "      start = match + separator.length();",
        "    }",
        "    if (result.length < limit) result.push(value.substring(start));",
        "    return result;",
        "  }",
        "",
      );
    }
    if (has("isWellFormed", "toWellFormed")) {
      lines.push(
        "  private static boolean ntsStringIsWellFormed(String value) {",
        "    for (int index = 0; index < value.length(); index++) {",
        "      char unit = value.charAt(index);",
        "      if (Character.isHighSurrogate(unit)) {",
        "        if (++index >= value.length() || !Character.isLowSurrogate(value.charAt(index))) return false;",
        "      } else if (Character.isLowSurrogate(unit)) {",
        "        return false;",
        "      }",
        "    }",
        "    return true;",
        "  }",
        "",
      );
    }
    if (has("toWellFormed")) {
      lines.push(
        "  private static String ntsStringToWellFormed(String value) {",
        "    if (ntsStringIsWellFormed(value)) return value;",
        "    StringBuilder result = new StringBuilder(value.length());",
        "    for (int index = 0; index < value.length(); index++) {",
        "      char unit = value.charAt(index);",
        "      if (Character.isHighSurrogate(unit) && index + 1 < value.length() &&",
        "          Character.isLowSurrogate(value.charAt(index + 1))) {",
        "        result.append(unit).append(value.charAt(++index));",
        "      } else if (Character.isSurrogate(unit)) {",
        "        result.append((char)0xfffd);",
        "      } else {",
        "        result.append(unit);",
        "      }",
        "    }",
        "    return result.toString();",
        "  }",
        "",
      );
    }
    if (has("cpAt")) {
      lines.push(
        "  private static String ntsStringCodePointAt(String value, double index) {",
        "    double integer = ntsToIntegerOrInfinity(index);",
        "    if (integer < 0.0d || integer >= value.length()) return \"\";",
        "    int position = (int)integer;",
        "    char first = value.charAt(position);",
        "    int end = Character.isHighSurrogate(first) && position + 1 < value.length() &&",
        "        Character.isLowSurrogate(value.charAt(position + 1)) ? position + 2 : position + 1;",
        "    return value.substring(position, end);",
        "  }",
        "",
      );
    }
    return lines;
  }

  #emitArraySupport(): string[] {
    if (this.#arrayTypes.size === 0) return [];
    const entry = this.#functions.get(this.#module.entry)!;
    const lines = [
      "  private static int ntsArrayIndex(double value, int length, boolean append) {",
      "    int limit = append && length < Integer.MAX_VALUE ? length + 1 : length;",
      "    if (!Double.isFinite(value) || value != Math.rint(value) ||",
      "        value < 0.0d || value >= limit) {",
      "      throw new NtsTrapError(\"Array index out of bounds\");",
      "    }",
      "    return (int)value;",
      "  }",
      "",
    ];
    for (const plan of this.#arrayTypes.values()) {
      const elementType = this.#javaType(plan.type.elem, entry.loc);
      const zero = this.#defaultJavaValue(plan.type.elem, entry.loc);
      const strictEquality = this.#arrayElementEquality(
        plan.type.elem,
        "data[index]",
        "value",
        false,
      );
      const sameValueZero = this.#arrayElementEquality(
        plan.type.elem,
        "data[index]",
        "value",
        true,
      );
      lines.push(
        `  private static final class ${plan.className} {`,
        `    private ${elementType}[] data;`,
        "    private int length;",
        "",
        `    private ${plan.className}(${elementType}[] data) {`,
        "      this.data = data;",
        "      this.length = data.length;",
        "    }",
        "",
        "    private void ensure(int need) {",
        "      if (need <= data.length) return;",
        "      int capacity = Math.max(4, data.length);",
        "      while (capacity < need) {",
        "        if (capacity > Integer.MAX_VALUE / 2) {",
        "          capacity = need;",
        "          break;",
        "        }",
        "        capacity *= 2;",
        "      }",
        "      data = java.util.Arrays.copyOf(data, capacity);",
        "    }",
        "",
        "    private double length() {",
        "      return (double)length;",
        "    }",
        "",
        `    private ${elementType} get(double position) {`,
        "      return data[ntsArrayIndex(position, length, false)];",
        "    }",
        "",
        `    private void set(double position, ${elementType} value) {`,
        "      int index = ntsArrayIndex(position, length, true);",
        "      if (index == length) {",
        "        ensure(length + 1);",
        "        length++;",
        "      }",
        "      data[index] = value;",
        "    }",
        "",
        `    private double push(${elementType}... values) {`,
        "      if (values.length > Integer.MAX_VALUE - length) {",
        "        throw new NtsRangeError(\"Invalid array length\");",
        "      }",
        "      int next = length + values.length;",
        "      ensure(next);",
        "      System.arraycopy(values, 0, data, length, values.length);",
        "      length = next;",
        "      return (double)length;",
        "    }",
        "",
        `    private ${elementType} pop() {`,
        "      if (length == 0) throw new NtsTrapError(\"Cannot pop an empty array\");",
        `      ${elementType} value = data[--length];`,
        `      data[length] = ${zero};`,
        "      return value;",
        "    }",
        "",
        `    private double indexOf(${elementType} value) {`,
        "      for (int index = 0; index < length; index++) {",
        `        if (${strictEquality}) return (double)index;`,
        "      }",
        "      return -1.0d;",
        "    }",
        "",
        `    private boolean includes(${elementType} value) {`,
        "      for (int index = 0; index < length; index++) {",
        `        if (${sameValueZero}) return true;`,
        "      }",
        "      return false;",
        "    }",
        "  }",
        "",
      );
    }
    return lines;
  }

  #arrayElementEquality(
    type: IrType,
    left: string,
    right: string,
    sameValueZero: boolean,
  ): string {
    if (type.kind === "string") {
      return `java.util.Objects.equals(${left}, ${right})`;
    }
    if (type.kind === "f64") {
      return sameValueZero
        ? `((${left}) == (${right}) || (Double.isNaN(${left}) && Double.isNaN(${right})))`
        : `((${left}) == (${right}))`;
    }
    if (
      type.kind === "bool" ||
      (type.kind === "nativeScalar" && type.scalar === "i64")
    ) {
      return `((${left}) == (${right}))`;
    }
    /* Every other admitted array element is an ART reference. Java
     * reference identity is the JavaScript identity of managed objects,
     * native handles, byte arrays, and nested array wrappers. */
    return `((${left}) == (${right}))`;
  }

  #emitFunctionSupport(): string[] {
    const entry = this.#functions.get(this.#module.entry)!;
    const lines: string[] = [];
    for (const plan of this.#functionTypes.values()) {
      if (plan.type.rest === true) {
        throw new JvmUnsupportedError("rest-parameter function values", entry.loc);
      }
      const parameters = plan.type.params.map((type, index) =>
        `${this.#javaType(type, entry.loc)} a${index}`
      );
      lines.push(
        "  @FunctionalInterface",
        `  private interface ${plan.interfaceName} {`,
        `    ${this.#javaType(plan.type.ret, entry.loc)} call(${parameters.join(", ")});`,
        "  }",
        "",
      );
    }
    for (const value of this.#functionValues.values()) {
      lines.push(
        `  private static final ${this.#functionInterfaceName(value.type, entry.loc)} ` +
          `${value.fieldName} = ${this.#functionLambda(value.fnName, value.type, [], entry.loc)};`,
        "",
      );
    }
    return lines;
  }

  /** A checked structural record has a closed, interned shape. On the JVM
   * that shape is an ordinary traced Java object with exact primitive and
   * reference fields: no generic property table, boxed scalar, or JNI
   * handle is involved. A factory is emitted per literal because Native IR
   * keeps literal fields in source order while the shape's fields are
   * canonicalized by name; Java evaluates factory arguments left-to-right,
   * preserving JavaScript side effects before the factory stores them. */
  #emitRecordSupport(): string[] {
    const entry = this.#functions.get(this.#module.entry)!;
    const lines: string[] = [];
    for (const plan of this.#recordTypes.values()) {
      const { shape } = plan;
      if (shape.indexValue !== undefined) {
        throw new JvmUnsupportedError(
          `record shape '${shape.id}' with an index signature`,
          entry.loc,
        );
      }
      lines.push(`  private static final class ${plan.className} {`);
      for (const field of shape.fields) {
        lines.push(
          `    private ${this.#javaType(field.type, entry.loc)} ${this.#recordFieldName(field.name)};`,
        );
      }
      lines.push("  }", "");
    }

    for (const plan of this.#recordLiterals.values()) {
      const { expression } = plan;
      if (expression.type.kind !== "record") {
        throw new Error("JVM emitter bug: recordLit has a non-record type");
      }
      const record = this.#recordPlan(expression.type.shapeId, expression.loc);
      if (record.shape.indexValue !== undefined) {
        throw new JvmUnsupportedError(
          `record literal for index-signature shape '${record.shape.id}'`,
          expression.loc,
        );
      }
      if (expression.fields.some((field) => field.drop === true)) {
        throw new JvmUnsupportedError("record literal dropped fields", expression.loc);
      }
      if (expression.fields.some((field) => field.overflow === true)) {
        throw new JvmUnsupportedError("record literal overflow fields", expression.loc);
      }
      const fields = new Map(record.shape.fields.map((field) => [field.name, field]));
      const parameters = expression.fields.map((field, index) => {
        const declared = fields.get(field.name);
        if (declared === undefined || typeKey(declared.type) !== typeKey(field.value.type)) {
          throw new Error(
            `JVM record literal '${record.shape.id}' disagrees at field '${field.name}'`,
          );
        }
        return `${this.#javaType(declared.type, expression.loc)} a${index}`;
      });
      if (fields.size !== expression.fields.length) {
        throw new Error(
          `JVM record literal '${record.shape.id}' does not initialize its exact shape`,
        );
      }
      lines.push(
        `  private static ${record.className} ${plan.factoryName}(${parameters.join(", ")}) {`,
        `    ${record.className} value = new ${record.className}();`,
      );
      for (const [index, field] of expression.fields.entries()) {
        lines.push(`    value.${this.#recordFieldName(field.name)} = a${index};`);
      }
      lines.push("    return value;", "  }", "");
    }
    return lines;
  }

  /** A general union remains monomorphic without erasing scalar arms into
   * java.lang.Object. Each closed union gets one exact tag class and one
   * field per payload-bearing arm. Unit arms are shared singletons; value
   * arms construct through typed factories, leaving javac and ART able to
   * scalar-replace short-lived boxes. A reference plus one null/undefined
   * arm is represented directly as a nullable ART reference instead and
   * therefore emits no class here. */
  #emitUnionSupport(): string[] {
    const entry = this.#functions.get(this.#module.entry)!;
    const lines: string[] = [];
    for (const plan of this.#unionTypes.values()) {
      if (this.#nullableReference({ kind: "union", unionId: plan.definition.id }) !== null) {
        continue;
      }
      const payloads = plan.definition.arms
        .map((type, tag) => ({ type, tag }))
        .filter(({ type }) => !this.#isUnitType(type));
      lines.push(
        `  private static final class ${plan.className} {`,
        "    private final int tag;",
      );
      for (const { type, tag } of payloads) {
        lines.push(
          `    private final ${this.#javaType(type, entry.loc)} payload${tag};`,
        );
      }
      const constructorParameters = [
        "int tag",
        ...payloads.map(({ type, tag }) =>
          `${this.#javaType(type, entry.loc)} payload${tag}`
        ),
      ];
      lines.push(
        `    private ${plan.className}(${constructorParameters.join(", ")}) {`,
        "      this.tag = tag;",
      );
      for (const { tag } of payloads) {
        lines.push(`      this.payload${tag} = payload${tag};`);
      }
      lines.push("    }", "");
      for (const [tag, arm] of plan.definition.arms.entries()) {
        const arguments_ = payloads.map(({ type, tag: payloadTag }) =>
          payloadTag === tag ? "value" : this.#defaultJavaValue(type, entry.loc)
        );
        if (this.#isUnitType(arm)) {
          lines.push(
            `    private static final ${plan.className} unit${tag} = ` +
              `new ${plan.className}(${[String(tag), ...arguments_].join(", ")});`,
            "",
          );
        } else {
          lines.push(
            `    private static ${plan.className} wrap${tag}(` +
              `${this.#javaType(arm, entry.loc)} value) {`,
            `      return new ${plan.className}(` +
              `${[String(tag), ...arguments_].join(", ")});`,
            "    }",
            "",
          );
        }
      }
      lines.push("  }", "");
    }
    return lines;
  }

  #functionLambda(
    fnName: string,
    type: Extract<IrType, { readonly kind: "func" }>,
    captures: readonly string[],
    loc: SrcLoc,
  ): string {
    const target = this.#functions.get(fnName);
    if (target === undefined) {
      throw new Error(`JVM emitter bug: closure over missing function '${fnName}'`);
    }
    if (
      target.params.length !== type.params.length ||
      (target.captures?.length ?? 0) !== captures.length
    ) {
      throw new Error(`JVM emitter bug: closure signature disagrees for '${fnName}'`);
    }
    if (type.rest === true) {
      throw new JvmUnsupportedError("rest-parameter function values", loc);
    }
    const parameters = type.params.map((_, index) => `a${index}`);
    const invocation = `${encodedIdentifier("f", fnName)}(${[
      ...captures,
      ...parameters,
    ].join(", ")})`;
    return `(${parameters.join(", ")}) -> ${invocation}`;
  }

  #emitBoxSupport(): string[] {
    const kinds = new Set<"boolean" | "double" | "long" | "reference">();
    for (const fn of this.#module.functions) {
      for (const local of fn.locals) {
        if (local.boxed === true && local.mutable) {
          if (local.tdz === true) {
            throw new JvmUnsupportedError("captured temporal-dead-zone bindings", fn.loc);
          }
          kinds.add(this.#boxKind(local.type, fn.loc));
        }
      }
    }
    const lines: string[] = [];
    if (
      this.#needsI64ToNumber ||
      this.#needsUint8ArrayLength ||
      this.#arrayTypes.size > 0 ||
      this.#stringIntrinsics.has("repeat") ||
      this.#stringIntrinsics.has("padStart") ||
      this.#stringIntrinsics.has("padEnd")
    ) {
      lines.push(
        "  private static final class NtsRangeError extends RuntimeException {",
        "    private NtsRangeError(String message) {",
        "      super(message);",
        "    }",
        "  }",
        "",
      );
    }
    if (this.#needsUint8SetHelper || this.#arrayTypes.size > 0) {
      lines.push(
        "  private static final class NtsTrapError extends Error {",
        "    private NtsTrapError(String message) {",
        "      super(message);",
        "    }",
        "  }",
        "",
      );
    }
    if (kinds.has("double")) {
      lines.push(
        "  private static final class NtsDoubleBox {",
        "    private double value;",
        "",
        "    private NtsDoubleBox(double value) {",
        "      this.value = value;",
        "    }",
        "  }",
        "",
      );
    }
    if (kinds.has("boolean")) {
      lines.push(
        "  private static final class NtsBooleanBox {",
        "    private boolean value;",
        "",
        "    private NtsBooleanBox(boolean value) {",
        "      this.value = value;",
        "    }",
        "  }",
        "",
      );
    }
    if (kinds.has("long")) {
      lines.push(
        "  private static final class NtsLongBox {",
        "    private long value;",
        "",
        "    private NtsLongBox(long value) {",
        "      this.value = value;",
        "    }",
        "  }",
        "",
      );
    }
    if (kinds.has("reference")) {
      lines.push(
        "  private static final class NtsReferenceBox<T> {",
        "    private T value;",
        "",
        "    private NtsReferenceBox(T value) {",
        "      this.value = value;",
        "    }",
        "  }",
        "",
      );
    }
    return lines;
  }

  /** ScriptC's managed objects need no handle cell in a JVM artifact. The
   * checked class layout becomes an ordinary nested Java class, while the
   * already-lowered constructor and method functions remain the single
   * semantic bodies. Thin instance wrappers exist only where Native IR asks
   * for dynamic dispatch; javac/ART then provide the vtable directly. */
  #emitManagedClassSupport(): string[] {
    const lines: string[] = [];
    for (const class_ of this.#classes.values()) {
      if (class_ === this.#directPeerClass()) {
        lines.push(...this.#emitDirectPeerSupport(class_));
        continue;
      }
      if (class_.genericOf !== undefined) {
        throw new JvmUnsupportedError("generic class families", class_.loc);
      }
      const base = class_.base === undefined
        ? undefined
        : this.#classes.get(class_.base);
      if (class_.base !== undefined && base === undefined) {
        throw new JvmUnsupportedError(
          `managed class '${class_.name}' with runtime base '${class_.base}'`,
          class_.loc,
        );
      }
      const className = this.#managedClassName(class_.name, class_.loc);
      lines.push(
        `  private static ${class_.abstract === true ? "abstract " : ""}class ${className}${
          base === undefined
            ? ""
            : ` extends ${this.#managedClassName(base.name, class_.loc)}`
        } {`,
      );
      const inheritedFieldCount = base?.fields.length ?? 0;
      for (const field of class_.fields.slice(inheritedFieldCount)) {
        lines.push(
          `    private ${
            this.#integerField(class_.name, field.name)
              ? "int"
              : this.#javaType(field.type, class_.loc)
          } ${this.#managedFieldName(field.name)};`,
        );
      }
      if (class_.fields.length > inheritedFieldCount) lines.push("");

      for (const method of class_.methods ?? []) {
        if (class_.abstractMethods?.includes(method) === true) continue;
        const implementation = this.#functions.get(`%${class_.name}.${method}`);
        if (implementation === undefined) continue;
        const receiver = implementation.params[0];
        if (
          receiver === undefined ||
          receiver.type.kind !== "object" ||
          receiver.type.className !== class_.name
        ) {
          throw new Error(
            `JVM managed method '%${class_.name}.${method}' has no exact receiver`,
          );
        }
        const params = implementation.params.slice(1).map((param, index) =>
          `${this.#javaType(param.type, implementation.loc)} a${index}`
        );
        const args = implementation.params.slice(1).map((_, index) => `a${index}`);
        const call = `${encodedIdentifier("f", implementation.name)}(this${
          args.length === 0 ? "" : `, ${args.join(", ")}`
        })`;
        if (this.#ancestorDeclaresMethod(class_, method)) {
          lines.push("    @Override");
        }
        const integerReturn = this.#machineIntegers.methods.has(
          machineIntegerMethodKey(class_.name, method),
        );
        lines.push(
          `    ${integerReturn ? "int" : this.#javaType(implementation.returnType, implementation.loc)} ${this.#managedMethodName(method)}(${params.join(", ")}) {`,
          implementation.returnType.kind === "void"
            ? `      ${call};`
            : `      return ${call};`,
          "    }",
          "",
        );
      }
      if (lines.at(-1) === "") lines.pop();
      lines.push("  }", "");

      const constructor = this.#functions.get(`%${class_.name}.constructor`);
      if (constructor !== undefined) {
        const receiver = constructor.params[0];
        if (
          receiver === undefined ||
          receiver.type.kind !== "object" ||
          receiver.type.className !== class_.name ||
          constructor.returnType.kind !== "void"
        ) {
          throw new Error(
            `JVM managed constructor '%${class_.name}.constructor' has the wrong ABI`,
          );
        }
        const params = constructor.params.slice(1).map((param, index) =>
          `${this.#javaType(param.type, constructor.loc)} a${index}`
        );
        const args = constructor.params.slice(1).map((_, index) => `a${index}`);
        lines.push(
          `  private static ${className} ${this.#managedNewName(class_.name)}(${params.join(", ")}) {`,
          `    ${className} value = new ${className}();`,
          `    ${encodedIdentifier("f", constructor.name)}(value${
            args.length === 0 ? "" : `, ${args.join(", ")}`
          });`,
          "    return value;",
          "  }",
          "",
        );
      }
    }
    return lines;
  }

  /** A native backend needs a second managed object because the foreign
   * receiver stores no ScriptC layout. A direct JVM subclass already IS an
   * ordinary traced Java object, so its TypeScript peer fields live on that
   * receiver and attach reduces to one-time field initialization. */
  #emitDirectPeerSupport(class_: IrClassDef): string[] {
    if (class_.genericOf !== undefined || class_.base !== undefined) {
      throw new JvmUnsupportedError(
        `direct native peer class '${class_.name}' with managed inheritance`,
        class_.loc,
      );
    }
    const constructor = this.#functions.get(`%${class_.name}.constructor`);
    if (
      constructor === undefined ||
      constructor.params.length !== 2 ||
      constructor.params[0]?.type.kind !== "object" ||
      constructor.params[0].type.className !== class_.name ||
      constructor.params[1]?.type.kind !== "nativeHandle" ||
      constructor.returnType.kind !== "void"
    ) {
      throw new Error(
        `JVM direct peer '${class_.name}' has no exact peer constructor`,
      );
    }
    const lines: string[] = [];
    for (const field of class_.fields) {
      lines.push(
        `  private ${
          this.#integerField(class_.name, field.name)
            ? "int"
            : this.#javaType(field.type, class_.loc)
        } ${this.#managedFieldName(field.name)};`,
      );
    }
    if (class_.fields.length > 0) lines.push("");
    lines.push(
      "  private boolean ntsPeerAttached;",
      "",
      `  private ${this.#options.className} ntsPeer() {`,
      "    if (!this.ntsPeerAttached) {",
      `      ${encodedIdentifier("f", constructor.name)}(this, this);`,
      "      this.ntsPeerAttached = true;",
      "    }",
      "    return this;",
      "  }",
      "",
      "  private void ntsDetachPeer() {",
      "    // The peer is this Java receiver; ART owns its reachability.",
      "  }",
      "",
    );
    return lines;
  }

  #directPeerClass(): IrClassDef | undefined {
    const sourceClassName = this.#directClassCallbacks[0]?.binding.sourceClassName;
    return sourceClassName === undefined
      ? undefined
      : this.#classes.get(sourceClassName);
  }

  #ancestorDeclaresMethod(class_: IrClassDef, method: string): boolean {
    let baseName = class_.base;
    while (baseName !== undefined) {
      const base = this.#classes.get(baseName);
      if (base === undefined) return false;
      if (base.methods?.includes(method) === true) return true;
      baseName = base.base;
    }
    return false;
  }

  #emitDirectCallbackSupport(): string[] {
    if (this.#directCallbacks.length === 0) return [];
    const lines = [
      "  private static final class NtsConnection {",
      "    private Runnable ntsCancel;",
      "",
      "    private NtsConnection(Runnable ntsCancel) {",
      "      this.ntsCancel = ntsCancel;",
      "    }",
      "",
      "    private void disconnect() {",
      "      Runnable cancel = this.ntsCancel;",
      "      if (cancel == null) return;",
      "      this.ntsCancel = null;",
      "      cancel.run();",
      "    }",
      "  }",
      "",
    ];
    for (const callback of this.#directCallbacks) {
      if (callback.descriptor.result !== "V") {
        throw new Error(
          `JVM direct callback '${callback.binding.id}' has non-void ` +
            `descriptor result '${callback.descriptor.result}'`,
        );
      }
      const parameters = callback.descriptor.parameters.map((descriptor, index) =>
        `${javaDescriptorType(descriptor)} a${index}`
      );
      const arguments_ = callback.descriptor.parameters.map((_, index) => `a${index}`);
      const interfaceName = callback.binding.interfaceBinaryName.replace(/[/$]/gu, ".");
      const sites = this.#directCallbackSites.filter(
        (site) => site.callback.binding.id === callback.binding.id,
      );
      assertJavaIdentifier(callback.binding.name, "direct callback name");
      lines.push(
        `  private static final class ${callback.adapterName} implements ${interfaceName} {`,
        "    private int ntsHandlerKind;",
      );
      for (const site of sites) {
        for (const capture of site.captures) {
          lines.push(`    private ${capture.javaType} ${capture.fieldName};`);
        }
      }
      lines.push("");
      for (const site of sites) {
        const captureParameters = site.captures.map(
          (capture, index) => `${capture.javaType} c${index}`,
        );
        const kind = site.index + 1;
        lines.push(
          `    private NtsConnection ${site.registerName}(${captureParameters.join(", ")}) {`,
          "      if (this.ntsHandlerKind != 0) {",
          `        throw new IllegalStateException(${javaString(
            `A callback is already registered for ${callback.binding.ownerBinaryName}.${callback.binding.name}`,
          )});`,
          "      }",
        );
        site.captures.forEach((capture, index) => {
          lines.push(`      this.${capture.fieldName} = c${index};`);
        });
        lines.push(
          `      this.ntsHandlerKind = ${kind};`,
          "      return new NtsConnection(() -> {",
          `        if (this.ntsHandlerKind != ${kind}) return;`,
          "        this.ntsHandlerKind = 0;",
        );
        for (const capture of site.captures) {
          if (capture.clearOnCancel) {
            lines.push(`        this.${capture.fieldName} = null;`);
          }
        }
        lines.push(
          "      });",
          "    }",
          "",
        );
      }
      lines.push(
        "    @Override",
        `    public void ${callback.binding.name}(${parameters.join(", ")}) {`,
        "      switch (this.ntsHandlerKind) {",
      );
      for (const site of sites) {
        const kind = site.index + 1;
        const captures = site.captures.map(
          (capture) => `this.${capture.fieldName}`,
        );
        lines.push(
          `        case ${kind}:`,
          `          ${site.handlerName}(${[
            ...captures,
            ...arguments_,
          ].join(", ")});`,
          "          return;",
        );
      }
      lines.push(
        "        default:",
        `        throw new IllegalStateException(${javaString(
          `No callback is registered for ${callback.binding.ownerBinaryName}.${callback.binding.name}`,
        )});`,
        "      }",
        "    }",
        "  }",
        "",
      );
    }
    return lines;
  }

  /** A class-anchored registration is how the native backends connect a
   * platform-created receiver to a TypeScript override. In a JVM artifact the
   * generated Java class and the checked implementation are the same class:
   * emit the virtual override directly and turn the registration expression
   * in module initialization into an inert, verifiable marker. */
  #emitDirectClassCallbackSupport(): string[] {
    if (this.#directClassCallbacks.length === 0) return [];
    const lines: string[] = [];
    const emittedBaseCalls = new Set<string>();
    for (const callback of this.#directClassCallbacks) {
      const site = this.#directClassCallbackSites.find(
        (candidate) => candidate.callback.binding.id === callback.binding.id,
      );
      if (site === undefined) {
        throw new Error(
          `JVM direct class callback '${callback.binding.id}' has no registration site`,
        );
      }
      if (callback.descriptor.result !== "V") {
        throw new JvmUnsupportedError(
          `answered direct class callback '${callback.binding.name}'`,
          this.#functions.get(this.#module.entry)!.loc,
        );
      }
      assertJavaIdentifier(callback.binding.name, "direct class callback name");
      const parameters = callback.descriptor.parameters.map((descriptor, index) =>
        `${javaDescriptorType(descriptor)} a${index}`
      );
      const arguments_ = callback.descriptor.parameters.map((_, index) => `a${index}`);
      lines.push(
        `  private static void ntsRegisterClassCallback${site.index}() {`,
        "  }",
        "",
        "  @Override",
        `  public void ${callback.binding.name}(${parameters.join(", ")}) {`,
        `    ${site.handlerName}(this${
          arguments_.length === 0 ? "" : `, ${arguments_.join(", ")}`
        });`,
        "  }",
        "",
      );

      const baseCall = callback.binding.baseCall;
      if (baseCall === null || emittedBaseCalls.has(baseCall.bindingId)) continue;
      const direct = this.#jvmNativeBindings.get(baseCall.bindingId);
      if (
        direct === undefined ||
        direct.kind !== "instance-method" ||
        direct.ownerBinaryName !== callback.binding.ownerBinaryName ||
        direct.name !== baseCall.name ||
        direct.descriptor !== baseCall.descriptor ||
        baseCall.descriptor !== callback.binding.descriptor
      ) {
        throw new Error(
          `JVM direct class callback '${callback.binding.id}' has an invalid base-call coordinate`,
        );
      }
      assertJavaIdentifier(baseCall.name, "direct class base-call name");
      emittedBaseCalls.add(baseCall.bindingId);
      lines.push(
        `  public void ${baseCall.name}(${parameters.join(", ")}) {`,
        `    super.${callback.binding.name}(${arguments_.join(", ")});`,
        "  }",
        "",
      );
    }
    return lines;
  }

  #emitFunction(fn: IrFunction): string[] {
    if (fn.async === true) throw new JvmUnsupportedError("async functions", fn.loc);
    if (fn.generator !== undefined) throw new JvmUnsupportedError("generator functions", fn.loc);
    for (const local of fn.locals) {
      if (local.boxed === true && local.tdz === true) {
        throw new JvmUnsupportedError("captured temporal-dead-zone bindings", fn.loc);
      }
      if (
        local.nativeFrame !== undefined &&
        local.type.kind !== "nativeHandle" &&
        local.type.kind !== "string" &&
        !isJvmByteArray(local.type) &&
        this.#nullableReference(local.type) === null
      ) {
        throw new JvmUnsupportedError("frame-bounded non-handle locals", fn.loc);
      }
    }

    this.#integerLocals = this.#machineIntegers.locals.get(fn.name) ?? new Set();
    this.#mutableBoxedLocals = new Set(
      fn.locals
        .filter((local) => local.boxed === true && local.mutable)
        .map((local) => local.id),
    );
    this.#currentFunction = fn;
    const captures = (fn.captures ?? []).map((capture) => {
      const local = this.#local(fn, capture.localId, fn.loc);
      return `${this.#storageJavaType(local, fn.loc)} ${encodedIdentifier("l", capture.localId)}`;
    });
    const params = fn.params.map((param) => {
      const local = this.#local(fn, param.localId, fn.loc);
      const name = encodedIdentifier("l", param.localId);
      return `${this.#javaType(param.type, fn.loc)} ${
        this.#isMutableBox(local) ? `${name}_input` : name
      }`;
    });
    const lines = [
      `  private static ${this.#machineIntegers.returns.has(fn.name) ? "int" : this.#javaType(fn.returnType, fn.loc)} ${encodedIdentifier("f", fn.name)}(${[
        ...captures,
        ...params,
      ].join(", ")}) {`,
    ];
    for (const param of fn.params) {
      const local = this.#local(fn, param.localId, fn.loc);
      if (!this.#isMutableBox(local)) continue;
      const name = encodedIdentifier("l", param.localId);
      lines.push(
        `    ${this.#boxJavaType(local.type, fn.loc)} ${name} = ` +
          `new ${this.#boxJavaType(local.type, fn.loc)}(${name}_input);`,
      );
    }
    for (const stmt of fn.body) lines.push(...this.#stmt(fn, stmt, 2));
    lines.push("  }");
    return lines;
  }

  #stmt(fn: IrFunction, stmt: IrStmt, depth: number): string[] {
    const pad = "  ".repeat(depth);
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.#local(fn, stmt.localId, stmt.loc);
        if (this.#isMutableBox(local)) {
          const initial = stmt.init === null
            ? this.#defaultJavaValue(local.type, stmt.loc)
            : this.#expr(stmt.init);
          const boxType = this.#boxJavaType(local.type, stmt.loc);
          return [
            `${pad}${boxType} ${encodedIdentifier("l", local.id)} = ` +
              `new ${boxType}(${initial});`,
          ];
        }
        const integer = this.#integerBinding(local.id);
        const init = stmt.init === null
          ? ""
          : ` = ${
            integer
              ? this.#intExpr(stmt.init)
              : this.#expr(stmt.init)
          }`;
        const type = integer ? "int" : this.#javaType(local.type, stmt.loc);
        return [`${pad}${type} ${encodedIdentifier("l", local.id)}${init};`];
      }
      case "assign":
        return [
          `${pad}${this.#binding(stmt.localId)} = ${
            this.#integerBinding(stmt.localId)
              ? this.#intExpr(stmt.value)
              : this.#expr(stmt.value)
          };`,
        ];
      case "fieldSet":
        return [
          `${pad}((${this.#managedClassName(stmt.className, stmt.loc)})(${this.#expr(stmt.obj)})).${
            this.#managedFieldName(stmt.field)
          } = ${
            this.#integerField(stmt.className, stmt.field)
              ? this.#intExpr(stmt.value)
              : this.#expr(stmt.value)
          };`,
        ];
      case "recordSet": {
        const record = this.#recordPlan(stmt.shapeId, stmt.loc);
        const field = record.shape.fields.find(({ name }) => name === stmt.field);
        if (field === undefined || typeKey(field.type) !== typeKey(stmt.value.type)) {
          throw new Error(
            `JVM record write '${stmt.shapeId}.${stmt.field}' disagrees with its shape`,
          );
        }
        return [
          `${pad}((${record.className})(${this.#expr(stmt.obj)})).${
            this.#recordFieldName(stmt.field)
          } = ${this.#expr(stmt.value)};`,
        ];
      }
      case "arraySet": {
        if (stmt.arr.type.kind !== "array") {
          throw new Error("JVM emitter bug: arraySet on a non-array value");
        }
        return [
          `${pad}(${this.#expr(stmt.arr)}).set(${this.#expr(stmt.index)}, ${
            this.#expr(stmt.value)
          });`,
        ];
      }
      case "bytesSet": {
        if (
          !isJvmByteArray(stmt.arr.type) ||
          stmt.index.type.kind !== "f64" ||
          stmt.value.type.kind !== "f64"
        ) {
          throw new JvmUnsupportedError("non-Uint8Array element write", stmt.loc);
        }
        const array = this.#expr(stmt.arr);
        const index = this.#directIntExpr(stmt.index);
        if (index === null) {
          return [
            `${pad}ntsSetUint8(${array}, ${this.#expr(stmt.index)}, ${this.#expr(stmt.value)});`,
          ];
        }
        const integerValue = this.#directIntExpr(stmt.value);
        const value = integerValue ?? `ntsToUint32(${this.#expr(stmt.value)})`;
        return [`${pad}(${array})[${index}] = (byte)(${value});`];
      }
      case "exprStmt":
        return [`${pad}${this.#expr(stmt.expr)};`];
      case "return":
        return [
          `${pad}return${
            stmt.value === null
              ? ""
              : ` ${
                this.#machineIntegers.returns.has(fn.name)
                  ? this.#intExpr(stmt.value)
                  : this.#expr(stmt.value)
              }`
          };`,
        ];
      case "if": {
        const lines = [`${pad}if (${this.#expr(stmt.cond)}) {`];
        for (const child of stmt.then) lines.push(...this.#stmt(fn, child, depth + 1));
        if (stmt.else_ === null) {
          lines.push(`${pad}}`);
        } else {
          lines.push(`${pad}} else {`);
          for (const child of stmt.else_) lines.push(...this.#stmt(fn, child, depth + 1));
          lines.push(`${pad}}`);
        }
        return lines;
      }
      case "while": {
        if ((stmt.labels?.length ?? 0) !== 0) {
          throw new JvmUnsupportedError("labeled while loops", stmt.loc);
        }
        const lines = [`${pad}while (${this.#expr(stmt.cond)}) {`];
        for (const child of stmt.body) lines.push(...this.#stmt(fn, child, depth + 1));
        lines.push(`${pad}}`);
        return lines;
      }
      case "for": {
        if ((stmt.labels?.length ?? 0) !== 0) {
          throw new JvmUnsupportedError("labeled for loops", stmt.loc);
        }
        const init = stmt.init === null ? "" : this.#forClause(fn, stmt.init);
        const cond = stmt.cond === null ? "" : this.#expr(stmt.cond);
        const update = stmt.update === null ? "" : this.#forClause(fn, stmt.update);
        const lines = [`${pad}for (${init}; ${cond}; ${update}) {`];
        for (const child of stmt.body) lines.push(...this.#stmt(fn, child, depth + 1));
        lines.push(`${pad}}`);
        return lines;
      }
      case "break": {
        if (stmt.label !== undefined) {
          throw new JvmUnsupportedError("labeled break statements", stmt.loc);
        }
        return [`${pad}break;`];
      }
      case "continue": {
        if (stmt.label !== undefined) {
          throw new JvmUnsupportedError("labeled continue statements", stmt.loc);
        }
        return [`${pad}continue;`];
      }
      case "tryCatch": {
        if (
          stmt.catchBody !== null ||
          stmt.catchLocalId !== null ||
          stmt.finallyBody === null
        ) {
          throw new JvmUnsupportedError(
            "try/catch outside a generated native-peer terminal",
            stmt.loc,
          );
        }
        const lines = [`${pad}try {`];
        for (const child of stmt.tryBody) {
          lines.push(...this.#stmt(fn, child, depth + 1));
        }
        lines.push(`${pad}} finally {`);
        for (const child of stmt.finallyBody) {
          lines.push(...this.#stmt(fn, child, depth + 1));
        }
        lines.push(`${pad}}`);
        return lines;
      }
      case "nativePeerDetach": {
        const peer = this.#directPeerClass();
        const subclass = this.#directClassCallbacks[0]?.binding;
        if (
          peer === undefined ||
          subclass === undefined ||
          stmt.className !== peer.name ||
          stmt.handle.type.kind !== "nativeHandle" ||
          this.#nativeHandleOwner(stmt.handle.type.typeId, stmt.loc) !==
            subclass.ownerBinaryName
        ) {
          throw new JvmUnsupportedError(
            `native peer detach for '${stmt.className}' outside its direct JVM subclass`,
            stmt.loc,
          );
        }
        return [
          `${pad}((${this.#options.className})(${this.#expr(stmt.handle)})).ntsDetachPeer();`,
        ];
      }
      default:
        throw new JvmUnsupportedError(`statement '${stmt.kind}'`, stmt.loc);
    }
  }

  #forClause(fn: IrFunction, stmt: IrStmt): string {
    if (
      stmt.kind !== "varDecl" &&
      stmt.kind !== "assign" &&
      stmt.kind !== "exprStmt"
    ) {
      throw new JvmUnsupportedError(`for-loop clause '${stmt.kind}'`, stmt.loc);
    }
    const lines = this.#stmt(fn, stmt, 0);
    if (lines.length !== 1 || !lines[0]!.endsWith(";")) {
      throw new Error("JVM emitter bug: for-loop clause did not emit one statement");
    }
    return lines[0]!.slice(0, -1);
  }

  #expr(expr: IrExpr): string {
    switch (expr.kind) {
      case "numLit": return numberLiteral(expr.value);
      case "nativeScalarLit": {
        if (expr.type.scalar !== "i64") {
          throw new JvmUnsupportedError(
            `native scalar literal '${expr.type.scalar}'`,
            expr.loc,
          );
        }
        return expr.value === "-9223372036854775808"
          ? "Long.MIN_VALUE"
          : `${expr.value}L`;
      }
      case "nativeIntegerBin": {
        if (
          expr.type.scalar !== "i64" ||
          expr.left.type.kind !== "nativeScalar" ||
          expr.left.type.scalar !== "i64" ||
          expr.right.type.kind !== "nativeScalar" ||
          expr.right.type.scalar !== "i64" ||
          !["+", "-", "*", "&", "|", "^"].includes(expr.op)
        ) {
          throw new JvmUnsupportedError(
            `native integer operator '${expr.op}' over '${expr.type.scalar}'`,
            expr.loc,
          );
        }
        return `(${this.#expr(expr.left)} ${expr.op} ${this.#expr(expr.right)})`;
      }
      case "nativeScalarToNumber": {
        if (
          expr.value.type.kind !== "nativeScalar" ||
          expr.value.type.scalar !== "i64"
        ) {
          throw new JvmUnsupportedError(
            `native scalar '${expr.value.type.kind === "nativeScalar" ? expr.value.type.scalar : expr.value.type.kind}' to number`,
            expr.loc,
          );
        }
        return `ntsI64ToNumber(${this.#expr(expr.value)})`;
      }
      case "boolLit": return expr.value ? "true" : "false";
      case "strLit": return javaString(expr.value);
      case "strConcat": {
        if (
          expr.left.type.kind !== "string" ||
          expr.right.type.kind !== "string" ||
          expr.type.kind !== "string"
        ) {
          throw new JvmUnsupportedError("non-string concatenation", expr.loc);
        }
        return `(${this.#expr(expr.left)} + ${this.#expr(expr.right)})`;
      }
      case "strEq": {
        if (
          expr.left.type.kind !== "string" ||
          expr.right.type.kind !== "string" ||
          expr.type.kind !== "bool"
        ) {
          throw new JvmUnsupportedError("non-string equality", expr.loc);
        }
        return `${expr.negated ? "!" : ""}(${this.#expr(expr.left)}).equals(${this.#expr(expr.right)})`;
      }
      case "toString": {
        if (expr.operand.type.kind === "string") return this.#expr(expr.operand);
        if (expr.operand.type.kind === "bool") {
          return `Boolean.toString(${this.#expr(expr.operand)})`;
        }
        if (expr.operand.type.kind === "f64") {
          const integer = this.#directIntExpr(expr.operand);
          return integer === null
            ? `ntsNumberToString(${this.#expr(expr.operand)})`
            : `Integer.toString(${integer})`;
        }
        throw new JvmUnsupportedError(
          `string conversion from '${expr.operand.type.kind}'`,
          expr.loc,
        );
      }
      case "strIntrinsic": {
        if (expr.receiver.type.kind !== "string") {
          throw new JvmUnsupportedError(
            `string intrinsic '${expr.method}' on '${expr.receiver.type.kind}'`,
            expr.loc,
          );
        }
        const receiver = this.#expr(expr.receiver);
        const argument = (index: number): string => this.#expr(expr.args[index]!);
        switch (expr.method) {
          case "length":
            /* Java and JavaScript both count UTF-16 code units. */
            return `(double)((${receiver}).length())`;
          case "charCodeAt":
            return `ntsStringCharCodeAt(${receiver}, ${argument(0)})`;
          case "charAt":
            return `ntsStringCharAt(${receiver}, ${argument(0)})`;
          case "indexOf":
            return `(double)ntsStringIndexOf(${receiver}, ${argument(0)}, ${
              expr.args[1] === undefined ? "0.0d" : argument(1)
            })`;
          case "includes":
            return `(ntsStringIndexOf(${receiver}, ${argument(0)}, ${
              expr.args[1] === undefined ? "0.0d" : argument(1)
            }) >= 0)`;
          case "startsWith":
            return `((${receiver}).startsWith(${argument(0)}))`;
          case "endsWith":
            return `((${receiver}).endsWith(${argument(0)}))`;
          case "slice":
            return `ntsStringSlice(${receiver}, ${
              expr.args[0] === undefined ? "0.0d" : argument(0)
            }, ${
              expr.args[1] === undefined ? "Double.POSITIVE_INFINITY" : argument(1)
            })`;
          case "substring":
            return `ntsStringSubstring(${receiver}, ${argument(0)}, ${
              expr.args[1] === undefined ? "Double.POSITIVE_INFINITY" : argument(1)
            })`;
          case "repeat":
            return `ntsStringRepeat(${receiver}, ${argument(0)})`;
          case "trim":
            return `ntsStringTrim(${receiver}, true, true)`;
          case "trimStart":
            return `ntsStringTrim(${receiver}, true, false)`;
          case "trimEnd":
            return `ntsStringTrim(${receiver}, false, true)`;
         case "split":
            return `ntsStringSplit(${receiver}, ${argument(0)}, ${
              expr.args[1] === undefined ? "4294967295.0d" : argument(1)
            })`;
          case "padStart":
            return `ntsStringPad(${receiver}, ${argument(0)}, ${argument(1)}, true)`;
          case "padEnd":
            return `ntsStringPad(${receiver}, ${argument(0)}, ${argument(1)}, false)`;
          case "toLowerCase":
            return `((${receiver}).toLowerCase(java.util.Locale.ROOT))`;
          case "toUpperCase":
            return `((${receiver}).toUpperCase(java.util.Locale.ROOT))`;
          case "isWellFormed":
            return `ntsStringIsWellFormed(${receiver})`;
          case "toWellFormed":
            return `ntsStringToWellFormed(${receiver})`;
          case "cpAt":
            return `ntsStringCodePointAt(${receiver}, ${argument(0)})`;
        }
      }
      case "arrayLit": {
        if (expr.type.kind !== "array") {
          throw new Error("JVM emitter bug: arrayLit has a non-array type");
        }
        if ((expr.spreads?.length ?? 0) !== 0) {
          throw new JvmUnsupportedError("array literal spreads", expr.loc);
        }
        const elementType = this.#javaType(expr.type.elem, expr.loc);
        return `new ${this.#arrayClassName(expr.type, expr.loc)}(new ${elementType}[]{${
          expr.elems.map((element) => this.#expr(element)).join(", ")
        }})`;
      }
      case "recordLit": {
        const plan = this.#recordLiterals.get(expr);
        if (plan === undefined) {
          throw new Error("JVM emitter bug: record literal was not planned");
        }
        return `${plan.factoryName}(${expr.fields.map((field) =>
          this.#expr(field.value)
        ).join(", ")})`;
      }
      case "recordGet": {
        const record = this.#recordPlan(expr.shapeId, expr.loc);
        const field = record.shape.fields.find(({ name }) => name === expr.field);
        if (field === undefined || typeKey(field.type) !== typeKey(expr.type)) {
          throw new Error(
            `JVM record read '${expr.shapeId}.${expr.field}' disagrees with its shape`,
          );
        }
        return `((${record.className})(${this.#expr(expr.obj)})).${
          this.#recordFieldName(expr.field)
        }`;
      }
      case "arrayGet": {
        if (expr.arr.type.kind !== "array") {
          throw new Error("JVM emitter bug: arrayGet on a non-array value");
        }
        return `(${this.#expr(expr.arr)}).get(${this.#expr(expr.index)})`;
      }
      case "arrIntrinsic": {
        if (expr.receiver.type.kind !== "array") {
          throw new Error("JVM emitter bug: arrIntrinsic on a non-array value");
        }
        const receiver = this.#expr(expr.receiver);
        switch (expr.method) {
          case "length":
            return `(${receiver}).length()`;
          case "push":
            return `(${receiver}).push(${expr.args.map((arg) => this.#expr(arg)).join(", ")})`;
          case "pop":
            return `(${receiver}).pop()`;
          case "indexOf":
            return `(${receiver}).indexOf(${this.#expr(expr.args[0]!)})`;
          case "includes":
            return `(${receiver}).includes(${this.#expr(expr.args[0]!)})`;
          default:
            throw new JvmUnsupportedError(`array intrinsic '${expr.method}'`, expr.loc);
        }
      }
      case "bytesNew": {
        if (!isJvmByteArray(expr.type)) {
          throw new JvmUnsupportedError("non-Uint8Array byte construction", expr.loc);
        }
        if (expr.source === null) return "new byte[0]";
        if (expr.source.type.kind === "f64") {
          return `new byte[ntsUint8ArrayLength(${this.#expr(expr.source)})]`;
        }
        if (isJvmByteArray(expr.source.type)) {
          return `((${this.#expr(expr.source)}).clone())`;
        }
        throw new JvmUnsupportedError(
          `Uint8Array construction from '${expr.source.type.kind}'`,
          expr.loc,
        );
      }
      case "bytesIntrinsic": {
        if (
          (expr.method !== "length" && expr.method !== "byteLength") ||
          !isJvmByteArray(expr.receiver.type) ||
          expr.args.length !== 0 ||
          expr.type.kind !== "f64"
        ) {
          throw new JvmUnsupportedError(
            `byte-array intrinsic '${expr.method}'`,
            expr.loc,
          );
        }
        /* Java byte[] and Uint8Array have the same fixed element count.
         * The signedness of Java's byte element is irrelevant to length;
         * element reads remain refused until their 0..255 widening is
         * lowered explicitly. */
        return `(double)((${this.#expr(expr.receiver)}).length)`;
      }
      case "varRef": return this.#binding(expr.localId);
      case "call":
        return `${encodedIdentifier("f", expr.callee)}(${expr.args.map((arg) => this.#expr(arg)).join(", ")})`;
      case "closure": {
        if (expr.type.kind !== "func") {
          throw new Error("JVM emitter bug: closure has a non-function type");
        }
        const target = this.#functions.get(expr.fnName);
        if (target === undefined) {
          throw new Error(`JVM emitter bug: closure over missing function '${expr.fnName}'`);
        }
        if (target.captures === undefined) {
          const value = this.#functionValues.get(expr.fnName);
          if (value === undefined || typeKey(value.type) !== typeKey(expr.type)) {
            throw new Error(
              `JVM emitter bug: top-level function value '${expr.fnName}' was not planned`,
            );
          }
          return value.fieldName;
        }
        const captures = expr.captures.map((id) => this.#captureBinding(id, expr.loc));
        return `(${this.#functionInterfaceName(expr.type, expr.loc)})(${
          this.#functionLambda(expr.fnName, expr.type, captures, expr.loc)
        })`;
      }
      case "callValue": {
        if (expr.callee.type.kind !== "func") {
          throw new Error("JVM emitter bug: callValue has a non-function callee");
        }
        if (expr.args.length !== expr.callee.type.params.length) {
          throw new Error("JVM emitter bug: callValue argument count disagrees");
        }
        return `(${this.#expr(expr.callee)}).call(${
          expr.args.map((arg) => this.#expr(arg)).join(", ")
        })`;
      }
      case "new":
        return `${this.#managedNewName(expr.className)}(${expr.args.map((arg) => this.#expr(arg)).join(", ")})`;
      case "virtualCall": {
        const receiver = expr.args[0];
        if (receiver === undefined) {
          throw new Error(
            `JVM virtual call '${expr.className}.${expr.method}' has no receiver`,
          );
        }
        return `((${this.#managedClassName(expr.className, expr.loc)})(${this.#expr(receiver)})).${
          this.#managedMethodName(expr.method)
        }(${expr.args.slice(1).map((arg) => this.#expr(arg)).join(", ")})`;
      }
      case "fieldGet":
        return `((${this.#managedClassName(expr.className, expr.loc)})(${this.#expr(expr.obj)})).${
          this.#managedFieldName(expr.field)
        }`;
      case "bin": {
        const operandKind = expr.left.type.kind;
        if (
          operandKind !== expr.right.type.kind ||
          (operandKind !== "f64" && operandKind !== "bool")
        ) {
          throw new JvmUnsupportedError(
            `operator '${expr.op}' over '${operandKind}'`,
            expr.loc,
          );
        }
        if (operandKind === "bool" && expr.op !== "===" && expr.op !== "!==") {
          throw new JvmUnsupportedError(`boolean operator '${expr.op}'`, expr.loc);
        }
        const left = this.#expr(expr.left);
        const right = this.#expr(expr.right);
        if (expr.op === "**") {
          return `Math.pow(${this.#numberExprAsDouble(expr.left)}, ${this.#numberExprAsDouble(expr.right)})`;
        }
        if (["&", "|", "^", "<<", ">>", ">>>"].includes(expr.op)) {
          const integer = this.#directIntExpr(expr);
          if (integer !== null) return `(double)(${integer})`;
          const signedLeft = this.#toInt32Expr(expr.left);
          const shift = `(${this.#toInt32Expr(expr.right)} & 31)`;
          return `(double)Integer.toUnsignedLong(${signedLeft} >>> ${shift})`;
        }
        if (["+", "-", "*"].includes(expr.op)) {
          const integer = this.#directIntExpr(expr);
          if (integer !== null) return integer;
          return `(${this.#numberExprAsDouble(expr.left)} ${expr.op} ${this.#numberExprAsDouble(expr.right)})`;
        }
        if (expr.op === "/" || expr.op === "%") {
          return `(${this.#numberExprAsDouble(expr.left)} ${expr.op} ${this.#numberExprAsDouble(expr.right)})`;
        }
        const operator = expr.op === "===" ? "==" : expr.op === "!==" ? "!=" : expr.op;
        return `(${left} ${operator} ${right})`;
      }
      case "unary": {
        if (expr.op === "~") throw new JvmUnsupportedError("numeric operator '~'", expr.loc);
        if (
          (expr.op === "!" && expr.operand.type.kind !== "bool") ||
          (expr.op === "-" && expr.operand.type.kind !== "f64")
        ) {
          throw new JvmUnsupportedError(
            `unary operator '${expr.op}' over '${expr.operand.type.kind}'`,
            expr.loc,
          );
        }
        if (expr.op === "-") {
          const integer = this.#directIntExpr(expr);
          return integer ?? `(-${this.#numberExprAsDouble(expr.operand)})`;
        }
        return `(${expr.op}${this.#expr(expr.operand)})`;
      }
      case "toBool": {
        const operand = this.#expr(expr.operand);
        if (expr.operand.type.kind === "f64") {
          const integer = this.#directIntExpr(expr.operand);
          return integer === null ? `ntsToBool(${operand})` : `(${integer} != 0)`;
        }
        if (expr.operand.type.kind === "string") return `!(${operand}).isEmpty()`;
        throw new JvmUnsupportedError(
          `truthiness over '${expr.operand.type.kind}'`,
          expr.loc,
        );
      }
      case "logical":
        if (
          expr.type.kind === "bool" &&
          expr.left.type.kind === "bool" &&
          expr.right.type.kind === "bool"
        ) {
          return `(${this.#expr(expr.left)} ${expr.op} ${this.#expr(expr.right)})`;
        }
        throw new JvmUnsupportedError(
          `value-producing logical '${expr.op}' over '${expr.type.kind}'`,
          expr.loc,
        );
      case "ternary":
        return `(${this.#expr(expr.cond)} ? ${this.#expr(expr.then)} : ${this.#expr(expr.else_)})`;
      case "unionWrap": {
        const nullable = this.#nullableReference(expr.type);
        if (nullable !== null) {
          if (expr.unionId !== nullable.unionId) {
            throw new Error(
              `JVM nullable-reference union '${expr.unionId}' has the wrong type`,
            );
          }
          if (expr.tag === nullable.unitTag) {
            if (
              expr.value.kind !== "unitLit" ||
              expr.value.type.kind !== nullable.unitKind
            ) {
              throw new Error(
                `JVM nullable-reference union '${expr.unionId}' unit arm has a payload`,
              );
            }
            return "null";
          }
          if (
            expr.tag !== nullable.valueTag ||
            typeKey(expr.value.type) !== typeKey(nullable.valueType)
          ) {
            throw new Error(
              `JVM nullable-reference union '${expr.unionId}' received the wrong arm`,
            );
          }
          return this.#expr(expr.value);
        }
        const plan = this.#unionPlan(expr.unionId, expr.loc);
        const arm = plan.definition.arms[expr.tag];
        if (
          expr.type.kind !== "union" ||
          expr.type.unionId !== expr.unionId ||
          arm === undefined ||
          typeKey(arm) !== typeKey(expr.value.type)
        ) {
          throw new Error(`JVM tagged union '${expr.unionId}' received the wrong arm`);
        }
        if (this.#isUnitType(arm)) {
          if (expr.value.kind !== "unitLit") {
            throw new Error(`JVM tagged union '${expr.unionId}' unit arm has a payload`);
          }
          return `${plan.className}.unit${expr.tag}`;
        }
        return `${plan.className}.wrap${expr.tag}(${this.#expr(expr.value)})`;
      }
      case "unionNarrow": {
        const nullable = this.#nullableReference(expr.value.type);
        if (nullable !== null) {
          if (
            expr.unionId !== nullable.unionId ||
            expr.tag !== nullable.valueTag ||
            typeKey(expr.type) !== typeKey(nullable.valueType)
          ) {
            throw new Error(
              `JVM nullable-reference union '${expr.unionId}' narrows the wrong arm`,
            );
          }
          /* The checked IR proves this arm is live. A nullable Java reference
           * carries the same proof without a tag box or ownership operation. */
          return this.#expr(expr.value);
        }
        const plan = this.#unionPlan(expr.unionId, expr.loc);
        const arm = plan.definition.arms[expr.tag];
        if (
          expr.value.type.kind !== "union" ||
          expr.value.type.unionId !== expr.unionId ||
          arm === undefined ||
          this.#isUnitType(arm) ||
          typeKey(arm) !== typeKey(expr.type)
        ) {
          throw new Error(`JVM tagged union '${expr.unionId}' narrows the wrong arm`);
        }
        return `(${this.#expr(expr.value)}).payload${expr.tag}`;
      }
      case "unionIsTag": {
        const nullable = this.#nullableReference(expr.value.type);
        if (nullable !== null) {
          if (
            expr.unionId !== nullable.unionId ||
            (expr.tag !== nullable.valueTag && expr.tag !== nullable.unitTag)
          ) {
            throw new Error(
              `JVM nullable-reference union '${expr.unionId}' tests an unknown arm`,
            );
          }
          const equality = (expr.tag === nullable.unitTag) !== expr.negated;
          return `(${this.#expr(expr.value)} ${equality ? "==" : "!="} null)`;
        }
        const plan = this.#unionPlan(expr.unionId, expr.loc);
        if (
          expr.value.type.kind !== "union" ||
          expr.value.type.unionId !== expr.unionId ||
          plan.definition.arms[expr.tag] === undefined
        ) {
          throw new Error(`JVM tagged union '${expr.unionId}' tests an unknown arm`);
        }
        return `((${this.#expr(expr.value)}).tag ${expr.negated ? "!=" : "=="} ${expr.tag})`;
      }
      case "upcast":
        if (
          expr.value.type.kind === "object" &&
          expr.type.kind === "object"
        ) {
          this.#managedClassName(expr.value.type.className, expr.loc);
          this.#managedClassName(expr.type.className, expr.loc);
          return this.#expr(expr.value);
        }
        if (
          expr.value.type.kind === "nativeHandle" &&
          expr.type.kind === "nativeHandle"
        ) {
          /* Native IR already proves this is an identity edge. Direct JVM
           * references need no ownership or representation operation; leave
           * the value in Java's type system so javac still verifies that the
           * source class is assignable to the target class. */
          this.#nativeHandleOwner(expr.value.type.typeId, expr.loc);
          this.#nativeHandleOwner(expr.type.typeId, expr.loc);
          return this.#expr(expr.value);
        }
        throw new JvmUnsupportedError(
          `upcast from '${expr.value.type.kind}' to '${expr.type.kind}'`,
          expr.loc,
        );
      case "downcast":
        if (
          expr.value.type.kind === "object" &&
          expr.type.kind === "object"
        ) {
          return `((${this.#managedClassName(expr.type.className, expr.loc)})(${this.#expr(expr.value)}))`;
        }
        throw new JvmUnsupportedError(
          `downcast from '${expr.value.type.kind}' to '${expr.type.kind}'`,
          expr.loc,
        );
      case "instanceOf":
        if (expr.value.type.kind === "object") {
          return `(${this.#expr(expr.value)} instanceof ${this.#managedClassName(expr.className, expr.loc)})`;
        }
        throw new JvmUnsupportedError(
          `instanceof over '${expr.value.type.kind}'`,
          expr.loc,
        );
      case "nativePeerAttach":
        return this.#directNativePeerAttach(expr);
      case "nativeCall":
        return this.#nativeCall(expr);
      case "intrinsic": {
        if (
          (expr.name === "console.log" || expr.name === "console.error") &&
          expr.args.length === 1 &&
          expr.args[0]!.type.kind === "string"
        ) {
          const stream = expr.name === "console.log" ? "out" : "err";
          return `System.${stream}.println(${this.#expr(expr.args[0]!)})`;
        }
        throw new JvmUnsupportedError(`intrinsic '${expr.name}'`, expr.loc);
      }
      default:
        throw new JvmUnsupportedError(`expression '${expr.kind}'`, expr.loc);
    }
  }

  #directNativePeerAttach(
    expr: Extract<IrExpr, { kind: "nativePeerAttach" }>,
  ): string {
    const peer = this.#directPeerClass();
    const subclass = this.#directClassCallbacks[0]?.binding;
    if (
      peer === undefined ||
      subclass === undefined ||
      peer.name !== expr.className ||
      expr.type.kind !== "object" ||
      expr.type.className !== peer.name ||
      expr.handle.type.kind !== "nativeHandle" ||
      this.#nativeHandleOwner(expr.handle.type.typeId, expr.loc) !==
        subclass.ownerBinaryName
    ) {
      throw new JvmUnsupportedError(
        `native peer attach for '${expr.className}' outside its direct JVM subclass`,
        expr.loc,
      );
    }
    return `((${this.#options.className})(${this.#expr(expr.handle)})).ntsPeer()`;
  }

  #nativeCall(expr: Extract<IrExpr, { kind: "nativeCall" }>): string {
    if (
      expr.resultMode !== undefined &&
      expr.type.kind !== "nativeHandle" &&
      expr.type.kind !== "string" &&
      !isJvmByteArray(expr.type) &&
      this.#nullableReference(expr.type) === null
    ) {
      throw new JvmUnsupportedError("frame-bounded native call results", expr.loc);
    }
    const cancellation = this.#directCancellationBindings.get(expr.binding);
    if (cancellation !== undefined) {
      return this.#directCancellation(expr, cancellation);
    }
    const direct = this.#jvmNativeBindings.get(expr.binding);
    if (direct === undefined) {
      throw new JvmUnsupportedError(
        `native binding '${expr.binding}' without JVM coordinates`,
        expr.loc,
      );
    }
    const semantic = this.#irNativeBindings.get(expr.binding);
    if (semantic === undefined) {
      throw new Error(`JVM direct binding '${expr.binding}' has no Native IR binding`);
    }
    if (semantic.entry.symbol !== direct.nativeEntrySymbol) {
      throw new Error(
        `JVM direct binding '${expr.binding}' names native entry ` +
          `'${direct.nativeEntrySymbol}', but Native IR names ` +
          `'${semantic.entry.symbol}'`,
      );
    }
    if (direct.kind === "class-callback") {
      return this.#directClassCallback(expr, direct, semantic);
    }
    if (direct.kind === "instance-callback") {
      return this.#directCallback(expr, direct, semantic);
    }
    const descriptor = parseJvmMethodDescriptor(direct.descriptor);
    const receiverCount = direct.kind === "instance-method" ? 1 : 0;
    if (descriptor.parameters.length + receiverCount !== expr.args.length) {
      throw new Error(
        `JVM direct binding '${expr.binding}' descriptor takes ` +
          `${descriptor.parameters.length} arguments${receiverCount === 0 ? "" : " plus a receiver"}, ` +
          `but IR supplies ${expr.args.length}`,
      );
    }
    if (!this.#directResultMatches(
      expr.type,
      descriptor.result,
      direct.kind,
      expr.loc,
    )) {
      throw new Error(
        `JVM direct binding '${expr.binding}' result '${descriptor.result}' ` +
          `does not implement IR type '${expr.type.kind}'`,
      );
    }
    const args = expr.args.slice(receiverCount).map((arg, index) =>
      this.#directArgument(arg, descriptor.parameters[index]!)
    ).join(", ");
    const owner = this.#directOwnerType(direct.ownerBinaryName);
    if (direct.kind === "constructor") {
      if (expr.type.kind !== "nativeHandle") {
        throw new Error(`JVM constructor binding '${expr.binding}' has a non-handle IR result`);
      }
      const resultOwner = this.#nativeHandleOwner(expr.type.typeId, expr.loc);
      if (resultOwner !== direct.ownerBinaryName) {
        throw new Error(
          `JVM constructor binding '${expr.binding}' constructs '${direct.ownerBinaryName}', ` +
          `but Native IR returns '${resultOwner}'`,
        );
      }
      return `new ${owner}(${args})`;
    }
    assertJavaIdentifier(direct.name, "direct method name");
    if (direct.kind === "instance-method") {
      const receiver = expr.args[0]!;
      if (receiver.type.kind !== "nativeHandle") {
        throw new Error(`JVM instance binding '${expr.binding}' has a non-handle receiver`);
      }
      return `(${this.#expr(receiver)}).${direct.name}(${args})`;
    }
    return `${owner}.${direct.name}(${args})`;
  }

  #directClassCallback(
    expr: Extract<IrExpr, { kind: "nativeCall" }>,
    direct: JvmDirectClassCallbackBinding,
    semantic: IrNativeBinding,
  ): string {
    const plan = this.#directClassCallbacks.find(
      ({ binding }) => binding.id === direct.id,
    );
    if (plan === undefined) {
      throw new Error(`JVM direct class callback '${direct.id}' has no emission plan`);
    }
    if (expr.args.length !== 1 || expr.type.kind !== "void") {
      throw new Error(
        `JVM direct class callback '${direct.id}' is not a void registration over one handler`,
      );
    }
    if (semantic.result.type.kind !== "void") {
      throw new Error(`JVM direct class callback '${direct.id}' has a non-void registration`);
    }
    const closure = expr.args[0]!;
    if (closure.kind !== "closure") {
      throw new JvmUnsupportedError(
        `non-literal direct class callback '${direct.id}'`,
        closure.loc,
      );
    }
    if (closure.captures.length !== 0) {
      throw new Error(
        `JVM direct class callback '${direct.id}' unexpectedly captures module initialization`,
      );
    }
    const handler = this.#functions.get(closure.fnName);
    if (handler === undefined) {
      throw new Error(
        `JVM direct class callback '${direct.id}' names missing handler '${closure.fnName}'`,
      );
    }
    if ((handler.captures?.length ?? 0) !== 0) {
      throw new Error(`JVM direct class callback '${direct.id}' handler is not capture-free`);
    }
    if (handler.params.length !== plan.descriptor.parameters.length + 1) {
      throw new Error(
        `JVM direct class callback '${direct.id}' handler does not receive its exact receiver and payloads`,
      );
    }
    const receiver = handler.params[0]!;
    if (
      receiver.type.kind !== "nativeHandle" ||
      this.#nativeHandleOwner(receiver.type.typeId, handler.loc) !== direct.ownerBinaryName
    ) {
      throw new Error(`JVM direct class callback '${direct.id}' has the wrong receiver`);
    }
    handler.params.slice(1).forEach((parameter, index) => {
      if (!this.#directValueMatches(
        parameter.type,
        plan.descriptor.parameters[index]!,
        handler.loc,
      )) {
        throw new Error(
          `JVM direct class callback '${direct.id}' payload ${index} does not match ` +
            `'${plan.descriptor.parameters[index]}'`,
        );
      }
    });
    if (!this.#directValueMatches(handler.returnType, plan.descriptor.result, handler.loc)) {
      throw new Error(
        `JVM direct class callback '${direct.id}' result does not match ` +
          `'${plan.descriptor.result}'`,
      );
    }
    if (this.#directClassCallbackSites.some(
      (site) => site.callback.binding.id === direct.id,
    )) {
      throw new Error(`JVM direct class callback '${direct.id}' is registered twice`);
    }
    const site = Object.freeze({
      callback: plan,
      index: this.#directClassCallbackSites.length,
      handlerName: encodedIdentifier("f", handler.name),
    });
    this.#directClassCallbackSites.push(site);
    return `ntsRegisterClassCallback${site.index}()`;
  }

  #directCallback(
    expr: Extract<IrExpr, { kind: "nativeCall" }>,
    direct: JvmDirectCallbackBinding,
    semantic: IrNativeBinding,
  ): string {
    const plan = this.#directCallbacks.find(({ binding }) => binding.id === direct.id);
    if (plan === undefined) {
      throw new Error(`JVM direct callback '${direct.id}' has no emission plan`);
    }
    if (expr.args.length !== 2) {
      throw new JvmUnsupportedError(
        `direct callback '${direct.id}' with ${expr.args.length - 1} handler values`,
        expr.loc,
      );
    }
    const receiver = expr.args[0]!;
    if (receiver.type.kind !== "nativeHandle") {
      throw new Error(`JVM direct callback '${direct.id}' has a non-handle receiver`);
    }
    const receiverOwner = this.#nativeHandleOwner(receiver.type.typeId, receiver.loc);
    if (receiverOwner !== direct.ownerBinaryName) {
      throw new Error(
        `JVM direct callback '${direct.id}' registers on '${receiverOwner}', ` +
          `not '${direct.ownerBinaryName}'`,
      );
    }
    if (
      expr.type.kind !== "nativeHandle" ||
      !this.#directConnectionTypeIds.has(expr.type.typeId) ||
      semantic.result.type.kind !== "nativeHandle" ||
      semantic.result.type.typeId !== expr.type.typeId
    ) {
      throw new Error(`JVM direct callback '${direct.id}' has no exact connection result`);
    }
    const closure = expr.args[1]!;
    if (closure.kind !== "closure") {
      throw new JvmUnsupportedError("non-literal direct JVM callback values", closure.loc);
    }
    const handler = this.#functions.get(closure.fnName);
    if (handler === undefined) {
      throw new Error(
        `JVM direct callback '${direct.id}' names missing handler '${closure.fnName}'`,
      );
    }
    if (closure.captures.length !== (handler.captures?.length ?? 0)) {
      throw new Error(
        `JVM direct callback '${direct.id}' closure capture count does not match its handler`,
      );
    }
    if (
      handler.returnType.kind !== "void" ||
      plan.descriptor.result !== "V" ||
      handler.params.length !== plan.descriptor.parameters.length
    ) {
      throw new Error(
        `JVM direct callback '${direct.id}' handler does not match '${direct.descriptor}'`,
      );
    }
    handler.params.forEach((parameter, index) => {
      if (!this.#directValueMatches(
        parameter.type,
        plan.descriptor.parameters[index]!,
        closure.loc,
      )) {
        throw new Error(
          `JVM direct callback '${direct.id}' payload ${index} does not match ` +
            `'${plan.descriptor.parameters[index]}'`,
        );
      }
    });
    const creator = this.#currentFunction;
    if (creator === null) {
      throw new Error(`JVM direct callback '${direct.id}' has no creating function`);
    }
    const siteIndex = this.#directCallbackSites.length;
    const captures = closure.captures.map((id, captureIndex) => {
      const local = this.#local(creator, id, closure.loc);
      return Object.freeze({
        fieldName: `ntsCapture${siteIndex}_${captureIndex}`,
        javaType: this.#storageJavaType(local, closure.loc),
        argument: this.#captureBinding(id, closure.loc),
        clearOnCancel: this.#isMutableBox(local) ||
          this.#boxKind(local.type, closure.loc) === "reference",
      });
    });
    const site = Object.freeze({
      callback: plan,
      index: siteIndex,
      registerName: `ntsRegister${siteIndex}`,
      handlerName: encodedIdentifier("f", handler.name),
      captures: Object.freeze(captures),
    });
    this.#directCallbackSites.push(site);
    return this.#renderDirectCallbackSite(expr, site);
  }

  #renderDirectCallbackSite(
    expr: Extract<IrExpr, { kind: "nativeCall" }>,
    site: JvmDirectCallbackSitePlan,
  ): string {
    return `(${this.#expr(expr.args[0]!)}).${site.registerName}(` +
      `${site.captures.map(({ argument }) => argument).join(", ")})`;
  }

  #directCancellation(
    expr: Extract<IrExpr, { kind: "nativeCall" }>,
    cancellation: {
      readonly nativeEntrySymbol: string;
      readonly connectionTypeId: string;
    },
  ): string {
    const semantic = this.#irNativeBindings.get(expr.binding);
    if (semantic === undefined) {
      throw new Error(`JVM direct cancellation '${expr.binding}' has no Native IR binding`);
    }
    if (semantic.entry.symbol !== cancellation.nativeEntrySymbol) {
      throw new Error(
        `JVM direct cancellation '${expr.binding}' names native entry ` +
          `'${cancellation.nativeEntrySymbol}', but Native IR names ` +
          `'${semantic.entry.symbol}'`,
      );
    }
    if (
      expr.args.length !== 1 ||
      expr.args[0]!.type.kind !== "nativeHandle" ||
      expr.args[0]!.type.typeId !== cancellation.connectionTypeId ||
      expr.type.kind !== "void"
    ) {
      throw new Error(`JVM direct cancellation '${expr.binding}' has the wrong IR shape`);
    }
    return `(${this.#expr(expr.args[0]!)}).disconnect()`;
  }

  #directResultMatches(
    type: IrType,
    descriptor: string,
    kind: JvmDirectBinding["kind"],
    loc: SrcLoc,
  ): boolean {
    if (kind === "constructor") return type.kind === "nativeHandle" && descriptor === "V";
    if (kind === "instance-callback") return false;
    return this.#directValueMatches(type, descriptor, loc);
  }

  #directValueMatches(
    type: IrType,
    descriptor: string,
    loc: SrcLoc,
  ): boolean {
    if (type.kind === "bool") return descriptor === "Z";
    if (type.kind === "void") return descriptor === "V";
    if (type.kind === "f64") return "BCSIFD".includes(descriptor);
    if (type.kind === "nativeScalar") {
      return type.scalar === "i64" && descriptor === "J";
    }
    if (type.kind === "string") return descriptor === "Ljava/lang/String;";
    if (isJvmByteArray(type)) return descriptor === "[B";
    if (type.kind === "nativeHandle") {
      return descriptor === `L${this.#nativeHandleOwner(type.typeId, loc)};`;
    }
    const nullable = this.#nullableReference(type);
    if (nullable !== null) {
      if (nullable.unitKind !== "nullT") return false;
      if (nullable.valueType.kind === "string") {
        return descriptor === "Ljava/lang/String;";
      }
      if (nullable.valueType.kind === "nativeHandle") {
        return descriptor ===
          `L${this.#nativeHandleOwner(nullable.valueType.typeId, loc)};`;
      }
      return false;
    }
    return false;
  }

  #directArgument(expr: IrExpr, descriptor: string): string {
    if (expr.kind === "unionWrap") {
      if (!this.#directValueMatches(expr.type, descriptor, expr.loc)) {
        throw new JvmUnsupportedError(
          `direct '${descriptor}' argument from union '${expr.unionId}'`,
          expr.loc,
        );
      }
      return expr.value.kind === "unitLit" ? "null" : this.#directArgument(expr.value, descriptor);
    }
    if (expr.kind === "unitLit") return "null";
    if (descriptor.startsWith("[")) {
      if (descriptor !== "[B" || !isJvmByteArray(expr.type)) {
        throw new JvmUnsupportedError(
          `direct array '${descriptor}' from '${expr.type.kind}'`,
          expr.loc,
        );
      }
      return this.#expr(expr);
    }
    if (descriptor.startsWith("L")) {
      if (
        expr.type.kind !== "string" &&
        expr.type.kind !== "nativeHandle" &&
        !this.#directValueMatches(expr.type, descriptor, expr.loc)
      ) {
        throw new JvmUnsupportedError(
          `direct reference argument from '${expr.type.kind}'`,
          expr.loc,
        );
      }
      return this.#expr(expr);
    }
    if (descriptor === "Z" && expr.type.kind === "bool") return this.#expr(expr);
    if (
      descriptor === "J" &&
      expr.type.kind === "nativeScalar" &&
      expr.type.scalar === "i64"
    ) {
      return this.#expr(expr);
    }
    if (expr.type.kind !== "f64") {
      throw new JvmUnsupportedError(
        `direct scalar '${descriptor}' from '${expr.type.kind}'`,
        expr.loc,
      );
    }
    const value = this.#expr(expr);
    const integer = this.#directIntExpr(expr);
    switch (descriptor) {
      case "B": return integer === null ? `(byte)ntsToInt32(${value})` : `(byte)(${integer})`;
      case "C": return `(char)ntsToUint32(${value})`;
      case "S": return integer === null ? `(short)ntsToInt32(${value})` : `(short)(${integer})`;
      case "I": return integer ?? `ntsToInt32(${value})`;
      case "F": return `(float)(${integer ?? value})`;
      case "D": return value;
      default:
        throw new JvmUnsupportedError(`direct scalar descriptor '${descriptor}'`, expr.loc);
    }
  }

  /** A Java int spelling is admitted only when the shared abstract
   * interpreter proved this expression is an exact signed int32 and cannot
   * be -0. Returning null preserves the ordinary f64 implementation. */
  #directIntExpr(expr: IrExpr): string | null {
    switch (expr.kind) {
      case "numLit":
        return Number.isInteger(expr.value) &&
            !Object.is(expr.value, -0) &&
            expr.value >= -(2 ** 31) &&
            expr.value <= 2 ** 31 - 1
          ? String(expr.value)
          : null;
      case "varRef":
        return this.#integerBinding(expr.localId)
          ? this.#binding(expr.localId)
          : null;
      case "fieldGet":
        return this.#integerField(expr.className, expr.field)
          ? this.#expr(expr)
          : null;
      case "call":
        return this.#machineIntegers.returns.has(expr.callee)
          ? this.#expr(expr)
          : null;
      case "virtualCall":
        return this.#machineIntegers.methods.has(
            machineIntegerMethodKey(expr.className, expr.method)
          )
          ? this.#expr(expr)
          : null;
      case "bin": {
        if (["&", "|", "^", "<<", ">>"].includes(expr.op)) {
          const left = this.#toInt32Expr(expr.left);
          const right = this.#toInt32Expr(expr.right);
          const shift = `(${right} & 31)`;
          switch (expr.op) {
            case "&": return `(${left} & ${right})`;
            case "|": return `(${left} | ${right})`;
            case "^": return `(${left} ^ ${right})`;
            case "<<": return `(${left} << ${shift})`;
            case ">>": return `(${left} >> ${shift})`;
            default: throw new Error("unreachable JVM signed bitwise operator");
          }
        }
        if (!this.#machineIntegers.expressions.has(expr)) return null;
        if (expr.op === ">>>") {
          return `(${this.#toInt32Expr(expr.left)} >>> (${this.#toInt32Expr(expr.right)} & 31))`;
        }
        if (expr.op !== "+" && expr.op !== "-" && expr.op !== "*") return null;
        const left = this.#directIntExpr(expr.left);
        const right = this.#directIntExpr(expr.right);
        return left === null || right === null
          ? null
          : `(${left} ${expr.op} ${right})`;
      }
      case "unary": {
        if (expr.op !== "-" || !this.#machineIntegers.expressions.has(expr)) return null;
        const operand = this.#directIntExpr(expr.operand);
        return operand === null ? null : `(-${operand})`;
      }
      case "ternary": {
        if (!this.#machineIntegers.expressions.has(expr)) return null;
        const then = this.#directIntExpr(expr.then);
        const else_ = this.#directIntExpr(expr.else_);
        return then === null || else_ === null
          ? null
          : `(${this.#expr(expr.cond)} ? ${then} : ${else_})`;
      }
      default:
        return null;
    }
  }

  #intExpr(expr: IrExpr): string {
    return this.#directIntExpr(expr) ?? `(int)(${this.#expr(expr)})`;
  }

  #toInt32Expr(expr: IrExpr): string {
    /* JavaScript's unsigned right shift returns a Number in 0..2^32-1,
     * which cannot generally stay in a Java int when observed as a Number.
     * When a surrounding bitwise operator immediately applies ToInt32,
     * however, the signed Java int carrying the same 32 bits is already the
     * exact result. Keep that conversion in the integer domain instead of
     * widening through unsigned long/double and calling the generic helper. */
    if (expr.kind === "bin" && expr.op === ">>>") {
      return `(${this.#toInt32Expr(expr.left)} >>> (${this.#toInt32Expr(expr.right)} & 31))`;
    }
    return this.#directIntExpr(expr) ?? `ntsToInt32(${this.#expr(expr)})`;
  }

  #numberExprAsDouble(expr: IrExpr): string {
    const integer = this.#directIntExpr(expr);
    return integer === null ? this.#expr(expr) : `(double)(${integer})`;
  }

  #binding(id: string): string {
    const binding = id.startsWith("%g.")
      ? encodedIdentifier("g", id)
      : encodedIdentifier("l", id);
    return this.#mutableBoxedLocals.has(id) ? `${binding}.value` : binding;
  }

  #captureBinding(id: string, loc: SrcLoc): string {
    const fn = this.#currentFunction;
    if (fn === null) {
      throw new Error("JVM direct callback capture has no creating function");
    }
    const local = this.#local(fn, id, loc);
    if (local.boxed !== true) {
      throw new Error(`JVM direct callback capture '${id}' is not a boxed local`);
    }
    return encodedIdentifier("l", id);
  }

  #integerBinding(id: string): boolean {
    return this.#integerLocals.has(id) || this.#machineIntegers.globals.has(id);
  }

  #javaType(type: IrType, loc: SrcLoc): string {
    if (type.kind === "array") {
      return this.#arrayClassName(type, loc);
    }
    if (type.kind === "func") {
      return this.#functionInterfaceName(type, loc);
    }
    if (type.kind === "object") {
      return this.#managedClassName(type.className, loc);
    }
    if (type.kind === "record") {
      return this.#recordPlan(type.shapeId, loc).className;
    }
    if (type.kind === "nativeHandle") {
      return this.#javaHandleType(type.typeId, loc);
    }
    const nullable = this.#nullableReference(type);
    if (nullable !== null) {
      /* Java references already carry null. For internal values the same
       * bit pattern represents either null or undefined because the union
       * has exactly one unit arm, so the missing-value distinction remains
       * exact without a tag object. Platform boundaries still admit only a
       * declared null arm; undefined is never silently projected to JNI. */
      return this.#javaType(nullable.valueType, loc);
    }
    if (type.kind === "union") {
      return this.#unionPlan(type.unionId, loc).className;
    }
    return scalarJavaType(type, loc);
  }

  #arrayClassName(
    type: Extract<IrType, { readonly kind: "array" }>,
    loc: SrcLoc,
  ): string {
    const plan = this.#arrayTypes.get(typeKey(type));
    if (plan === undefined) {
      throw new JvmUnsupportedError(
        `unplanned array type '${typeKey(type)}'`,
        loc,
      );
    }
    return plan.className;
  }

  #functionInterfaceName(
    type: Extract<IrType, { readonly kind: "func" }>,
    loc: SrcLoc,
  ): string {
    const plan = this.#functionTypes.get(typeKey(type));
    if (plan === undefined) {
      throw new JvmUnsupportedError(
        `unplanned function type '${typeKey(type)}'`,
        loc,
      );
    }
    return plan.interfaceName;
  }

  #recordPlan(shapeId: string, loc: SrcLoc): JvmRecordPlan {
    const plan = this.#recordTypes.get(shapeId);
    if (plan === undefined) {
      throw new JvmUnsupportedError(`unknown record shape '${shapeId}'`, loc);
    }
    return plan;
  }

  #recordFieldName(field: string): string {
    return encodedIdentifier("r", field);
  }

  #unionPlan(unionId: string, loc: SrcLoc): JvmUnionPlan {
    const plan = this.#unionTypes.get(unionId);
    if (plan === undefined) {
      throw new JvmUnsupportedError(`unknown union '${unionId}'`, loc);
    }
    return plan;
  }

  #isMutableBox(local: IrFunction["locals"][number]): boolean {
    return local.boxed === true && local.mutable;
  }

  #boxKind(type: IrType, loc: SrcLoc): "boolean" | "double" | "long" | "reference" {
    if (type.kind === "f64") return "double";
    if (type.kind === "bool") return "boolean";
    if (type.kind === "nativeScalar" && type.scalar === "i64") return "long";
    const javaType = this.#javaType(type, loc);
    if (javaType === "void" || javaType === "double" || javaType === "boolean") {
      throw new JvmUnsupportedError(`mutable capture type '${type.kind}'`, loc);
    }
    return "reference";
  }

  #boxJavaType(type: IrType, loc: SrcLoc): string {
    switch (this.#boxKind(type, loc)) {
      case "double": return "NtsDoubleBox";
      case "boolean": return "NtsBooleanBox";
      case "long": return "NtsLongBox";
      case "reference": return `NtsReferenceBox<${this.#javaType(type, loc)}>`;
    }
  }

  #storageJavaType(
    local: IrFunction["locals"][number],
    loc: SrcLoc,
  ): string {
    return this.#isMutableBox(local)
      ? this.#boxJavaType(local.type, loc)
      : this.#javaType(local.type, loc);
  }

  #defaultJavaValue(type: IrType, loc: SrcLoc): string {
    switch (this.#boxKind(type, loc)) {
      case "double": return "0.0d";
      case "boolean": return "false";
      case "long": return "0L";
      case "reference": return "null";
    }
  }

  #javaHandleType(typeId: string, loc: SrcLoc): string {
    if (this.#directConnectionTypeIds.has(typeId)) return "NtsConnection";
    return this.#directOwnerType(this.#nativeHandleOwner(typeId, loc));
  }

  #directOwnerType(ownerBinaryName: string): string {
    return this.#directCallbackByOwner.get(ownerBinaryName)?.adapterName ??
      javaOwner(ownerBinaryName);
  }

  #isUnitType(type: IrType): type is Extract<
    IrType,
    { readonly kind: "nullT" | "undefinedT" }
  > {
    return type.kind === "nullT" || type.kind === "undefinedT";
  }

  #isDirectReferenceType(type: IrType): boolean {
    switch (type.kind) {
      case "string":
      case "array":
      case "object":
      case "record":
      case "nativeHandle":
        return true;
      case "bytes":
        return type.elem === "u8";
      default:
        return false;
    }
  }

  #nullableReference(type: IrType): JvmNullableReference | null {
    if (type.kind !== "union") return null;
    const definition = this.#unionTypes.get(type.unionId)?.definition;
    if (definition === undefined || definition.arms.length !== 2) return null;
    const valueTag = definition.arms.findIndex((arm) =>
      this.#isDirectReferenceType(arm)
    );
    const unitTag = definition.arms.findIndex((arm) => this.#isUnitType(arm));
    if (valueTag < 0 || unitTag < 0) return null;
    const unit = definition.arms[unitTag]!;
    return {
      unionId: type.unionId,
      valueTag,
      unitTag,
      unitKind: unit.kind as "nullT" | "undefinedT",
      valueType: definition.arms[valueTag]!,
    };
  }

  #nativeHandleOwner(typeId: string, loc: SrcLoc): string {
    const definition = this.#nativeTypes.get(typeId);
    if (definition?.kind !== "handle") {
      throw new JvmUnsupportedError(`native handle type '${typeId}'`, loc);
    }
    const owner = definition.nativeName;
    if (owner === "jobject") {
      throw new JvmUnsupportedError(
        `native handle type '${typeId}' without concrete JVM class coordinates`,
        loc,
      );
    }
    javaOwner(owner);
    return owner;
  }

  #managedClassName(className: string, loc: SrcLoc): string {
    if (!this.#classes.has(className)) {
      throw new JvmUnsupportedError(`managed class '${className}'`, loc);
    }
    if (this.#directPeerClass()?.name === className) {
      return this.#options.className;
    }
    return encodedIdentifier("c", className);
  }

  #managedFieldName(field: string): string {
    return encodedIdentifier("d", field);
  }

  #integerField(className: string, field: string): boolean {
    return this.#machineIntegers.fields.has(
      machineIntegerFieldKey(className, field),
    );
  }

  #managedMethodName(method: string): string {
    return encodedIdentifier("m", method);
  }

  #managedNewName(className: string): string {
    return encodedIdentifier("n", className);
  }

  #local(fn: IrFunction, id: string, loc: SrcLoc): IrFunction["locals"][number] {
    const local = fn.locals.find((candidate) => candidate.id === id);
    if (local !== undefined) return local;
    throw new JvmUnsupportedError(`unknown local '${id}'`, loc);
  }
}

/** Emit a readable Java translation unit from validated ScriptC IR. */
export function emitJvmModule(module: IrModule, options: JvmEmissionOptions): string {
  validateOptions(options);
  const diagnostics = validateModule(module);
  if (diagnostics.length > 0) {
    throw new Error(
      `ScriptC JVM emission received invalid IR\n${diagnostics.map(({ message }) => message).join("\n")}`,
    );
  }
  return new JavaEmitter(module, options).emit();
}

/**
 * Materialization boundary for embedders: the checked, versioned IR payload
 * in an ordinary ScriptC compilation plan is the JVM backend's only semantic
 * input. javac/D8 are target build mechanics downstream of this function.
 */
export function emitJvmSerializedModule(
  serializedIr: string,
  options: JvmEmissionOptions,
): string {
  return emitJvmModule(deserializeModule(serializedIr), options);
}
