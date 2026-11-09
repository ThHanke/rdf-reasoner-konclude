/**
 * Minimal hitting sets of a family of sets, computed combinatorially (no reasoner calls). Berge's algorithm:
 * fold the sets in one at a time, branching every partial hitting set that misses the new set, then drop
 * supersets. `cap` bounds the working list (smallest sets are kept), so very large families return the
 * smallest minimal hitting sets only.
 */
export function minimalHittingSets(sets: readonly (readonly string[])[], cap = 500): string[][] {
  let current: Set<string>[] = [new Set()];
  for (const s of sets) {
    const next: Set<string>[] = [];
    for (const h of current) {
      if (s.some(a => h.has(a))) next.push(h);
      else for (const a of s) next.push(new Set([...h, a]));
    }
    current = minimize(next).slice(0, cap);
  }
  return current.map(h => [...h]);
}

/** Drop duplicates and supersets; result is ordered by ascending size. */
function minimize(sets: Set<string>[]): Set<string>[] {
  const sorted = [...sets].sort((a, b) => a.size - b.size);
  const kept: Set<string>[] = [];
  for (const s of sorted) {
    if (!kept.some(k => k.size <= s.size && [...k].every(x => s.has(x)))) kept.push(s);
  }
  return kept;
}
