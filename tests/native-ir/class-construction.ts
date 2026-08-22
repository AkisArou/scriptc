import * as Native from "@scriptc/native-abi-fixture";

/* The class is MERGED with an ambient namespace carrying its compile-time
 * constants, which is how a class with static finals projects. Reading the
 * constant AND constructing is what proves the merge costs the constructor
 * nothing: before a merged namespace was admitted beside a class, a class with
 * both stopped resolving its constructor — and only a class carrying both
 * could show it, which is why neither existed until constants came with their
 * class. */
new Native.NativeCounter(Native.NativeCounter.step);
Native.NativeCounter.withInitialValue(41 as Native.i32);
