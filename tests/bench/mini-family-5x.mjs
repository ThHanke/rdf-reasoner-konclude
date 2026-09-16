// 5x mini-family realization — check role count stability at small scale.
// Mirrors roberts-5x.mjs but uses the 12-individual mini-family fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNTriples, encodeQuadsForWasm, decodeWasmTripleBuffer, countByCategory } from './wasm-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const MODULE_PATH = join(__dirname, '../../dist/konclude.mjs');

const nt = readFileSync(join(FIXTURES, 'mini-family.nt'), 'utf8');
const { default: createModule } = await import(MODULE_PATH);
const quads = parseNTriples(nt);

const RUNS = parseInt(process.argv[2] || '5', 10);
const roleCounts = [];

for (let i = 1; i <= RUNS; i++) {
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
  if (!ok) throw new Error('realization() returned false');
  const inferred = decodeWasmTripleBuffer(Module, reasoner);
  const counts = countByCategory(inferred);
  roleCounts.push(counts.roleCount);
  console.log(`run${i}: total=${counts.total} type=${counts.typeCount} tbox=${counts.tboxCount} role=${counts.roleCount} sameAs=${counts.sameAsCount}`);
  reasoner.delete();
}

const unique = [...new Set(roleCounts)];
if (unique.length === 1) {
  console.log(`\nDETERMINISTIC: role count stable at ${unique[0]} across ${RUNS} runs`);
} else {
  console.log(`\nNONDETERMINISTIC: role counts vary — ${unique.join(', ')} (min=${Math.min(...roleCounts)}, max=${Math.max(...roleCounts)})`);
}
