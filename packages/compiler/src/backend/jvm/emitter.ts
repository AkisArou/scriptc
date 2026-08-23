import type {
  IrExpr,
  IrFunction,
  IrModule,
  IrStmt,
  IrType,
  SrcLoc,
} from "../../ir/nodes.js";
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
}

function assertJavaIdentifier(value: string, role: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) {
    throw new Error(`Invalid JVM ${role} '${value}'`);
  }
}

function validateOptions(options: JvmEmissionOptions): void {
  assertJavaIdentifier(options.className, "class name");
  if (options.packageName === undefined || options.packageName.length === 0) return;
  for (const segment of options.packageName.split(".")) {
    assertJavaIdentifier(segment, "package segment");
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

function javaType(type: IrType, loc: SrcLoc): string {
  switch (type.kind) {
    case "void": return "void";
    case "f64": return "double";
    case "bool": return "boolean";
    case "string": return "String";
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

class JavaEmitter {
  readonly #module: IrModule;
  readonly #options: JvmEmissionOptions;
  readonly #functions: ReadonlyMap<string, IrFunction>;

  constructor(module: IrModule, options: JvmEmissionOptions) {
    this.#module = module;
    this.#options = options;
    this.#functions = new Map(module.functions.map((fn) => [fn.name, fn]));
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

    for (const global of this.#module.globals ?? []) {
      lines.push(
        `  private static ${javaType(global.type, entry.loc)} ${encodedIdentifier("g", global.id)};`,
      );
    }
    if ((this.#module.globals?.length ?? 0) > 0) lines.push("");

    for (const fn of this.#module.functions) {
      lines.push(...this.#emitFunction(fn), "");
    }

    lines.push(
      "  public static void main(String[] args) {",
      `    ${encodedIdentifier("f", entry.name)}();`,
      "  }",
      "}",
      "",
    );
    return lines.join("\n");
  }

  #emitFunction(fn: IrFunction): string[] {
    if (fn.async === true) throw new JvmUnsupportedError("async functions", fn.loc);
    if (fn.generator !== undefined) throw new JvmUnsupportedError("generator functions", fn.loc);
    if ((fn.captures?.length ?? 0) !== 0) throw new JvmUnsupportedError("capturing functions", fn.loc);
    for (const local of fn.locals) {
      if (local.boxed === true) throw new JvmUnsupportedError("boxed locals", fn.loc);
      if (local.nativeFrame !== undefined) {
        throw new JvmUnsupportedError("frame-bounded native handles", fn.loc);
      }
    }

    const params = fn.params.map((param) =>
      `${javaType(param.type, fn.loc)} ${encodedIdentifier("l", param.localId)}`
    ).join(", ");
    const lines = [
      `  private static ${javaType(fn.returnType, fn.loc)} ${encodedIdentifier("f", fn.name)}(${params}) {`,
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
        const init = stmt.init === null ? "" : ` = ${this.#expr(stmt.init)}`;
        return [`${pad}${javaType(local.type, stmt.loc)} ${encodedIdentifier("l", local.id)}${init};`];
      }
      case "assign":
        return [`${pad}${this.#binding(stmt.localId)} = ${this.#expr(stmt.value)};`];
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
      default:
        throw new JvmUnsupportedError(`statement '${stmt.kind}'`, stmt.loc);
    }
  }

  #expr(expr: IrExpr): string {
    switch (expr.kind) {
      case "numLit": return numberLiteral(expr.value);
      case "boolLit": return expr.value ? "true" : "false";
      case "strLit": return javaString(expr.value);
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
        if (expr.op === "**") return `Math.pow(${left}, ${right})`;
        if (["&", "|", "^", "<<", ">>", ">>>"].includes(expr.op)) {
          throw new JvmUnsupportedError(`numeric operator '${expr.op}'`, expr.loc);
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
        return `(${expr.op}${this.#expr(expr.operand)})`;
      }
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

  #binding(id: string): string {
    return id.startsWith("%g.")
      ? encodedIdentifier("g", id)
      : encodedIdentifier("l", id);
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
