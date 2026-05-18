import { readFileSync } from 'fs';
import { encodeTriplesForWasm, decodeWasmTripleBuffer } from './wasm-binary.mjs';

async function run() {
  const { default: createModule } = await import('../../dist/konclude.mjs');
  const mod = await createModule();
  const r = new mod.KoncludeReasoner();

  const galen = readFileSync(new URL('../fixtures/galen.nt', import.meta.url), 'utf8');
  console.log('Loading GALEN...');
  const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeTriplesForWasm(mod, galen);
  try {
    r.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes);
  } finally {
    mod._free(triplePtr);
    mod._free(strTablePtr);
  }
  console.log('Classifying GALEN...');
  try {
    const ok = r.classify();
    console.log('classify ok:', ok);
    const out = decodeWasmTripleBuffer(mod, r);
    console.log('triples:', out.split('\n').filter(Boolean).length);
  } catch (e) {
    console.error('CAUGHT:', String(e));
    console.error('STACK:', e.stack);
  }
}
run().catch(e => { console.error('TOP:', String(e)); console.error(e.stack); });
