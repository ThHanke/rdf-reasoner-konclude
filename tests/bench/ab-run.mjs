// tests/bench/ab-run.mjs — alternate old/new checkouts through ab-compare.mjs and print per-case medians.
// usage: node tests/bench/ab-run.mjs <oldRoot> <newRoot> [runs=5] [--roberts]
// Each run is its own process (cold module). Waits for a quiet host (1-min load average) before each case block.
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [oldRoot, newRoot, runsArg, flag] = process.argv.slice(2);
const runs = Number(runsArg ?? 5);
const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => join(here, '../fixtures', f);
const cases = [
  { name: 'LUBM schema', files: fx('lubm.nt'), op: 'classify', n: runs },
  { name: 'GALEN', files: fx('galen.nt'), op: 'classify', n: runs },
  { name: 'LUBM schema + data', files: `${fx('lubm.nt')},${fx('lubm-data.nt')}`, op: 'realize', n: runs },
];
if (flag === '--roberts') cases.push({ name: 'Roberts family', files: fx('roberts-family.nt'), op: 'realize', n: 1 });

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function quiet() { for (let i = 0; i < 40 && loadavg()[0] > 3.5; i++) await sleep(15000); return loadavg()[0].toFixed(1); }

function run(root, c) {
  const r = spawnSync('node', [join(here, 'ab-compare.mjs'), root, c.files, c.op, '1'], { encoding: 'utf8', timeout: 900000 });
  const line = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { error: (r.stderr || r.stdout).slice(0, 200) }; }
}

for (const c of cases) {
  const load0 = await quiet();
  const res = { old: [], new: [] };
  for (let i = 0; i < c.n; i++) for (const k of ['old', 'new']) res[k].push(run(k === 'old' ? oldRoot : newRoot, c));
  const out = { case: c.name, op: c.op, loadAtStart: load0, loadAtEnd: loadavg()[0].toFixed(1) };
  for (const k of ['old', 'new']) {
    const ok = res[k].filter((x) => x.ok);
    const f = (key) => ok.map((x) => x[key]);
    out[k] = ok.length === 0 ? res[k] : {
      n: ok.length, api: ok[0].api, procCount: ok[0].procCount,
      loadMs: [med(f('loadMs')), Math.min(...f('loadMs')), Math.max(...f('loadMs'))],
      reasonMs: [med(f('reasonMs')), Math.min(...f('reasonMs')), Math.max(...f('reasonMs'))],
      outputMs: med(f('outputMs')),
      ingestToResultMs: [med(f('ingestToResultMs')), Math.min(...f('ingestToResultMs')), Math.max(...f('ingestToResultMs'))],
      initMs: med(f('initMs')),
    };
  }
  console.log(JSON.stringify(out));
}
process.exit(0);
