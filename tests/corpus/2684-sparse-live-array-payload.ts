// Live Web references must carry an array's hole bitmap through dynamic
// materialization, mutation commits, and cached structural-cast refreshes.

const materializedSource: number[] = new Array(4);
materializedSource[1] = 11;
materializedSource[3] = 33;
const materialized: unknown = AbortSignal.abort(materializedSource).reason;
if (Array.isArray(materialized)) {
  console.log(
    "materialized",
    materialized.length,
    Object.keys(materialized).join(","),
    JSON.stringify(materialized),
  );
}

const committedSource: number[] = new Array(3);
committedSource[0] = 1;
committedSource[2] = 3;
const committed: unknown = AbortSignal.abort(committedSource).reason;
if (Array.isArray(committed)) committed[1] = 2;
console.log(
  "committed",
  committedSource.length,
  Object.keys(committedSource).join(","),
  JSON.stringify(committedSource),
);

const refreshedSource: number[] = new Array(4);
refreshedSource[1] = 10;
const refreshValue: unknown = AbortSignal.abort(refreshedSource).reason;
const first = refreshValue as (number | string)[];
delete refreshedSource[1];
refreshedSource[2] = 20;
const second = refreshValue as (number | string)[];
console.log(
  "refreshed",
  first === second,
  second.length,
  Object.keys(second).join(","),
  JSON.stringify(second),
);
