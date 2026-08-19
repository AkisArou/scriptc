/* The embedder seam. Its shapes are the published manifest format and are
 * declared there; this module re-exports them so a frontend import reads as
 * frontend vocabulary, and adds the runtime helper that is not part of the
 * format because it is a rule about it. */
export type {
  NativeFrontendBinding,
  NativeFrontendConstant,
  NativeFrontendExport,
  NativeFrontendInput,
  NativeFrontendOperation,
  NativeHandleDefinition,
  NativeSourceType,
  NativeStructDefinition,
  NativeTypeDefinition,
} from "../native-manifest.js";
import type { NativeFrontendInput } from "../native-manifest.js";

/** Runtime members an external declaration module may provide without
 * becoming a JavaScript module-evaluation edge. Type-only imports are erased
 * independently by preflight. */
export function nativeRuntimeMembers(
  input: NativeFrontendInput | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  for (const binding of input?.bindings ?? []) {
    const members = mutable.get(binding.declaration.module) ?? new Set<string>();
    members.add(binding.declaration.name.split(".", 1)[0]!);
    mutable.set(binding.declaration.module, members);
  }
  for (const constant of input?.constants ?? []) {
    const members = mutable.get(constant.declaration.module) ?? new Set<string>();
    members.add(constant.declaration.name.split(".", 1)[0]!);
    mutable.set(constant.declaration.module, members);
  }
  for (const operation of input?.operations ?? []) {
    const members = mutable.get(operation.declaration.module) ?? new Set<string>();
    members.add(operation.declaration.name.split(".", 1)[0]!);
    mutable.set(operation.declaration.module, members);
  }
  return mutable;
}
