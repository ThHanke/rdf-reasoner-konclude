// tests/bench/pmdco-seq.mjs — Ontosphere sequence: checkConsistency(store) then materialize(store,{includeClassHierarchy,inferredGraph,returnDelta}).
// usage: node tests/bench/pmdco-seq.mjs <packageRoot> <fixture.nt>   (packageRoot has dist/worker-node.mjs + dist/index.js)
// One fresh process, one fresh reasoner, init excluded. Prints one JSON line.
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { Store, Parser, DataFactory } from 'n3';
const [root, fixture] = process.argv.slice(2);
class WorkerShim {
  constructor() { this.w = new NodeWorker(`${root}/dist/worker-node.mjs`); this.m = new Map(); }
  postMessage(msg) { this.w.postMessage(msg); }
  addEventListener(type, fn) {
    const wrapped = type === 'message' ? (d) => fn({ data: d }) : type === 'error' ? (e) => fn({ message: e?.message ?? String(e) }) : fn;
    this.m.set(fn, wrapped); this.w.on(type, wrapped);
  }
  removeEventListener(type, fn) { const w = this.m.get(fn); if (w) this.w.off(type, w); }
  terminate() { this.w.terminate(); }
}
globalThis.Worker = WorkerShim;
const { RdfReasoner } = await import(`${root}/dist/index.js`);
const store = new Store(new Parser({ format: 'N-Triples' }).parse(readFileSync(fixture, 'utf8')));
const reasoner = new RdfReasoner(process.env.TRACE ? { onTrace: (m) => console.error(m) } : undefined);
await reasoner.ready;
const c0 = process.cpuUsage(); const t0 = performance.now();
const ok = await reasoner.checkConsistency(store);
const t1 = performance.now();
const inferredGraph = DataFactory.namedNode('urn:test:inferred');
const r = await reasoner.materialize(store, { includeClassHierarchy: true, inferredGraph, returnDelta: true });
const t2 = performance.now();
const cpu = process.cpuUsage(c0);
const inferred = store.getQuads(null, null, null, inferredGraph).length;
console.log(JSON.stringify({ ok, cons: Math.round(t1 - t0), mat: Math.round(t2 - t1), total: Math.round(t2 - t0), inferred, procCpuS: +((cpu.user + cpu.system) / 1e6).toFixed(1) }));
reasoner.terminate();
process.exit(0);
