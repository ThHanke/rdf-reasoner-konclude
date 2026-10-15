// tests/bench/simple-warm.mjs — ONE fresh process, ONE RdfReasoner, four calls (cold / unchanged / new Store / one axiom added).
// usage: node tests/bench/simple-warm.mjs <checkoutRoot> <fixture.nt[,more.nt]> <materialize|reason>
// Kernel counters (syncStats) are asserted for each scenario so a label can never describe something the kernel did not do.
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { Store, Parser, DataFactory } from 'n3';

const [root, fixture, op] = process.argv.slice(2);

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
const quads = fixture.split(',').flatMap((f) => new Parser({ format: 'N-Triples' }).parse(readFileSync(f, 'utf8')));
const reasoner = new RdfReasoner();
await reasoner.ready;
const call = (store) => (op === 'materialize' ? reasoner.materialize(store, { includeClassHierarchy: true }) : reasoner.reason(store));
const time = async (store) => { const t = performance.now(); await call(store); return Math.round(performance.now() - t); };
const stats = () => reasoner._call('syncStats', []);
const fail = (m) => { console.log(JSON.stringify({ error: m })); process.exit(1); };

const store1 = new Store(quads);
const cold = await time(store1);
const s0 = await stats();
const unchanged = await time(store1);
const s1 = await stats();
if (s1.rebuilds !== s0.rebuilds || s1.generation !== s0.generation) fail('unchanged call rebuilt the ontology');
const newStore = await time(new Store(quads));
const s2 = await stats();
if (s2.rebuilds !== s0.rebuilds || s2.generation !== s0.generation) fail('identical content in a new Store rebuilt the ontology');
const changedStore = new Store(quads);
changedStore.addQuad(DataFactory.namedNode('http://bench.example/IncrementalTestClass'), DataFactory.namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), DataFactory.namedNode('http://www.w3.org/2002/07/owl#Thing'));
const changed = await time(changedStore);
const s3 = await stats();
if (s3.rebuilds !== s0.rebuilds + 1 || s3.generation !== s0.generation + 1) fail('changed content did not trigger exactly one rebuild');
console.log(JSON.stringify({ cold, unchanged, newStore, changed }));
reasoner.terminate();
process.exit(0);
