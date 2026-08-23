import type {
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
  machineIntegerFacts,
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
    };

type JvmDirectCallbackBinding = Extract<
  JvmDirectBinding,
  { readonly kind: "instance-callback" }
>;

interface JvmDirectCallbackPlan {
  readonly binding: JvmDirectCallbackBinding;
  readonly handlerName: string;
  readonly adapterName: string;
  readonly descriptor: JvmMethodDescriptor;
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
function encodedIdentifier(prefix: "f" | "g" | "l", value: string): string {
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
  readonly #nativeTypes: ReadonlyMap<string, NonNullable<IrModule["nativeTypes"]>[number]>;
  readonly #irNativeBindings: ReadonlyMap<string, IrNativeBinding>;
  readonly #jvmNativeBindings: ReadonlyMap<string, JvmDirectBinding>;
  readonly #directCallbacks: readonly JvmDirectCallbackPlan[];
  readonly #directCallbackByOwner: ReadonlyMap<string, JvmDirectCallbackPlan>;
  readonly #directCancellationBindings: ReadonlyMap<string, {
    readonly nativeEntrySymbol: string;
    readonly connectionTypeId: string;
  }>;
  readonly #directConnectionTypeIds: ReadonlySet<string>;
  readonly #machineIntegers: MachineIntegerFacts;
  #integerLocals: ReadonlySet<string> = new Set();

  constructor(module: IrModule, options: JvmEmissionOptions) {
    this.#module = module;
    this.#options = options;
    this.#functions = new Map(module.functions.map((fn) => [fn.name, fn]));
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
          handlerName: `NtsCallback${index}`,
          adapterName: `NtsCallbackAdapter${index}`,
          descriptor: parseJvmMethodDescriptor(binding.descriptor),
        })),
    );
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
    lines.push(`public final class ${this.#options.className} {`);
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

    lines.push(...this.#emitDirectCallbackSupport());

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
      assertJavaIdentifier(callback.binding.name, "direct callback name");
      lines.push(
        `  private interface ${callback.handlerName} {`,
        `    void invoke(${parameters.join(", ")});`,
        "  }",
        "",
        `  private static final class ${callback.adapterName} implements ${interfaceName} {`,
        `    private ${callback.handlerName} ntsHandler;`,
        "",
        `    private NtsConnection ntsRegister(${callback.handlerName} handler) {`,
        "      if (handler == null) throw new NullPointerException(\"callback\");",
        "      if (this.ntsHandler != null) {",
        `        throw new IllegalStateException(${javaString(
          `A callback is already registered for ${callback.binding.ownerBinaryName}.${callback.binding.name}`,
        )});`,
        "      }",
        "      this.ntsHandler = handler;",
        "      return new NtsConnection(() -> {",
        "        if (this.ntsHandler == handler) this.ntsHandler = null;",
        "      });",
        "    }",
        "",
        "    @Override",
        `    public void ${callback.binding.name}(${parameters.join(", ")}) {`,
        `      ${callback.handlerName} handler = this.ntsHandler;`,
        "      if (handler == null) {",
        `        throw new IllegalStateException(${javaString(
          `No callback is registered for ${callback.binding.ownerBinaryName}.${callback.binding.name}`,
        )});`,
        "      }",
        `      handler.invoke(${arguments_.join(", ")});`,
        "    }",
        "  }",
        "",
      );
    }
    return lines;
  }

  #emitFunction(fn: IrFunction): string[] {
    if (fn.async === true) throw new JvmUnsupportedError("async functions", fn.loc);
    if (fn.generator !== undefined) throw new JvmUnsupportedError("generator functions", fn.loc);
    if ((fn.captures?.length ?? 0) !== 0) throw new JvmUnsupportedError("capturing functions", fn.loc);
    for (const local of fn.locals) {
      if (local.boxed === true) throw new JvmUnsupportedError("boxed locals", fn.loc);
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
    const params = fn.params.map((param) =>
      `${this.#javaType(param.type, fn.loc)} ${encodedIdentifier("l", param.localId)}`
    ).join(", ");
    const lines = [
      `  private static ${this.#javaType(fn.returnType, fn.loc)} ${encodedIdentifier("f", fn.name)}(${params}) {`,
    ];
    for (const stmt of fn.body) lines.push(...this.#stmt(fn, stmt, 2));
    lines.push("  }");
    return lines;
  }

  #stmt(fn: IrFunction, stmt: IrStmt, depth: number): string[] {
    const pad = "  ".repeat(depth);
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.#local(fn, stmt.localId, stmt.loc);
        const integer = this.#integerBinding(local.id);
        const init = stmt.init === null
          ? ""
          : ` = ${integer ? this.#intExpr(stmt.init) : this.#expr(stmt.init)}`;
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
      case "exprStmt":
        return [`${pad}${this.#expr(stmt.expr)};`];
      case "return":
        return [`${pad}return${stmt.value === null ? "" : ` ${this.#expr(stmt.value)}`};`];
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
    if (closure.kind !== "closure" || closure.captures.length !== 0) {
      throw new JvmUnsupportedError("capturing direct JVM callbacks", closure.loc);
    }
    const handler = this.#functions.get(closure.fnName);
    if (handler === undefined) {
      throw new Error(
        `JVM direct callback '${direct.id}' names missing handler '${closure.fnName}'`,
      );
    }
    if ((handler.captures?.length ?? 0) !== 0) {
      throw new JvmUnsupportedError("capturing direct JVM callbacks", closure.loc);
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
    return `(${this.#expr(receiver)}).ntsRegister(` +
      `${this.#options.className}::${encodedIdentifier("f", handler.name)})`;
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
    return this.#directIntExpr(expr) ?? `ntsToInt32(${this.#expr(expr)})`;
  }

  #numberExprAsDouble(expr: IrExpr): string {
    const integer = this.#directIntExpr(expr);
    return integer === null ? this.#expr(expr) : `(double)(${integer})`;
  }

  #binding(id: string): string {
    return id.startsWith("%g.")
      ? encodedIdentifier("g", id)
      : encodedIdentifier("l", id);
  }

  #integerBinding(id: string): boolean {
    return this.#integerLocals.has(id) || this.#machineIntegers.globals.has(id);
  }

  #javaType(type: IrType, loc: SrcLoc): string {
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
