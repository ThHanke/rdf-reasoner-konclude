import createKoncludeModule from '../../dist/konclude.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeTriplesForWasm, decodeWasmTripleBuffer } from './wasm-binary.mjs';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

const Module = await createKoncludeModule();

for (const [name, files, out] of [
  ['lubm',    ['lubm.nt'], 'lubm-wasm-out.nt'],
  ['roberts', ['roberts-family.nt'], 'roberts-wasm-out.nt'],
  ['galen',   ['galen.nt'], 'galen-wasm-out.nt'],
]) {
  const r = new Module.KoncludeReasoner();
  const nts = files.map(f => readFileSync(join(FIXTURES, f), 'utf8'));
  const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeTriplesForWasm(Module, nts.join('\n'));
  try {
    r.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes);
  } finally {
    Module._free(triplePtr);
    Module._free(strTablePtr);
  }
  r.classify();
  const result = decodeWasmTripleBuffer(Module, r);
  r.delete();
  writeFileSync(join(FIXTURES, out), result);
  console.log(name, result.split('\n').filter(l=>l.trim()).length, 'triples');
}
