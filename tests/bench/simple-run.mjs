// tests/bench/simple-run.mjs — the simplest possible TS-layer measurement: ONE fresh process, ONE fresh RdfReasoner, ONE call.
// usage: node tests/bench/simple-run.mjs <checkoutRoot> <fixture.nt[,more.nt]> <materialize|reason> [expl]
//   expl: request explanations (the call then also builds the justification graph).
// Prints one JSON line {ms, inferred, ...}. Everything else (alternation, repetition, statistics) is the caller's job.
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { Store, Parser } from 'n3';

const [root, fixture, op, flag] = process.argv.slice(2);
const withExpl = flag === 'expl';

class WorkerShim { // adapts worker_threads.Worker to the Web Worker surface RdfReasoner uses
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

const { RdfReasoner, INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI } = await import(`${root}/dist/index.js`);
const store = new Store(fixture.split(',').flatMap((f) => new Parser({ format: 'N-Triples' }).parse(readFileSync(f, 'utf8'))));
const before = store.size;

const reasoner = new RdfReasoner();
await reasoner.ready;
const t0 = performance.now();
if (op === 'materialize') await reasoner.materialize(store, { includeClassHierarchy: true, ...(withExpl ? { explanations: true } : {}) });
else if (withExpl) await reasoner.classify(store, { explanations: true });
else await reasoner.reason(store);
const ms = Math.round(performance.now() - t0);

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const inferred = store.getQuads(null, null, null, { termType: 'NamedNode', value: INFERRED_GRAPH_IRI });
const isTbox = (q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#subClassOf' || q.predicate.value === 'http://www.w3.org/2002/07/owl#equivalentClass';
const typeCount = inferred.filter((q) => q.predicate.value === RDF_TYPE).length;
const tboxCount = inferred.filter(isTbox).length;
const sameAsCount = inferred.filter((q) => q.predicate.value === 'http://www.w3.org/2002/07/owl#sameAs').length;
const explQuads = withExpl ? store.getQuads(null, null, null, { termType: 'NamedNode', value: EXPLANATION_GRAPH_IRI }).length : null;
console.log(JSON.stringify({ ms, inferred: inferred.length, typeCount, tboxCount, sameAsCount, roleCount: inferred.length - typeCount - tboxCount - sameAsCount, explQuads }));
reasoner.terminate();
process.exit(0);
