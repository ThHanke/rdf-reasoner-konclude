// tests/bench/stats.mjs — summary statistics for benchmark samples.

/** Median; for an even count the mean of the two middle values, rounded to an integer. */
export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

/** Linear-interpolated percentile (p in 0..1) of an unsorted list. */
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const SPREAD_FLAG_PCT = 10;   // (max - min) / median above this marks a row as noisy
export const MIN_N_CONFIDENT = 5;    // fewer samples are labelled "indicative only"

/** Summary of a sample list: n, min, median, max, iqr, spreadPct, noisy, indicative. Null for an empty list. */
export function summarize(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (v.length === 0) return null;
  const med = median(v);
  const min = Math.min(...v);
  const max = Math.max(...v);
  const iqr = Math.round(percentile(v, 0.75) - percentile(v, 0.25));
  const spreadPct = med > 0 ? Math.round(((max - min) / med) * 100) : 0;
  return { n: v.length, min, median: med, max, iqr, spreadPct, noisy: spreadPct > SPREAD_FLAG_PCT, indicative: v.length < MIN_N_CONFIDENT };
}

/** "median [min–max]" plus markers: † noisy (spread > 10%), ‡ indicative only (n < 5). */
export function fmtStat(s, unit = 'ms') {
  if (!s) return '—';
  const marks = (s.noisy ? '†' : '') + (s.indicative ? '‡' : '');
  return s.n === 1 ? `${s.median} ${unit}${marks}` : `${s.median} ${unit} [${s.min}–${s.max}]${marks}`;
}
