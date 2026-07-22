// JSDoc-annotated record shapes: @type object/array annotations give tsc
// the concrete types the type-driven pipeline needs; JSON.stringify rides
// the same record machinery as TS.
'use strict';

/** @type {{ name: string, score: number, tags: string[] }[]} */
const players = [];
players.push({ name: "ada", score: 90, tags: ["pioneer"] });
players.push({ name: "grace", score: 95, tags: ["navy", "compiler"] });
players.push({ name: "linus", score: 80, tags: [] });

/** @param {{ name: string, score: number, tags: string[] }} p */
function line(p) {
  return `${p.name} ${p.score} [${p.tags.join(",")}]`;
}

for (const p of players) console.log(line(p));

const best = players.reduce((a, b) => (b.score > a.score ? b : a));
console.log("best:", best.name);

const totals = /** @type {Map<string, number>} */ (new Map());
for (const p of players) totals.set(p.name[0], (totals.get(p.name[0]) ?? 0) + p.score);
let sum = 0;
for (const [, v] of totals) sum += v;
console.log("initials:", totals.size, "sum:", sum);

// Inferred anonymous literals stringify in the checker's (alphabetical)
// property order — keys chosen here so both orders agree.
console.log(JSON.stringify({ best: best.name, count: players.length }));
