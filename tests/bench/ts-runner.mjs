// tests/bench/ts-runner.mjs
// TypeScript-layer benchmark — measures full RdfReasoner.reason(store) RTT
// including n3.Writer serialization, Worker round-trip, and n3.Parser output.
// Usage: node tests/bench/ts-runner.mjs  (requires dist/ built first)
//        import { benchAll as tsBenchAll } from './ts-runner.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Store, Parser as N3Parser, DataFactory } from 'n3';

/**
 * Wraps Node.js worker_threads.Worker to match the Web Worker EventTarget API
 * that RdfReasoner expects (addEventListener, removeEventListener, postMessage).
 *
 * Message events are re-shaped from raw data → { data } to match MessageEvent.
 * Error events are re-shaped from Error → { message } to match ErrorEvent.
 */
class NodeWorkerShim {
  constructor(url, _opts) {
    // Swap worker.js → worker-node.mjs to polyfill Web Worker globals (self, onmessage)
    let rawPath = url instanceof URL ? new URL(url).pathname : String(url);
    const path = rawPath.replace(/worker\.js$/, 'worker-node.mjs');
    this._w = new NodeWorker(path);
    this._map = new Map(); // fn → wrapped fn
  }
  postMessage(msg) { this._w.postMessage(msg); }
  addEventListener(type, fn) {
    let wrapped;
    if (type === 'message') {
      wrapped = (data) => fn({ data });
    } else if (type === 'error') {
      wrapped = (err) => fn({ message: err?.message ?? String(err) });
    } else {
      wrapped = fn;
    }
    // Store per (type, fn) so removeEventListener can look up the wrapper
    if (!this._map.has(fn)) this._map.set(fn, new Map());
    this._map.get(fn).set(type, wrapped);
    this._w.on(type, wrapped);
  }
  removeEventListener(type, fn) {
    const wrapped = this._map.get(fn)?.get(type);
    if (wrapped) { this._w.off(type, wrapped); this._map.get(fn).delete(type); }
  }
  terminate() { this._w.terminate(); }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, '../fixtures');
const DIST_INDEX = process.env.TS_DIST_DIR
  ? join(process.env.TS_DIST_DIR, 'index.js')
  : join(__dirname, '../../dist/index.js');

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

function avg(arr) {
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function benchOne(RdfReasoner, INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI, store, abox) {
  const reasoner = new RdfReasoner();
  await reasoner.ready;

  try {
    const t0 = performance.now();
    // ABox cases use materialize() (full realization, matching the WASM runner's
    // realization() path).  TBox-only cases use reason() → classify.
    if (abox) {
      await reasoner.materialize(store, { includeClassHierarchy: true });
    } else {
      await reasoner.reason(store);
    }
    const t1 = performance.now();

    const inferredCount = store.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI)).length;

    // Explanation overhead: re-run with explanations on a fresh store clone
    let explMs = null;
    let explQuads = null;
    try {
      const explStore = new Store(store.getQuads(null, null, null, null).filter(
        q => q.graph.value !== INFERRED_GRAPH_IRI && q.graph.value !== EXPLANATION_GRAPH_IRI,
      ));
      const reasoner2 = new RdfReasoner();
      await reasoner2.ready;
      const te0 = performance.now();
      if (abox) {
        await reasoner2.materialize(explStore, { includeClassHierarchy: true, explanations: true });
      } else {
        await reasoner2.classify(explStore, { explanations: true });
      }
      const te1 = performance.now();
      explMs = Math.round(te1 - te0);
      explQuads = explStore.getQuads(null, null, null, DataFactory.namedNode(EXPLANATION_GRAPH_IRI)).length;
      reasoner2.terminate();
    } catch {
      // exportAllJustifications may not exist in older WASM builds
    }

    return {
      totalMs: Math.round(t1 - t0),
      inferredTriples: inferredCount,
      explMs,
      explQuads,
      ok: true,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    reasoner.terminate();
  }
}

export const TS_CASES = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                  expressiveness: 'SHI',   abox: false },
  { name: 'GALEN',              files: ['galen.nt'],                 expressiveness: 'SHIF',  abox: false },
  { name: 'Roberts family',     files: ['roberts-family.nt'],        expressiveness: 'SROIQ', abox: true  },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'], expressiveness: 'SHI',   abox: true  },
];

export async function benchAll(cases = TS_CASES, opts = { warmup: 2, runs: 5 }) {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`dist/index.js not found: ${DIST_INDEX}\nRun 'npm run build' first.`);
  }

  globalThis.Worker = NodeWorkerShim;

  const { RdfReasoner, INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI } = await import(DIST_INDEX);

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
      return benchOne(RdfReasoner, INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI, store, c.abox);
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

    const allMs = runs.map(r => r.totalMs);
    const explMs = runs[0].explMs;
    const explQuads = runs[0].explQuads;
    const explOverhead = explMs != null ? Math.round(((explMs - avg(allMs)) / avg(allMs)) * 100) : null;
    const result = {
      ok: true,
      totalMs: avg(allMs),
      medianMs: median(allMs),
      minMs: Math.min(...allMs),
      maxMs: Math.max(...allMs),
      inferredTriples: runs[0].inferredTriples,
      explMs,
      explQuads,
      explOverhead,
    };

    let explInfo = '';
    if (explMs != null) {
      explInfo = `, expl: ${explMs} ms (+${explOverhead}%, ${explQuads} quads)`;
    }
    process.stderr.write(`avg ${result.totalMs} ms, median ${result.medianMs} ms, min ${result.minMs}, max ${result.maxMs} (inferred: ${result.inferredTriples}${explInfo})\n`);
    results.push({ ...c, tripleCount, result });
  }

  return results;
}

// Standalone mode
if (process.argv[1] === __filename) {
  console.error('Running TypeScript-layer benchmark (standalone)...');
  benchAll(TS_CASES, { warmup: 2, runs: 5 })
    .then(results => {
      console.log(JSON.stringify(results, null, 2));
    })
    .catch(e => { console.error(e); process.exit(1); });
}
