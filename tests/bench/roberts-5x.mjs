// Quick 5x Roberts realization — check role count stability.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNTriples, encodeQuadsForWasm, decodeWasmTripleBuffer, countByCategory } from './wasm-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const MODULE_PATH = join(__dirname, '../../dist/konclude.mjs');

const nt = readFileSync(join(FIXTURES, 'roberts-family.nt'), 'utf8');
const { default: createModule } = await import(MODULE_PATH);
const quads = parseNTriples(nt);

for (let i = 1; i <= 5; i++) {
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
  console.log(`run${i}: total=${counts.total} type=${counts.typeCount} tbox=${counts.tboxCount} role=${counts.roleCount} sameAs=${counts.sameAsCount}`);
  reasoner.delete();
}
