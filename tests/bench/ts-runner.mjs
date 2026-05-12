// tests/bench/ts-runner.mjs
// TypeScript-layer benchmark — measures full RdfReasoner.reason(store) RTT
// including n3.Writer serialization, Worker round-trip, and n3.Parser output.
// Usage: node tests/bench/ts-runner.mjs  (requires dist/ built first)
//        import { benchAll as tsBenchAll } from './ts-runner.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store, Parser as N3Parser } from 'n3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, '../fixtures');
const DIST_INDEX = join(__dirname, '../../dist/index.js');

function loadNT(file) {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

function parseIntoStore(ntContent) {
  return new Promise((resolve, reject) => {
    const store = new Store();
    const parser = new N3Parser({ format: 'N-Triples' });
    parser.parse(ntContent, (err, quad) => {
      if (err) reject(err);
      else if (quad) store.addQuad(quad);
      else resolve(store);
    });
  });
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

async function benchOne(RdfReasoner, INFERRED_GRAPH_IRI, store) {
  const reasoner = new RdfReasoner();
  await reasoner.ready;

  try {
    const t0 = performance.now();
    await reasoner.reason(store);
    const t1 = performance.now();

    const inferredCount = store.getQuads(null, null, null, { value: INFERRED_GRAPH_IRI }).length;
    return {
      totalMs: Math.round(t1 - t0),
      inferredTriples: inferredCount,
      ok: true,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    reasoner.terminate();
  }
}

export const TS_CASES = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                  expressiveness: 'SHI' },
  { name: 'GALEN',              files: ['galen.nt'],                 expressiveness: 'SHIF' },
  { name: 'Roberts family',     files: ['roberts-family.nt'],        expressiveness: 'SROIQ' },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'], expressiveness: 'SHI' },
];

export async function benchAll(cases = TS_CASES, opts = { warmup: 1, runs: 3 }) {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`dist/index.js not found: ${DIST_INDEX}\nRun 'npm run build' first.`);
  }

  // Patch global Worker so RdfReasoner can spawn its Worker thread under Node
  globalThis.Worker = Worker;

  const { RdfReasoner, INFERRED_GRAPH_IRI } = await import(DIST_INDEX);

  const results = [];

  for (const c of cases) {
    process.stderr.write(`  ts: ${c.name}... `);

    let ntContents;
    try {
      ntContents = c.files.map(loadNT);
    } catch {
      process.stderr.write('SKIP (fixture missing)\n');
      results.push({ ...c, result: { error: 'fixture missing' } });
      continue;
    }

    // Parse all NTriples content into a single N3 Store (one-time setup, not benchmarked)
    const baseStore = new Store();
    for (const nt of ntContents) {
      const s = await parseIntoStore(nt);
      for (const q of s.getQuads(null, null, null, null)) {
        baseStore.addQuad(q);
      }
    }

    const tripleCount = baseStore.size;

    async function runOnce() {
      // Clone base store for each run so inferred triples don't accumulate across runs
      const store = new Store(baseStore.getQuads(null, null, null, null));
      return benchOne(RdfReasoner, INFERRED_GRAPH_IRI, store);
    }

    for (let i = 0; i < opts.warmup; i++) {
      await runOnce();
    }

    const runs = [];
    for (let i = 0; i < opts.runs; i++) {
      runs.push(await runOnce());
    }

    const failed = runs.find(r => !r.ok);
    if (failed) {
      process.stderr.write(`FAIL: ${failed.error}\n`);
      results.push({ ...c, tripleCount, result: { ok: false, error: failed.error } });
      continue;
    }

    const result = {
      ok: true,
      totalMs: median(runs.map(r => r.totalMs)),
      inferredTriples: runs[0].inferredTriples,
    };

    process.stderr.write(`${result.totalMs} ms total (inferred: ${result.inferredTriples})\n`);
    results.push({ ...c, tripleCount, result });
  }

  return results;
}

// Standalone mode
if (process.argv[1] === __filename) {
  console.error('Running TypeScript-layer benchmark (standalone)...');
  benchAll(TS_CASES, { warmup: 1, runs: 3 })
    .then(results => {
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(e => { console.error(e); process.exit(1); });
}
