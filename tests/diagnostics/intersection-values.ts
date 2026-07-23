// SC2008: intersection types that resolve to no runtime shape. Object-member
// intersections intern through the record path and callable hybrids map to
// '%call' records — what fences is the remainder, like a primitive part
// against an object part (inhabited only per the checker, never buildable).

type Branded = number & { __brand: "id" };
declare function mint(): Branded;
const kept = mint();
console.log(kept);
