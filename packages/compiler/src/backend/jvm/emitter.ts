import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrModule,
  IrNativeBinding,
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
import { nullableNativeHandleUnion } from "../../ir/nodes.js";
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
  prefix: "c" | "d" | "f" | "g" | "l" | "m" | "n",
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

interface JvmMethodDescriptor {
  readonly parameters: readonly string[];
  readonly result: string;
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

  #emitBoxSupport(): string[] {
    const kinds = new Set<"boolean" | "double" | "reference">();
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
        !isJvmByteArray(local.type) &&
        this.#nullableHandle(local.type) === null
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

  #expr(expr: IrExpr): string {
    switch (expr.kind) {
      case "numLit": return numberLiteral(expr.value);
      case "boolLit": return expr.value ? "true" : "false";
      case "strLit": return javaString(expr.value);
      case "strIntrinsic": {
        if (
          expr.method !== "length" ||
          expr.receiver.type.kind !== "string" ||
          expr.args.length !== 0 ||
          expr.type.kind !== "f64"
        ) {
          throw new JvmUnsupportedError(
            `string intrinsic '${expr.method}'`,
            expr.loc,
          );
        }
        /* A ScriptC string is already java.lang.String in this backend.
         * Java length() and JavaScript length both count UTF-16 code units,
         * so no encoding bridge or temporary representation is needed. */
        return `(double)((${this.#expr(expr.receiver)}).length())`;
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
      case "ternary":
        return `(${this.#expr(expr.cond)} ? ${this.#expr(expr.then)} : ${this.#expr(expr.else_)})`;
      case "unionWrap": {
        const nullable = this.#nullableHandle(expr.type);
        if (nullable === null || expr.unionId !== nullable.unionId) {
          throw new JvmUnsupportedError("non-nullable-handle union construction", expr.loc);
        }
        if (expr.tag === nullable.nullTag) {
          if (expr.value.kind !== "unitLit" || expr.value.type.kind !== "nullT") {
            throw new Error(
              `JVM nullable-handle union '${expr.unionId}' null arm has a payload`,
            );
          }
          return "null";
        }
        if (
          expr.tag !== nullable.handleTag ||
          expr.value.type.kind !== "nativeHandle" ||
          expr.value.type.typeId !== nullable.typeId
        ) {
          throw new Error(
            `JVM nullable-handle union '${expr.unionId}' received the wrong arm`,
          );
        }
        return this.#expr(expr.value);
      }
      case "unionNarrow": {
        const nullable = this.#nullableHandle(expr.value.type);
        if (
          nullable === null ||
          expr.unionId !== nullable.unionId ||
          expr.tag !== nullable.handleTag ||
          expr.type.kind !== "nativeHandle" ||
          expr.type.typeId !== nullable.typeId
        ) {
          throw new JvmUnsupportedError("non-nullable-handle union narrowing", expr.loc);
        }
        /* The checked IR proves this arm is live. A nullable Java reference
         * carries the same proof without a tag box or ownership operation. */
        return this.#expr(expr.value);
      }
      case "unionIsTag": {
        const nullable = this.#nullableHandle(expr.value.type);
        if (
          nullable === null ||
          expr.unionId !== nullable.unionId ||
          (expr.tag !== nullable.handleTag && expr.tag !== nullable.nullTag)
        ) {
          throw new JvmUnsupportedError("non-nullable-handle union tag tests", expr.loc);
        }
        const equality = (expr.tag === nullable.nullTag) !== expr.negated;
        return `(${this.#expr(expr.value)} ${equality ? "==" : "!="} null)`;
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
      !isJvmByteArray(expr.type) &&
      this.#nullableHandle(expr.type) === null
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
    if (type.kind === "string") return descriptor === "Ljava/lang/String;";
    if (isJvmByteArray(type)) return descriptor === "[B";
    if (type.kind === "nativeHandle") {
      return descriptor === `L${this.#nativeHandleOwner(type.typeId, loc)};`;
    }
    const nullable = this.#nullableHandle(type);
    if (nullable !== null) {
      return descriptor === `L${this.#nativeHandleOwner(nullable.typeId, loc)};`;
    }
    return false;
  }

  #directArgument(expr: IrExpr, descriptor: string): string {
    if (expr.kind === "unionWrap") {
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
        this.#nullableHandle(expr.type) === null
      ) {
        throw new JvmUnsupportedError(
          `direct reference argument from '${expr.type.kind}'`,
          expr.loc,
        );
      }
      return this.#expr(expr);
    }
    if (descriptor === "Z" && expr.type.kind === "bool") return this.#expr(expr);
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
    if (type.kind === "object") {
      return this.#managedClassName(type.className, loc);
    }
    if (type.kind === "nativeHandle") {
      return this.#javaHandleType(type.typeId, loc);
    }
    const nullable = this.#nullableHandle(type);
    if (nullable !== null) {
      /* Java references already carry null. Keeping T | null unboxed is
       * both the exact representation and what lets javac verify uses. */
      return this.#javaHandleType(nullable.typeId, loc);
    }
    return scalarJavaType(type, loc);
  }

  #isMutableBox(local: IrFunction["locals"][number]): boolean {
    return local.boxed === true && local.mutable;
  }

  #boxKind(type: IrType, loc: SrcLoc): "boolean" | "double" | "reference" {
    if (type.kind === "f64") return "double";
    if (type.kind === "bool") return "boolean";
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

  #nullableHandle(type: IrType): {
    unionId: string;
    typeId: string;
    handleTag: number;
    nullTag: number;
  } | null {
    if (type.kind !== "union") return null;
    const definition = this.#module.unions?.find(
      (candidate) => candidate.id === type.unionId,
    );
    if (definition === undefined || definition.arms.length !== 2) return null;
    const handle = definition.arms.find(
      (arm): arm is Extract<IrType, { kind: "nativeHandle" }> =>
        arm.kind === "nativeHandle",
    );
    if (handle === undefined) return null;
    const nullable = nullableNativeHandleUnion(
      this.#module.unions ?? [],
      handle.typeId,
    );
    return nullable?.unionId === type.unionId
      ? { ...nullable, typeId: handle.typeId }
      : null;
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
