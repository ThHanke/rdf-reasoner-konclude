// Find the nondeterminism threshold in Roberts by testing specific ABox sizes.
// Runs 3x at each size (memory-efficient: one Module per run).
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

const SIZES = (process.argv[2] || '350,375,405').split(',').map(Number);
const RUNS = parseInt(process.argv[3] || '3', 10);

for (const size of SIZES) {
  const quads = size >= 405 ? allQuads : stripToN(size);
  const roleCounts = [];

  for (let i = 0; i < RUNS; i++) {
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
    if (!ok) throw new Error(`realization() failed at ${size}/${i+1}`);
    const inferred = decodeWasmTripleBuffer(Module, reasoner);
    const counts = countByCategory(inferred);
    roleCounts.push(counts.roleCount);
    reasoner.delete();
    // Force GC between runs to avoid OOM
    if (global.gc) global.gc();
  }

  const unique = [...new Set(roleCounts)];
  const status = unique.length === 1 ? 'DETERM' : 'NONDET';
  console.log(`${size} indiv: ${status} role=[${roleCounts.join(',')}]`);
  if (unique.length > 1) {
    console.log(`  spread=${Math.max(...roleCounts)-Math.min(...roleCounts)}`);
  }
}
