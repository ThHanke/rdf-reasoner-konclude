// tests/bench/ts-runner.mjs — TypeScript-layer benchmark (full public RdfReasoner API).
//
// Design: every measurement is ONE fresh process with ONE fresh RdfReasoner and ONE call (tests/bench/simple-run.mjs;
// simple-warm.mjs for the warm scenarios). Creating and terminating several reasoners inside one Node process showed
// intermittent 4-5x slow kernel runs on Roberts (see docs/solutions/performance-issues/ts-runner-in-process-slow-runs-2026-10.md);
// process-per-run removes that variable and also matches the definition of "cold".
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarize } from './stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const REPO_ROOT = join(__dirname, '../..');
const CHECKOUT = REPO_ROOT;

export const TS_CASES = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                  expressiveness: 'SHI',   abox: false },
  { name: 'GALEN',              files: ['galen.nt'],                 expressiveness: 'SHIF',  abox: false },
  { name: 'Roberts family',     files: ['roberts-family.nt'],        expressiveness: 'SROIQ', abox: true  },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'], expressiveness: 'SHI',   abox: true  },
];

function fixturePaths(c) {
  const paths = c.files.map((f) => join(FIXTURES, f));
  return paths.every((p) => existsSync(p)) ? paths.join(',') : null;
}

function runProcess(script, args, timeoutMs) {
  const r = spawnSync('node', [join(__dirname, script), ...args], { encoding: 'utf8', timeout: timeoutMs });
  const line = (r.stdout || '').trim().split('\n').pop();
  try {
    const out = JSON.parse(line);
    return out.error ? { ok: false, error: out.error } : { ok: true, ...out };
  } catch {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 160) };
  }
}

export async function benchAll(cases = TS_CASES, opts = { warmup: 1, runs: 5, timeoutMs: 600_000 }) {
  const timeout = opts.timeoutMs ?? 600_000;
  const results = [];
  for (const c of cases) {
    process.stderr.write(`  ts: ${c.name}... `);
    const fixture = fixturePaths(c);
    if (!fixture) { process.stderr.write('SKIP (fixture missing)\n'); results.push({ ...c, result: { error: 'fixture missing' } }); continue; }
    const op = c.abox ? 'materialize' : 'reason';

    for (let i = 0; i < (opts.warmup ?? 0); i++) runProcess('simple-run.mjs', [CHECKOUT, fixture, op], timeout);
    const runs = [];
    for (let i = 0; i < opts.runs; i++) runs.push(runProcess('simple-run.mjs', [CHECKOUT, fixture, op], timeout));
    const failed = runs.find((r) => !r.ok);
    if (failed) { process.stderr.write(`FAIL: ${failed.error}\n`); results.push({ ...c, result: { ok: false, error: failed.error } }); continue; }

    // One separate process measures the explanation call (justification graph on top of the reasoning).
    const expl = runProcess('simple-run.mjs', [CHECKOUT, fixture, op, 'expl'], timeout);
    const total = summarize(runs.map((r) => r.ms));
    const result = {
      ok: true,
      totalMs: total.median, minMs: total.min, maxMs: total.max,
      inferredTriples: runs[0].inferred, inferredTypeCount: runs[0].typeCount, inferredTboxCount: runs[0].tboxCount,
      inferredRoleCount: runs[0].roleCount, inferredSameAsCount: runs[0].sameAsCount,
      distinctInferredCounts: [...new Set(runs.map((r) => r.inferred))],
      explMs: expl.ok ? expl.ms : null, explQuads: expl.ok ? expl.explQuads : null,
      explOverhead: expl.ok ? Math.round(((expl.ms - total.median) / total.median) * 100) : null,
      stats: { total },
    };
    process.stderr.write(`median ${total.median} ms [${total.min}–${total.max}] (inferred: ${result.inferredTriples}${result.distinctInferredCounts.length > 1 ? `; DIFFERENT COUNTS ${result.distinctInferredCounts}` : ''}${expl.ok ? `, expl: ${expl.ms} ms, ${expl.explQuads} quads` : ''})\n`);
    results.push({ ...c, tripleCount: undefined, result });
  }
  return results;
}

// Warm scenarios: one process per repetition (simple-warm.mjs), absolute times, kernel counters asserted inside.
export async function benchIncremental(cases = TS_CASES, opts = { runs: 3, timeoutMs: 600_000 }) {
  const timeout = opts.timeoutMs ?? 600_000;
  const results = [];
  for (const c of cases) {
    process.stderr.write(`  warm: ${c.name}... `);
    const fixture = fixturePaths(c);
    if (!fixture) { process.stderr.write('SKIP (fixture missing)\n'); results.push({ ...c, result: { error: 'fixture missing' } }); continue; }
    const op = c.abox ? 'materialize' : 'reason';
    const reps = [];
    for (let i = 0; i < opts.runs; i++) reps.push(runProcess('simple-warm.mjs', [CHECKOUT, fixture, op], timeout));
    const failed = reps.find((r) => !r.ok);
    if (failed) { process.stderr.write(`FAIL: ${failed.error}\n`); results.push({ ...c, result: { ok: false, error: failed.error } }); continue; }
    const result = { ok: true, stats: {
      cold: summarize(reps.map((r) => r.cold)), unchanged: summarize(reps.map((r) => r.unchanged)),
      newStore: summarize(reps.map((r) => r.newStore)), changed: summarize(reps.map((r) => r.changed)) } };
    process.stderr.write(`cold ${result.stats.cold.median} ms, unchanged ${result.stats.unchanged.median} ms, new-store ${result.stats.newStore.median} ms, changed ${result.stats.changed.median} ms\n`);
    results.push({ ...c, result });
  }
  return results;
}

// Standalone mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  benchAll(TS_CASES, { warmup: 1, runs: 5 }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e); process.exit(1); });
}
