declare const nativeScalar: unique symbol;

export type i32 = number & { readonly [nativeScalar]: "i32" };

export declare function i32Identity(value: i32): i32;

