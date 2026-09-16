// Compare inferred triples between 2 runs at a nondeterministic size to find missing roles.
// Usage: node --expose-gc tests/bench/nondet-diff.mjs [SIZE]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNTriples, encodeQuadsForWasm, decodeWasmTripleBuffer, countByCategory } from './wasm-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const MODULE_PATH = join(__dirname, '../../dist/konclude.mjs');

const nt = readFileSync(join(FIXTURES, 'roberts-family.nt'), 'utf8');
const allQuads = parseNTriples(nt);
const { default: createModule } = await import(MODULE_PATH);

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_NI = 'http://www.w3.org/2002/07/owl#NamedIndividual';

const allIndividuals = [];
for (const q of allQuads) {
  if (q.subject.termType === 'NamedNode' && q.predicate.value === RDF_TYPE && q.object.value === OWL_NI) {
    allIndividuals.push(q.subject.value);
  }
}

function stripToN(n) {
  const keep = new Set(allIndividuals.slice(0, n));
  const allSet = new Set(allIndividuals);
  return allQuads.filter(q => {
    if (q.subject.termType !== 'NamedNode') return true;
    if (!allSet.has(q.subject.value)) return true;
    return keep.has(q.subject.value);
  });
}

const SIZE = parseInt(process.argv[2] || '320', 10);

function tripleKey(q) {
  return `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
}

async function runOnce(quads) {
  const Module = await createModule({ print: () => {}, printErr: () => {} });
  const reasoner = new Module.KoncludeReasoner();
  const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeQuadsForWasm(Module, quads);
  try {
    reasoner.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes, true);
  } finally {
    Module._free(triplePtr);
    Module._free(strTablePtr);
  }
  const ok = reasoner.realization();
  if (!ok) throw new Error('realization() failed');
  const inferred = decodeWasmTripleBuffer(Module, reasoner);
  reasoner.delete();
  if (global.gc) global.gc();
  return inferred;
}

const quads = SIZE >= 405 ? allQuads : stripToN(SIZE);

console.log(`Running 2 iterations at SIZE=${SIZE}...`);
const run1 = await runOnce(quads);
const run2 = await runOnce(quads);

const counts1 = countByCategory(run1);
const counts2 = countByCategory(run2);
console.log(`Run 1: types=${counts1.typeCount} roles=${counts1.roleCount}`);
console.log(`Run 2: types=${counts2.typeCount} roles=${counts2.roleCount}`);

if (counts1.roleCount === counts2.roleCount) {
  console.log('Both runs identical. Try again or use a different size.');
  process.exit(0);
}

// Find role triples only (not rdf:type)
const BASE = 'http://www.co-ode.org/roberts/family-tree.owl#';
function isRole(q) {
  return q.predicate.value !== RDF_TYPE && q.predicate.value.startsWith(BASE);
}

const roles1 = new Set(run1.filter(isRole).map(tripleKey));
const roles2 = new Set(run2.filter(isRole).map(tripleKey));

const onlyIn1 = [...roles1].filter(k => !roles2.has(k));
const onlyIn2 = [...roles2].filter(k => !roles1.has(k));

console.log(`\nRoles only in run 1 (${onlyIn1.length}):`);
// Summarize by predicate
const pred1 = {};
for (const k of onlyIn1) {
  const parts = k.split(' ');
  const pred = parts[1].replace(BASE, '');
  pred1[pred] = (pred1[pred] || 0) + 1;
}
for (const [pred, count] of Object.entries(pred1).sort((a,b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${pred}: ${count}`);
}

console.log(`\nRoles only in run 2 (${onlyIn2.length}):`);
const pred2 = {};
for (const k of onlyIn2) {
  const parts = k.split(' ');
  const pred = parts[1].replace(BASE, '');
  pred2[pred] = (pred2[pred] || 0) + 1;
}
for (const [pred, count] of Object.entries(pred2).sort((a,b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${pred}: ${count}`);
}

// Show a sample of the actual triples
console.log(`\nSample roles only in run 1:`);
for (const k of onlyIn1.slice(0, 10)) {
  const parts = k.split(' ');
  console.log(`  ${parts[0].replace(BASE, '')} ${parts[1].replace(BASE, '')} ${parts[2].replace(BASE, '')}`);
}
console.log(`\nSample roles only in run 2:`);
for (const k of onlyIn2.slice(0, 10)) {
  const parts = k.split(' ');
  console.log(`  ${parts[0].replace(BASE, '')} ${parts[1].replace(BASE, '')} ${parts[2].replace(BASE, '')}`);
}
