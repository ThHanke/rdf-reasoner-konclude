// tests/bench/cases.mjs — per-case run budgets (runs, warm-ups, subprocess timeout).
// Slow cases use fewer runs and no warm-up; their rows are labelled "indicative only" (n < 5) by stats.mjs.
// Rule: a case whose first measured run exceeds ~10 s gets runs=3, warmup=0.
const FAST = { warmup: 1, runs: 5, timeoutMs: 600_000 };
const SLOW = { warmup: 0, runs: 3, timeoutMs: 2_400_000 };

export const BUDGETS = {
  'LUBM schema': FAST,
  'GALEN': FAST,
  'Roberts family': SLOW,
  'LUBM schema + data': { ...FAST, timeoutMs: 900_000 },
};

export function budgetFor(name, quick = false) {
  const b = BUDGETS[name] ?? FAST;
  return quick ? { ...b, warmup: 0, runs: 3 } : b;
}
