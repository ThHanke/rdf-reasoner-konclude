// tests/bench/wasm-runner.mjs
// Multi-run WASM benchmark runner — warm-up + measured runs, median per phase.
// Usage: node tests/bench/wasm-runner.mjs  (standalone, runs LUBM)
//        import { benchAll } from './wasm-runner.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, '../fixtures');
const MODULE_PATH = join(__dirname, '../../dist/konclude.mjs');

function loadNT(file) {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

function countTriples(nt) {
  return nt.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

async function benchOne(Module, nts) {
  const reasoner = new Module.KoncludeReasoner();
  try {
    const tLoad0 = performance.now();
    for (const nt of nts) reasoner.loadNTriples(nt);
    const tLoad1 = performance.now();
    const ok = reasoner.classify();
    const tClassify = performance.now();
    const inferred = reasoner.getInferredNTriples();
    const tOutput = performance.now();

    if (!ok) throw new Error('classify() returned false');

    return {
      loadMs:        Math.round(tLoad1 - tLoad0),
      classifyMs:    Math.round(tClassify - tLoad1),
      outputMs:      Math.round(tOutput - tClassify),
      totalMs:       Math.round(tOutput - tLoad0),
      inferredTriples: countTriples(inferred),
      ok: true,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    reasoner.delete();
  }
}

export const WASM_CASES = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                  expressiveness: 'SHI' },
  { name: 'GALEN',              files: ['galen.nt'],                 expressiveness: 'SHIF' },
  { name: 'Roberts family',     files: ['roberts-family.nt'],        expressiveness: 'SROIQ' },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'], expressiveness: 'SHI' },
];

export async function benchAll(cases = WASM_CASES, opts = { warmup: 1, runs: 3 }) {
  if (!existsSync(MODULE_PATH)) {
    throw new Error(`WASM module not found: ${MODULE_PATH}\nRun 'docker compose run build' first.`);
  }

  // Import once; call createKoncludeModule() per run so each starts with a fresh
  // WASM heap — necessary for large ontologies that exhaust the 1 GB WASM memory
  // limit after the first classification, preventing a second run on the same heap.
  const { default: createKoncludeModule } = await import(MODULE_PATH);

  const results = [];

  for (const c of cases) {
    process.stderr.write(`  wasm: ${c.name}... `);

    let nts;
    try {
      nts = c.files.map(loadNT);
    } catch {
      process.stderr.write('SKIP (fixture missing)\n');
      results.push({ ...c, result: { error: 'fixture missing' } });
      continue;
    }

    const tripleCount = nts.reduce((s, nt) => s + countTriples(nt), 0);

    async function runFresh() {
      const Module = await createKoncludeModule();
      return benchOne(Module, nts);
    }

    for (let i = 0; i < opts.warmup; i++) {
      await runFresh();
    }

    const runs = [];
    for (let i = 0; i < opts.runs; i++) {
      runs.push(await runFresh());
    }

    const failed = runs.find(r => !r.ok);
    if (failed) {
      process.stderr.write(`FAIL: ${failed.error}\n`);
      results.push({ ...c, tripleCount, result: { ok: false, error: failed.error } });
      continue;
    }

    const result = {
      ok: true,
      loadMs:          median(runs.map(r => r.loadMs)),
      classifyMs:      median(runs.map(r => r.classifyMs)),
      outputMs:        median(runs.map(r => r.outputMs)),
      totalMs:         median(runs.map(r => r.totalMs)),
      inferredTriples: runs[0].inferredTriples,
    };

    process.stderr.write(`${result.totalMs} ms total (classify: ${result.classifyMs} ms, inferred: ${result.inferredTriples})\n`);
    results.push({ ...c, tripleCount, result });
  }

  return results;
}

// Standalone mode
if (process.argv[1] === __filename) {
  console.error('Running WASM benchmark (standalone)...');
  benchAll(WASM_CASES, { warmup: 1, runs: 3 })
    .then(results => {
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(e => { console.error(e); process.exit(1); });
}
