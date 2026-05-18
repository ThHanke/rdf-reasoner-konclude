// tests/bench/wasm-binary.mjs
// Binary encode/decode helpers for direct WASM use in bench and smoke scripts.
// Mirrors the loadTripleBuffer / getInferredTripleBuffer path in ts/worker.ts.

import { Parser } from 'n3';
import { encodeToBuffers, decodeBuffers } from '../../dist/intern.js';

/**
 * Encode an NTriples string into WASM heap buffers ready for loadTripleBuffer().
 * Returns { triplePtr, tripleCount, strTablePtr, strBytes }.
 * Caller MUST call mod._free(triplePtr) and mod._free(strTablePtr) after use.
 */
export function encodeTriplesForWasm(mod, ntriplesString) {
  const quads = new Parser({ format: 'N-Triples' }).parse(ntriplesString);
  const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);

  const tripleCount = tripleBuffer.byteLength / 12;
  const triplePtr = mod._malloc(tripleBuffer.byteLength);
  const strTablePtr = mod._malloc(strTableBuffer.byteLength);
  mod.HEAPU8.set(new Uint8Array(tripleBuffer), triplePtr);
  mod.HEAPU8.set(new Uint8Array(strTableBuffer), strTablePtr);

  return { triplePtr, tripleCount, strTablePtr, strBytes: strTableBuffer.byteLength };
}

/**
 * Decode the WASM inferred triple buffer into an NTriples string.
 * Calls buildInferredTripleBuffer() + getInferredTripleBufferPtr() on the reasoner.
 */
export function decodeWasmTripleBuffer(mod, reasoner) {
  const len = reasoner.buildInferredTripleBuffer();
  if (len === 0) return '';
  const ptr = reasoner.getInferredTripleBufferPtr();
  const combined = mod.HEAPU8.slice(ptr, ptr + len).buffer;
  return quadsToNTriples(decodeBuffers(combined));
}

function quadsToNTriples(quads) {
  if (quads.length === 0) return '';
  return quads.map(q => `${termToNT(q.subject)} ${termToNT(q.predicate)} ${termToNT(q.object)} .`).join('\n') + '\n';
}

function termToNT(term) {
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType === 'Literal') {
    const escaped = term.value
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    if (term.language) return `"${escaped}"@${term.language}`;
    if (term.datatype?.value) return `"${escaped}"^^<${term.datatype.value}>`;
    return `"${escaped}"`;
  }
  return `<${term.value}>`;
}
