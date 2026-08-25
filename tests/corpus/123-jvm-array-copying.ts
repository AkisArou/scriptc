/** Array copying and reversal keep JavaScript's relative-index rules while
 * remaining specialized to the reached element type in Direct JVM. */
export function copiedNumbers(seed: number): number {
  const source = [seed, 2, 3, 4, 5, 6, 7, 8];
  const middle = source.slice(-6, -1);
  middle.reverse();
  const restored = middle.toReversed();
  const changed = restored.with(-2, seed + 10);

  return source[0]! + middle[0]! + restored[0]! + changed[3]! + changed[4]! +
    middle.length + restored.length + changed.length;
}

/** Disagreeing bounds make a clamp, truncation, or copy/in-place mix-up
 * visible in one scalar result. */
export function copyingEdges(): number {
  const source = [1, 2, 3, 4];
  const clamped = source.slice(-99, 2.9);
  const empty = source.slice(3, 1);
  const reversed = source.toReversed();
  const changed = source.with(-1, 9);
  source.reverse();

  return clamped[0]! + clamped[1]! + empty.length + reversed[0]! +
    changed[3]! + source[0]!;
}
