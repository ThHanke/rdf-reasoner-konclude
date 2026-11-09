// tests/bench/repair-case.mjs — one repair() measurement: ONE fresh process, ONE fresh RdfReasoner, ONE repair() call.
// usage: node tests/bench/repair-case.mjs <checkoutRoot> <base.nt[,more.nt]> <disjoint|unsat|cardinality|three|bfo> [timeoutMs]
// Checks that the base is consistent, adds a clash (synthetic, in a fresh namespace independent of the ontology; 'bfo' is a
// real BFO disjointness clash for PMDco), runs repair(), applies the first repair to a copy and re-checks.
// Prints one line: RESULT {json}.
import { Worker as NodeWorker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { Store, Parser } from "n3";
import { CLASHES } from "./repair-clashes.mjs";

const [root, baseFiles, clash, timeoutArg] = process.argv.slice(2);
const timeout = Number(timeoutArg ?? 240000);

class WorkerShim {
  constructor() {
    this.w = new NodeWorker(`${root}/dist/worker-node.mjs`);
    this.m = new Map();
  }
  postMessage(msg) {
    this.w.postMessage(msg);
  }
  addEventListener(type, fn) {
    const wrapped =
      type === "message"
        ? (d) => fn({ data: d })
        : type === "error"
          ? (e) => fn({ message: e?.message ?? String(e) })
          : fn;
    this.m.set(fn, wrapped);
    this.w.on(type, wrapped);
  }
  removeEventListener(type, fn) {
    const w = this.m.get(fn);
    if (w) this.w.off(type, w);
  }
  terminate() {
    this.w.terminate();
  }
}
globalThis.Worker = WorkerShim;

const { RdfReasoner } = await import(`${root}/dist/index.js`);
const clashQuads = CLASHES[clash].build();

const base = baseFiles
  .split(",")
  .flatMap((f) =>
    new Parser({ format: "N-Triples" }).parse(readFileSync(f, "utf8")),
  );
const store = new Store([...base, ...clashQuads]);
const sizeBefore = store.size;

const r = new RdfReasoner();
await r.ready;
let checks = 0,
  recycles = 0,
  maxHeap = 0,
  checkMs = 0;
const origCheck = r._boundedInconsistencyCheck.bind(r);
r._boundedInconsistencyCheck = async (q, d) => {
  const t = performance.now();
  const res = await origCheck(q, d);
  checks++;
  checkMs += performance.now() - t;
  maxHeap = Math.max(maxHeap, r._lastHeapBytes);
  return res;
};
const origRec = r._recycleWorkerInSlot.bind(r);
r._recycleWorkerInSlot = async () => {
  await origRec();
  recycles++;
};

const out = { clash, baseQuads: base.length, quads: sizeBefore };
try {
  // The base must be consistent, otherwise repair() also reports the base's own justifications (invalid benchmark case).
  let t = performance.now();
  out.baseConsistent = await r.checkConsistency(new Store(base));
  out.baseCheckMs = Math.round(performance.now() - t);
  t = performance.now();
  out.firstCheckConsistent = await r.checkConsistency(store);
  out.firstCheckMs = Math.round(performance.now() - t);
  checks = 0;
  checkMs = 0;
  maxHeap = 0;
  recycles = 0;
  t = performance.now();
  const res = await r.repair(store, { timeout });
  out.repairMs = Math.round(performance.now() - t);
  out.checks = checks;
  out.avgCheckMs = checks ? Math.round(checkMs / checks) : 0;
  out.recycles = recycles;
  out.maxHeapMB = Math.round(maxHeap / 1048576);
  out.consistentInput = res.consistent;
  out.incomplete = res.incomplete;
  out.reason = res.reason ?? null;
  out.justifications = res.justifications.map((j) => j.axioms.length);
  out.repairs = res.repairs.map((x) => x.remove.length);
  out.allVerified =
    res.repairs.length > 0 &&
    res.repairs.every((x) => x.verifiedConsistent === true);
  out.storeUntouched = store.size === sizeBefore;
  if (res.repairs.length) {
    const copy = new Store(store.getQuads(null, null, null, null));
    for (const q of res.repairs[0].remove.flatMap((a) => a.quads))
      copy.removeQuad(q);
    t = performance.now();
    out.consistentAfterApply = await r.checkConsistency(copy);
    out.applyCheckMs = Math.round(performance.now() - t);
  }
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 200);
}
console.log("RESULT " + JSON.stringify(out));
try {
  r.terminate();
} catch {}
process.exit(0);
