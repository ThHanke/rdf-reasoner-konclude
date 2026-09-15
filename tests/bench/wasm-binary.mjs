// tests/bench/wasm-binary.mjs
// Binary encode/decode helpers for direct WASM use in bench and smoke scripts.
// Mirrors the loadTripleBuffer / getInferredTripleBuffer path in ts/worker.ts.

import { Parser } from 'n3';
import { encodeToBuffers, decodeBuffers } from '../../dist/intern.js';

/**
 * Parse an NTriples string into an array of Quad objects (outside timing window).
 */
export function parseNTriples(ntriplesString) {
  return new Parser({ format: 'N-Triples' }).parse(ntriplesString);
}

/**
 * Encode pre-parsed Quads into WASM heap buffers ready for loadTripleBuffer().
 * Returns { triplePtr, tripleCount, strTablePtr, strBytes }.
 * Caller MUST call mod._free(triplePtr) and mod._free(strTablePtr) after use.
 * Use this instead of encodeTriplesForWasm to exclude NTriples parsing from timing.
 */
export function encodeQuadsForWasm(mod, quads) {
  const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);

  const tripleCount = tripleBuffer.byteLength / 12;
  const triplePtr = mod._malloc(tripleBuffer.byteLength);
  const strTablePtr = mod._malloc(strTableBuffer.byteLength);
  mod.HEAPU8.set(new Uint8Array(tripleBuffer), triplePtr);
  mod.HEAPU8.set(new Uint8Array(strTableBuffer), strTablePtr);

  return { triplePtr, tripleCount, strTablePtr, strBytes: strTableBuffer.byteLength };
}

/**
 * Encode an NTriples string into WASM heap buffers ready for loadTripleBuffer().
 * Includes NTriples parsing in the call — use encodeQuadsForWasm to exclude it.
 */
export function encodeTriplesForWasm(mod, ntriplesString) {
  return encodeQuadsForWasm(mod, parseNTriples(ntriplesString));
}

/**
 * Decode the WASM inferred triple buffer into an array of Quad objects.
 * Calls buildInferredTripleBuffer() + getInferredTripleBufferPtr() on the reasoner.
 */
export function decodeWasmTripleBuffer(mod, reasoner) {
  const len = reasoner.buildInferredTripleBuffer();
  if (len === 0) return [];
  const ptr = reasoner.getInferredTripleBufferPtr();
  const combined = mod.HEAPU8.slice(ptr, ptr + len).buffer;
  return decodeBuffers(combined);
}

/**
 * Count inferred quads broken down by category:
 *   - tboxCount:  rdfs:subClassOf / owl:equivalentClass (TBox classification output)
 *   - typeCount:  rdf:type (ABox ClassAssertion — comparable to native Konclude realization output)
 *   - roleCount:  ObjectPropertyAssertion + DataPropertyAssertion (WASM-only, native has no output path)
 *   - sameAsCount: owl:sameAs (WASM-only for multi-filler FP/IFP; native hangs on those cases)
 *   - total: all
 */
export function countByCategory(quads) {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const SUBCLASS  = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
  const EQUIV     = 'http://www.w3.org/2002/07/owl#equivalentClass';
  const SAME_AS   = 'http://www.w3.org/2002/07/owl#sameAs';
  let typeCount = 0, tboxCount = 0, roleCount = 0, sameAsCount = 0;
  for (const q of quads) {
    const p = q.predicate.value;
    if (p === RDF_TYPE)              typeCount++;
    else if (p === SUBCLASS || p === EQUIV) tboxCount++;
    else if (p === SAME_AS)          sameAsCount++;
    else                             roleCount++;
  }
  return { typeCount, tboxCount, roleCount, sameAsCount, total: quads.length };
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
