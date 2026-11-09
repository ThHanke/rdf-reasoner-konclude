// tests/bench/repair-example.mjs — print the REAL result of RdfReasoner.repair() for one benchmark case, in readable form.
// usage: node tests/bench/repair-example.mjs <checkoutRoot> <base.nt[,more.nt]> <disjoint|unsat|cardinality|three|bfo> [timeoutMs]
import { Worker as NodeWorker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { Store, Parser } from "n3";
import { CLASHES } from "./repair-clashes.mjs";

const [root, baseFiles, clash, timeoutArg] = process.argv.slice(2);
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

const PREFIXES = [
  ["http://bench.example/", "bx:"],
  ["http://purl.obolibrary.org/obo/", "obo:"],
  ["http://www.w3.org/2002/07/owl#", "owl:"],
  ["http://www.w3.org/2000/01/rdf-schema#", "rdfs:"],
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:"],
  ["http://www.w3.org/2001/XMLSchema#", "xsd:"],
];
const blanks = new Map();
const term = (t) => {
  if (t.termType === "BlankNode") {
    if (!blanks.has(t.value)) blanks.set(t.value, `_:b${blanks.size + 1}`);
    return blanks.get(t.value);
  }
  if (t.termType === "Literal") return `"${t.value}"`;
  const p = PREFIXES.find(([ns]) => t.value.startsWith(ns));
  return p ? p[1] + t.value.slice(p[0].length) : `<${t.value}>`;
};
const triple = (q) =>
  `${term(q.subject)} ${term(q.predicate)} ${term(q.object)}`;
const axiom = (a) =>
  `${triple(a.principal)}${a.quads.length > 1 ? `   [+${a.quads.length - 1} more triple(s) of the same axiom]` : ""}`;

const base = baseFiles
  .split(",")
  .flatMap((f) =>
    new Parser({ format: "N-Triples" }).parse(readFileSync(f, "utf8")),
  );
const store = new Store([...base, ...CLASHES[clash].build()]);
const r = new RdfReasoner();
await r.ready;
const t0 = performance.now();
const res = await r.repair(store, { timeout: Number(timeoutArg ?? 240000) });
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(
  `ontology: ${base.length} quads + injected clash "${clash}"   repair() took ${secs} s`,
);
console.log(
  `consistent: ${res.consistent}   incomplete: ${res.incomplete}${res.reason ? `   reason: ${res.reason}` : ""}`,
);
console.log(`\njustifications (${res.justifications.length}):`);
res.justifications.forEach((j, i) => {
  console.log(
    `  [${i}] ${j.axioms.length} axioms, ${j.context.length} declaration triples in context`,
  );
  j.axioms.forEach((a) => console.log(`        ${axiom(a)}`));
});
console.log(`\nrepairs (${res.repairs.length}):`);
res.repairs.forEach((x, i) => {
  console.log(
    `  [${i}] remove ${x.remove.length} axiom(s); covers justifications [${x.covers}]; verifiedConsistent: ${x.verifiedConsistent}; minimal: ${x.minimal}`,
  );
  x.remove.forEach((a) => console.log(`        - ${axiom(a)}`));
});
try {
  r.terminate();
} catch {}
process.exit(0);
