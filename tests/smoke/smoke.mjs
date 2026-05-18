// tests/smoke/smoke.mjs
// Usage: node tests/smoke/smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeTriplesForWasm, decodeWasmTripleBuffer } from '../bench/wasm-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const modulePath = join(__dirname, '../../dist/konclude.mjs');

const { default: createKoncludeModule } = await import(modulePath);

const NTriples_3class = `
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/C> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/B> .
<http://example.org/B> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/C> .
`.trim();

async function classify(Module, name, nts) {
  console.log(`[${name}] creating reasoner...`);
  const reasoner = new Module.KoncludeReasoner();
  try {
    console.log(`[${name}] loading triples...`);
    const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeTriplesForWasm(Module, nts.join('\n'));
    try {
      reasoner.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes);
    } finally {
      Module._free(triplePtr);
      Module._free(strTablePtr);
    }
    console.log(`[${name}] calling classify()...`);
    const ok = reasoner.classify();
    console.log(`[${name}] classify() returned: ${ok}`);
    if (!ok) throw new Error('classify() returned false');
    const inferred = decodeWasmTripleBuffer(Module, reasoner);
    console.log(`PASS: ${name}`);
    return inferred;
  } finally {
    reasoner.delete();
  }
}

async function main() {
  console.log('Loading WASM module...');
  const Module = await createKoncludeModule();
  console.log('Module ready.\n');

  // 3-class transitive subsumption (inline ontology)
  {
    const inferred = await classify(Module, '3-class transitivity', [NTriples_3class]);
    if (!inferred.includes('<http://example.org/A>') ||
        !inferred.includes('<http://example.org/C>') ||
        !inferred.includes('subClassOf')) {
      console.error('FAIL: A subClassOf C not found\nGot:', inferred);
      process.exit(1);
    }
  }

  // LUBM, GALEN, Roberts — all must classify without hanging
  await classify(Module, 'LUBM', [readFileSync(join(FIXTURES, 'lubm.nt'), 'utf8')]);
  await classify(Module, 'GALEN', [readFileSync(join(FIXTURES, 'galen.nt'), 'utf8')]);
  await classify(Module, 'Roberts Family', [readFileSync(join(FIXTURES, 'roberts-family.nt'), 'utf8')]);

  console.log('\nAll smoke tests passed.');
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
