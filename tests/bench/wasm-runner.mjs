// tests/bench/wasm-runner.mjs
// Multi-run WASM benchmark runner — warm-up + measured runs, median per phase.
// Usage: node tests/bench/wasm-runner.mjs  (standalone, runs LUBM)
//        import { benchAll } from './wasm-runner.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNTriples, encodeQuadsForWasm, decodeWasmTripleBuffer, countByCategory } from './wasm-binary.mjs';

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

// quads are pre-parsed outside benchOne so NTriples parsing is excluded from timing.
// abox=true → realization (TBox+ABox); false → classification (TBox-only).
// initMs = createKoncludeModule + new KoncludeReasoner (WASM startup, not comparable to native).
async function benchOne(createModule, quads, abox) {
  const tInit0 = performance.now();
  const Module = await createModule({ print: () => {}, printErr: () => {} });
  const reasoner = new Module.KoncludeReasoner();
  const tInit1 = performance.now();
  try {
    const tLoad0 = performance.now();
    const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeQuadsForWasm(Module, quads);
    try {
      reasoner.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes, abox);
    } finally {
      Module._free(triplePtr);
      Module._free(strTablePtr);
    }
    const tLoad1 = performance.now();
    const ok = abox ? reasoner.realization() : reasoner.classification();
    const tClassify = performance.now();
    const inferred = decodeWasmTripleBuffer(Module, reasoner);
    const tOutput = performance.now();

    if (!ok) throw new Error('classify() returned false');

    const counts = countByCategory(inferred);
    return {
      initMs:           Math.round(tInit1 - tInit0),
      loadMs:           Math.round(tLoad1 - tLoad0),
      classifyMs:       Math.round(tClassify - tLoad1),
      outputMs:         Math.round(tOutput - tClassify),
      totalMs:          Math.round(tOutput - tLoad0),
      inferredTriples:  counts.total,
      inferredTboxCount:   counts.tboxCount,
      inferredTypeCount:   counts.typeCount,
      inferredRoleCount:   counts.roleCount,
      inferredSameAsCount: counts.sameAsCount,
      ok: true,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    reasoner.delete();
  }
}

export const WASM_CASES = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                  expressiveness: 'SHI',   abox: false },
  { name: 'GALEN',              files: ['galen.nt'],                 expressiveness: 'SHIF',  abox: false },
  { name: 'Roberts family',     files: ['roberts-family.nt'],        expressiveness: 'SROIQ', abox: true  },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'], expressiveness: 'SHI',   abox: true  },
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

    let quads;
    let tripleCount;
    try {
      const nts = c.files.map(loadNT);
      tripleCount = nts.reduce((s, nt) => s + countTriples(nt), 0);
      // Pre-parse NTriples → Quads once, outside the timing window.
      quads = parseNTriples(nts.join('\n'));
    } catch {
      process.stderr.write('SKIP (fixture missing)\n');
      results.push({ ...c, result: { error: 'fixture missing' } });
      continue;
    }

    // For ABox cases we run two passes per iteration:
    //   1. classification() only — gives TBox-only timing, comparable to native
    //   2. realization()         — full ABox + role closure (not comparable to native speed)
    // This is necessary because classification() and realization() cannot share a
    // KoncludeReasoner instance (prepareOntology must be called once).
    async function runFresh() {
      return benchOne(createKoncludeModule, quads, c.abox);
    }

    async function runFreshClassifyOnly() {
      return benchOne(createKoncludeModule, quads, false);
    }

    // Each createKoncludeModule allocates 1 GB WASM linear memory.
    // V8 doesn't reclaim these promptly — force GC between runs to avoid OOM.
    const tryGC = () => { if (globalThis.gc) globalThis.gc(); };

    for (let i = 0; i < opts.warmup; i++) {
      await runFresh();
      tryGC();
      if (c.abox) { await runFreshClassifyOnly(); tryGC(); }
    }

    const runs = [];
    const classifyOnlyRuns = [];
    for (let i = 0; i < opts.runs; i++) {
      runs.push(await runFresh());
      tryGC();
      if (c.abox) { classifyOnlyRuns.push(await runFreshClassifyOnly()); tryGC(); }
    }

    const failed = runs.find(r => !r.ok) ?? classifyOnlyRuns.find(r => !r.ok);
    if (failed) {
      process.stderr.write(`FAIL: ${failed.error}\n`);
      results.push({ ...c, tripleCount, result: { ok: false, error: failed.error } });
      continue;
    }

    const result = {
      ok: true,
      initMs:              median(runs.map(r => r.initMs)),
      loadMs:              median(runs.map(r => r.loadMs)),
      classifyMs:          median(runs.map(r => r.classifyMs)),
      outputMs:            median(runs.map(r => r.outputMs)),
      totalMs:             median(runs.map(r => r.totalMs)),
      inferredTriples:     runs[0].inferredTriples,
      inferredTboxCount:   runs[0].inferredTboxCount,
      inferredTypeCount:   runs[0].inferredTypeCount,
      inferredRoleCount:   runs[0].inferredRoleCount,
      inferredSameAsCount: runs[0].inferredSameAsCount,
      // For ABox cases: classification-only timing for fair speed comparison with native.
      classifyOnlyMs: c.abox ? median(classifyOnlyRuns.map(r => r.classifyMs)) : null,
    };

    const classifyOnlyNote = c.abox ? `, classifyOnly: ${result.classifyOnlyMs} ms` : '';
    process.stderr.write(`${result.totalMs} ms total (init: ${result.initMs} ms, classify: ${result.classifyMs} ms${classifyOnlyNote}, inferred: ${result.inferredTriples} [type:${result.inferredTypeCount} role:${result.inferredRoleCount} tbox:${result.inferredTboxCount}])\n`);
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
