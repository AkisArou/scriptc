import type {
  IrNativeAbiType,
  IrNativeArgumentType,
  IrNativeHandleDef,
  IrNativeParameterProjection,
  IrNativeStructDef,
  IrNativeValueType,
} from "../ir/nodes.js";

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

export type NativeStructDefinition = Readonly<
  Omit<IrNativeStructDef, "fields"> & {
    readonly fields: readonly Readonly<IrNativeStructDef["fields"][number]>[];
  }
>;

export type NativeHandleDefinition = Readonly<IrNativeHandleDef>;
export type NativeTypeDefinition = NativeStructDefinition | NativeHandleDefinition;

export interface NativeFrontendBinding {
  readonly id: string;
  readonly declaration: {
    readonly module: string;
    readonly name: string;
  };
  readonly entry: {
    readonly kind: "c-symbol";
    readonly symbol: string;
  };
  readonly callingConvention: "c";
  readonly variadic: false;
  readonly sourceCall:
    | { readonly kind: "function" }
    | { readonly kind: "method"; readonly receiverArgument: number };
  readonly arguments: readonly {
    readonly name: string;
    readonly type: Readonly<IrNativeArgumentType>;
  }[];
  readonly parameters: readonly {
    readonly name: string;
    readonly type: Readonly<IrNativeAbiType>;
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | { readonly kind: "borrowed"; readonly scope: "call" }
      | { readonly kind: "owned"; readonly transfer: "to-native" }
      | { readonly kind: "callScoped" };
    readonly projection: Readonly<IrNativeParameterProjection>;
  }[];
  readonly result: {
    readonly type: Readonly<IrNativeValueType> | { readonly kind: "void" };
    readonly passMode: "value" | "pointer";
    readonly ownership:
      | { readonly kind: "value" }
      | {
          readonly kind: "owned";
          readonly transfer: "to-runtime";
          readonly destructor: string;
        };
  };
}

/** Embedder-supplied native semantics for one frontend run. This contract is
 * deliberately manifest-neutral: SCABI and target planning live above
 * ScriptC, while this layer sees only exact source identities, the target ABI
 * facts needed to interpret generic types, and Native IR. */
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
  readonly types: readonly NativeTypeDefinition[];
  readonly bindings: readonly NativeFrontendBinding[];
}

/** Runtime members an external declaration module may provide without
 * becoming a JavaScript module-evaluation edge. Type-only imports are erased
 * independently by preflight. */
export function nativeRuntimeMembers(
  input: NativeFrontendInput | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  for (const binding of input?.bindings ?? []) {
    const members = mutable.get(binding.declaration.module) ?? new Set<string>();
    members.add(binding.declaration.name);
    mutable.set(binding.declaration.module, members);
  }
  return mutable;
}
