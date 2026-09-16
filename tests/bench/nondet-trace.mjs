// Run Roberts at a specific ABox size and capture [NONDET-DBG] stderr lines.
// Usage: node --expose-gc tests/bench/nondet-trace.mjs [SIZE] [RUNS]
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
const RUNS = parseInt(process.argv[3] || '2', 10);

for (let i = 0; i < RUNS; i++) {
  console.log(`\n=== RUN ${i+1}/${RUNS} SIZE=${SIZE} ===`);
  const dbgLines = [];
  const quads = SIZE >= 405 ? allQuads : stripToN(SIZE);

  const Module = await createModule({
    print: () => {},
    printErr: (msg) => {
      if (msg.includes('[NONDET-DBG]')) {
        dbgLines.push(msg);
      }
    }
  });

  const reasoner = new Module.KoncludeReasoner();
  const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeQuadsForWasm(Module, quads);
  try {
    reasoner.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes, true);
  } finally {
    Module._free(triplePtr);
    Module._free(strTablePtr);
  }

  const ok = reasoner.realization();
  if (!ok) throw new Error(`realization() failed`);

  const inferred = decodeWasmTripleBuffer(Module, reasoner);
  const counts = countByCategory(inferred);

  console.log(`roleCount=${counts.roleCount}`);
  console.log(`[NONDET-DBG] lines: ${dbgLines.length}`);
  for (const line of dbgLines) {
    console.log(line);
  }

  reasoner.delete();
  if (global.gc) global.gc();
}
