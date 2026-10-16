// tests/bench/recycle-probe.mjs — forces a Worker recycle before every changed call (recycleHeapBytes=1) and logs per-call time,
// live OS thread count and process CPU seconds, to see whether the old Worker's kernel threads outlive terminate().
// usage: node tests/bench/recycle-probe.mjs <checkoutRoot> <fixture.nt> <materialize|reason> [calls=6] [awaitTerminate=0]
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFileSync, readdirSync } from 'node:fs';
import { Store, Parser, DataFactory } from 'n3';

const [root, fixture, op, nCalls = '6', awaitTerm = '0'] = process.argv.slice(2);
class WorkerShim {
  constructor() { this.w = new NodeWorker(`${root}/dist/worker-node.mjs`); this.m = new Map(); }
  postMessage(msg) { this.w.postMessage(msg); }
  addEventListener(type, fn) {
    const wrapped = type === 'message' ? (d) => fn({ data: d }) : type === 'error' ? (e) => fn({ message: e?.message ?? String(e) }) : fn;
    this.m.set(fn, wrapped); this.w.on(type, wrapped);
  }
  removeEventListener(type, fn) { const w = this.m.get(fn); if (w) this.w.off(type, w); }
  terminate() { const p = this.w.terminate(); return awaitTerm === '1' ? p : undefined; }
}
globalThis.Worker = WorkerShim;
const { RdfReasoner } = await import(`${root}/dist/index.js`);
const quads = new Parser({ format: 'N-Triples' }).parse(readFileSync(fixture, 'utf8'));
const reasoner = new RdfReasoner({ recycleHeapBytes: Number(process.env.RECYCLE ?? 1) });
await reasoner.ready;
const threads = () => readdirSync('/proc/self/task').length;
const cpu = () => { const u = process.cpuUsage(); return Math.round((u.user + u.system) / 1e5) / 10; };
const run = (store) => (op === 'materialize' ? reasoner.materialize(store, { includeClassHierarchy: true }) : reasoner.reason(store));
for (let i = 0; i < Number(nCalls); i++) {
  const store = new Store(quads);
  store.addQuad(DataFactory.namedNode(`http://bench.example/C${i}`), DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), DataFactory.namedNode('http://www.w3.org/2002/07/owl#Thing'));
  const t0 = performance.now(), c0 = cpu();
  await run(store);
  console.log(JSON.stringify({ call: i, ms: Math.round(performance.now() - t0), cpuS: Math.round((cpu() - c0) * 10) / 10, threads: threads() }));
}
reasoner.terminate();
process.exit(0);
