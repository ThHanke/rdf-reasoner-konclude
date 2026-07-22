import type { Store } from "n3";
import type { EncodedBuffers } from "./intern.js";
import {
  INFERRED_GRAPH_IRI,
  HYPOTHETICAL_IRI,
  EXPLANATION_GRAPH_IRI,
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "./types.js";

/**
 * Convert a decoded buffer term string + type tag to N3's internal termToId
 * format (the string key used in _ids/_entities).
 *
 * Type tags match intern.ts convention:
 *   0 = NamedNode, 1 = BlankNode, 2 = Literal
 */
export function toN3EntityKey(raw: string, type: number): string {
  switch (type) {
    case 0:
      return raw;
    case 1:
      return `_:${raw}`;
    case 2: {
      const nul1 = raw.indexOf("\0");
      const value = nul1 >= 0 ? raw.slice(0, nul1) : raw;
      const rest = nul1 >= 0 ? raw.slice(nul1 + 1) : "";
      const nul2 = rest.indexOf("\0");
      const datatype = nul2 >= 0 ? rest.slice(0, nul2) : rest;
      const language = nul2 >= 0 ? rest.slice(nul2 + 1) : "";
      if (language) return `"${value}"@${language}`;
      if (datatype && datatype !== "http://www.w3.org/2001/XMLSchema#string")
        return `"${value}"^^${datatype}`;
      return `"${value}"`;
    }
    default:
      return raw;
  }
}

/**
 * Validate that the N3 Store exposes the internal structures we rely on.
 * Throws if N3's internals changed (version mismatch).
 */
export function assertN3Internals(store: Store): void {
  const s = store as any;
  if (!s._entityIndex || typeof s._entityIndex._ids !== "object" || typeof s._entityIndex._id !== "number") {
    throw new Error(
      "N3 Store internals changed: _entityIndex._ids or _entityIndex._id missing. " +
      "Check n3 package version compatibility.",
    );
  }
  if (typeof s._graphs !== "object") {
    throw new Error(
      "N3 Store internals changed: _graphs missing. " +
      "Check n3 package version compatibility.",
    );
  }
}

/**
 * Get or create a numeric ID for an entity string in the N3 Store's index.
 */
export function getOrCreateId(store: Store, entityStr: string): number {
  const ei = (store as any)._entityIndex;
  let id = ei._ids[entityStr];
  if (id === undefined) {
    id = ++ei._id;
    ei._ids[entityStr] = id;
    ei._entities[id] = entityStr;
  }
  return id;
}

/**
 * Get or create a numeric ID for a quoted triple (RDF-star).
 * N3 represents quoted triples as ".sId.pId.oId" in _entities.
 */
export function getOrCreateQuotedTripleId(
  store: Store,
  sId: number,
  pId: number,
  oId: number,
): number {
  return getOrCreateId(store, `.${sId}.${pId}.${oId}`);
}

/**
 * Insert a quad directly into N3's three-layer index.
 * Returns true if the quad was new, false if it already existed.
 */
export function injectQuad(
  store: Store,
  sId: number,
  pId: number,
  oId: number,
  gId: number,
): boolean {
  const s = store as any;
  let graphItem = s._graphs[gId];
  if (!graphItem) {
    graphItem = s._graphs[gId] = { subjects: {}, predicates: {}, objects: {} };
    Object.freeze(graphItem);
  }

  const si1 = graphItem.subjects[sId] || (graphItem.subjects[sId] = {});
  const si2 = si1[pId] || (si1[pId] = {});
  const existed = oId in si2;
  if (existed) return false;
  si2[oId] = null;

  const pi1 = graphItem.predicates[pId] || (graphItem.predicates[pId] = {});
  const pi2 = pi1[oId] || (pi1[oId] = {});
  pi2[sId] = null;

  const oi1 = graphItem.objects[oId] || (graphItem.objects[oId] = {});
  const oi2 = oi1[sId] || (oi1[sId] = {});
  oi2[pId] = null;

  s._size = null;
  return true;
}

/**
 * Remove an entire named graph from the store by deleting its index entry.
 * More efficient than store.removeQuads(store.getQuads(...)) — no Quad allocation.
 */
export function clearGraph(store: Store, graphId: string): void {
  const s = store as any;
  const gId = s._entityIndex._ids[graphId];
  if (gId !== undefined && s._graphs[gId]) {
    delete s._graphs[gId];
    s._size = null;
  }
}

const EXCLUDED_GRAPHS = new Set([INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI]);

/**
 * Convert an N3 internal entity string back to intern.ts format (raw + type tag).
 * Reverse of toN3EntityKey.
 */
export function fromN3EntityKey(entityStr: string): { raw: string; type: 0 | 1 | 2 } {
  if (entityStr.startsWith("_:")) {
    return { raw: entityStr.slice(2), type: 1 };
  }
  if (entityStr.startsWith('"')) {
    // Find closing quote: last " followed by @, ^^, or end-of-string
    let closingQuote = entityStr.length - 1;
    while (closingQuote > 0) {
      if (entityStr[closingQuote] === '"') {
        const after = entityStr[closingQuote + 1];
        if (after === undefined || after === "@" || after === "^") break;
      }
      closingQuote--;
    }
    const value = entityStr.slice(1, closingQuote);
    const suffix = entityStr.slice(closingQuote + 1);
    if (suffix.startsWith("@")) {
      return { raw: `${value}\0\0${suffix.slice(1)}`, type: 2 };
    }
    if (suffix.startsWith("^^")) {
      return { raw: `${value}\0${suffix.slice(2)}\0`, type: 2 };
    }
    return { raw: `${value}\0\0`, type: 2 };
  }
  return { raw: entityStr, type: 0 };
}

const enc = new TextEncoder();

/**
 * Build binary buffers directly from N3 Store internals, bypassing getQuads().
 * Produces identical output to encodeToBuffers(store.getQuads(null,null,null,null))
 * after inferred/hypothetical/explanation graphs have been removed.
 */
export function encodeStoreToBuffers(store: Store): EncodedBuffers {
  assertN3Internals(store);
  const s = store as any;
  const entities = s._entityIndex._entities;
  const graphs = s._graphs;

  // Map N3 entity IDs → intern table indices (with type tags baked in)
  const idMap = new Map<number, number>();
  const internEntries: Uint8Array[] = [];

  const resolveId = (n3Id: number): number => {
    let internId = idMap.get(n3Id);
    if (internId !== undefined) return internId;

    const entityStr = entities[n3Id] as string;
    const { raw, type } = fromN3EntityKey(entityStr);
    const idx = internEntries.length;
    internEntries.push(enc.encode(raw));
    internId = (idx & 0x3FFFFFFF) | (type << 30);
    idMap.set(n3Id, internId);
    return internId;
  };

  // Iterate all graphs, collect triples
  const tripleIds: number[] = [];

  for (const gIdStr of Object.keys(graphs)) {
    const gId = Number(gIdStr);
    const graphEntity = entities[gId] as string;
    if (graphEntity && EXCLUDED_GRAPHS.has(graphEntity)) continue;

    const graphItem = graphs[gId];
    const subjects = graphItem.subjects;
    for (const sIdStr of Object.keys(subjects)) {
      const sId = resolveId(Number(sIdStr));
      const predicates = subjects[sIdStr];
      for (const pIdStr of Object.keys(predicates)) {
        const pId = resolveId(Number(pIdStr));
        const objects = predicates[pIdStr];
        for (const oIdStr of Object.keys(objects)) {
          tripleIds.push(sId, pId, resolveId(Number(oIdStr)));
        }
      }
    }
  }

  // Build string table buffer
  const count = internEntries.length;
  const headerBytes = 4 + 4 * count;
  let dataBytes = 0;
  for (const e of internEntries) dataBytes += e.byteLength;

  const strTableBuffer = new ArrayBuffer(headerBytes + dataBytes);
  const strDv = new DataView(strTableBuffer);
  const strU8 = new Uint8Array(strTableBuffer);

  strDv.setUint32(0, count, true);
  let offset = 0;
  let dataPos = headerBytes;
  for (let i = 0; i < count; i++) {
    strDv.setUint32(4 + 4 * i, offset, true);
    const entry = internEntries[i];
    strU8.set(entry, dataPos);
    offset += entry.byteLength;
    dataPos += entry.byteLength;
  }

  const tripleBuffer = new Uint32Array(tripleIds).buffer;

  return { tripleBuffer, strTableBuffer };
}

/**
 * Convert an N3 entity string to NTriples format for fingerprinting.
 *
 * N3's entity format: "VALUE"@lang, "VALUE"^^datatype, or "VALUE"
 * VALUE may contain unescaped " characters. Find the closing quote by
 * scanning backwards for a " followed by @, ^^, or end-of-string.
 */
function entityToNTriples(entityStr: string): string {
  if (entityStr.startsWith("_:")) {
    return entityStr;
  }
  if (entityStr.startsWith('"')) {
    let closingQuote = entityStr.length - 1;
    // Scan backwards for the closing quote: it's the last " followed by @, ^^, or EOS
    while (closingQuote > 0) {
      if (entityStr[closingQuote] === '"') {
        const after = entityStr[closingQuote + 1];
        if (after === undefined || after === "@" || after === "^") break;
      }
      closingQuote--;
    }
    const value = entityStr.slice(1, closingQuote);
    const suffix = entityStr.slice(closingQuote + 1);
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    if (suffix.startsWith("@")) {
      return `"${escaped}"${suffix}`;
    }
    if (suffix.startsWith("^^")) {
      return `"${escaped}"^^<${suffix.slice(2)}>`;
    }
    // N3 suppresses xsd:string — but N3 DataFactory still sets term.datatype
    // to xsd:string, so computeStoreFingerprint emits it. Match that.
    return `"${escaped}"^^<http://www.w3.org/2001/XMLSchema#string>`;
  }
  return `<${entityStr}>`;
}

/**
 * Compute store fingerprint directly from N3 internals, bypassing getQuads().
 * Produces identical output to computeStoreFingerprint(store.getQuads(...)).
 */
export function computeStoreFingerprintDirect(store: Store): string {
  assertN3Internals(store);
  const s = store as any;
  const entities = s._entityIndex._entities;
  const graphs = s._graphs;

  const strings: string[] = [];

  for (const gIdStr of Object.keys(graphs)) {
    const gId = Number(gIdStr);
    const graphEntity = entities[gId] as string;
    if (graphEntity && EXCLUDED_GRAPHS.has(graphEntity)) continue;

    const graphItem = graphs[gId];
    const subjects = graphItem.subjects;
    for (const sIdStr of Object.keys(subjects)) {
      const sNt = entityToNTriples(entities[Number(sIdStr)]);
      const predicates = subjects[sIdStr];
      for (const pIdStr of Object.keys(predicates)) {
        const pNt = entityToNTriples(entities[Number(pIdStr)]);
        const objects = predicates[pIdStr];
        for (const oIdStr of Object.keys(objects)) {
          strings.push(`${sNt} ${pNt} ${entityToNTriples(entities[Number(oIdStr)])} .`);
        }
      }
    }
  }

  strings.sort();
  const combined = strings.join("");

  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = (((hash << 5) + hash) ^ combined.charCodeAt(i)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Decode inferred triples from the combined buffer and inject them directly
 * into the N3 Store's index, bypassing DataFactory.quad() and store.addQuad().
 *
 * Returns the number of triples injected.
 */
export function injectInferredFromBuffer(
  store: Store,
  combined: ArrayBuffer,
  inferredGraphIri: string,
): number {
  assertN3Internals(store);

  if (combined.byteLength < 4) return 0;
  const dv = new DataView(combined);
  const strTableLen = dv.getUint32(0, true);
  const tripleStart = 4 + strTableLen;
  if (tripleStart > combined.byteLength || strTableLen < 4) return 0;

  const rawStrings = parseStringTable(combined, 4, strTableLen);

  // Find triple count: scan for magic marker or use remaining bytes
  let tripleCount = 0;
  let foundMagic = false;
  for (let off = tripleStart; off + 8 <= combined.byteLength; off += 4) {
    if (dv.getUint32(off, true) === 0xDEADBEEF) {
      tripleCount = (off - tripleStart) / 12;
      foundMagic = true;
      break;
    }
  }
  if (!foundMagic) {
    tripleCount = Math.floor((combined.byteLength - tripleStart) / 12);
  }
  if (tripleCount === 0) return 0;

  const gId = getOrCreateId(store, inferredGraphIri);

  // Cache: buffer string index → N3 entity ID (keyed by full bufId including type bits)
  const n3IdCache = new Map<number, number>();
  const resolveTermId = (bufId: number): number => {
    let n3Id = n3IdCache.get(bufId);
    if (n3Id === undefined) {
      const type = bufId >>> 30;
      const idx = bufId & 0x3FFFFFFF;
      const entityKey = toN3EntityKey(rawStrings[idx], type);
      n3Id = getOrCreateId(store, entityKey);
      n3IdCache.set(bufId, n3Id);
    }
    return n3Id;
  };

  const tripDv = new DataView(combined, tripleStart, tripleCount! * 12);
  let injected = 0;
  for (let i = 0; i < tripleCount!; i++) {
    const sId = resolveTermId(tripDv.getUint32(i * 12, true));
    const pId = resolveTermId(tripDv.getUint32(i * 12 + 4, true));
    const oId = resolveTermId(tripDv.getUint32(i * 12 + 8, true));
    if (injectQuad(store, sId, pId, oId, gId)) injected++;
  }

  return injected;
}

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MAGIC = 0xDEADBEEF;
const dec = new TextDecoder();

function parseStringTable(buf: ArrayBuffer, start: number, len: number): string[] {
  const strDv = new DataView(buf, start, len);
  const termCount = strDv.getUint32(0, true);
  const headerBytes = 4 + 4 * termCount;
  const strDataLen = len - headerBytes;
  const strBytes = new Uint8Array(buf, start + headerBytes, strDataLen);

  const rawStrings: string[] = new Array(termCount);
  for (let i = 0; i < termCount; i++) {
    const s = strDv.getUint32(4 + 4 * i, true);
    const e = i + 1 < termCount ? strDv.getUint32(4 + 4 * (i + 1), true) : strDataLen;
    rawStrings[i] = dec.decode(strBytes.slice(s, e));
  }
  return rawStrings;
}

function toHex16(high: number, low: number): string {
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}

/**
 * Populate the N3 Store's explanation graph directly from the combined binary
 * buffer (same format produced by buildInferredTripleBuffer with justifications).
 *
 * Clears any existing explanation graph data, then injects justification
 * entries, axiom quoted triples, and justifies mappings — all via direct index
 * manipulation, bypassing Quad allocation and N3's termToId entirely.
 *
 * The inferred triples section is parsed (to resolve mapping indices) but NOT
 * injected into the store — that stays on the existing addQuad path.
 */
export function injectExplanationsFromBuffer(
  store: Store,
  combined: ArrayBuffer,
  explanationGraphIri: string,
): void {
  assertN3Internals(store);

  if (combined.byteLength < 4) return;
  const dv = new DataView(combined);
  const strTableLen = dv.getUint32(0, true);
  const tripleStart = 4 + strTableLen;
  if (tripleStart > combined.byteLength || strTableLen < 4) return;

  const rawStrings = parseStringTable(combined, 4, strTableLen);

  // Find magic marker to locate justification section
  let markerOff = -1;
  for (let off = tripleStart; off + 8 <= combined.byteLength; off += 4) {
    if (dv.getUint32(off, true) === MAGIC) {
      markerOff = off;
      break;
    }
  }
  if (markerOff < 0) return;

  const tripleCount = (markerOff - tripleStart) / 12;

  // Build N3 entity key cache: bufferTermId → N3 numeric ID
  // Lazily populated on first encounter of each string table index.
  const n3IdCache: (number | undefined)[] = new Array(rawStrings.length);

  const resolveTermId = (bufId: number): number => {
    const type = bufId >>> 30;
    const idx = bufId & 0x3FFFFFFF;
    let n3Id = n3IdCache[idx];
    if (n3Id === undefined) {
      const entityKey = toN3EntityKey(rawStrings[idx], type);
      n3Id = getOrCreateId(store, entityKey);
      n3IdCache[idx] = n3Id;
    }
    return n3Id;
  };

  // Clear existing explanation graph
  clearGraph(store, explanationGraphIri);

  const gId = getOrCreateId(store, explanationGraphIri);

  // Pre-register fixed vocabulary
  const rdfTypeId = getOrCreateId(store, RDF_TYPE);
  const kjJustificationId = getOrCreateId(store, KJ_JUSTIFICATION);
  const kjJustifiesId = getOrCreateId(store, KJ_JUSTIFIES);
  const kjAxiomId = getOrCreateId(store, KJ_AXIOM);

  let off = markerOff + 8; // skip magic + tripleCount u32
  if (off + 4 > combined.byteLength) return;

  // Axiom triples — parse s/p/o IDs (don't create Quads, just resolve N3 IDs)
  const axiomCount = dv.getUint32(off, true); off += 4;
  if (off + axiomCount * 12 > combined.byteLength) return;

  const axiomSIds = new Int32Array(axiomCount);
  const axiomPIds = new Int32Array(axiomCount);
  const axiomOIds = new Int32Array(axiomCount);
  for (let i = 0; i < axiomCount; i++) {
    axiomSIds[i] = resolveTermId(dv.getUint32(off, true)); off += 4;
    axiomPIds[i] = resolveTermId(dv.getUint32(off, true)); off += 4;
    axiomOIds[i] = resolveTermId(dv.getUint32(off, true)); off += 4;
  }

  // Justification entries
  if (off + 4 > combined.byteLength) return;
  const justCount = dv.getUint32(off, true); off += 4;

  const justN3Ids = new Array<number>(justCount);
  for (let i = 0; i < justCount; i++) {
    const hashHigh = dv.getUint32(off, true); off += 4;
    const hashLow = dv.getUint32(off, true); off += 4;
    const numAxioms = dv.getUint32(off, true); off += 4;

    const hex = toHex16(hashHigh, hashLow);
    const jId = getOrCreateId(store, `urn:konclude:j#${hex}`);
    justN3Ids[i] = jId;

    // rdf:type kj:Justification
    injectQuad(store, jId, rdfTypeId, kjJustificationId, gId);

    // kj:axiom with quoted axiom triples
    for (let j = 0; j < numAxioms; j++) {
      const axiomIdx = dv.getUint32(off, true); off += 4;
      if (axiomIdx < axiomCount) {
        const quotedId = getOrCreateQuotedTripleId(
          store, axiomSIds[axiomIdx], axiomPIds[axiomIdx], axiomOIds[axiomIdx],
        );
        injectQuad(store, jId, kjAxiomId, quotedId, gId);
      }
    }
  }

  // Mappings: [tripleIdx:u32][justIdx:u32]
  if (off + 4 > combined.byteLength) return;
  const mappingCount = dv.getUint32(off, true); off += 4;

  // Parse inferred triple IDs for mapping resolution
  const inferredN3Ids: { s: number; p: number; o: number }[] = new Array(tripleCount);
  for (let i = 0; i < tripleCount; i++) {
    const base = tripleStart + i * 12;
    inferredN3Ids[i] = {
      s: resolveTermId(dv.getUint32(base, true)),
      p: resolveTermId(dv.getUint32(base + 4, true)),
      o: resolveTermId(dv.getUint32(base + 8, true)),
    };
  }

  for (let i = 0; i < mappingCount; i++) {
    const tripleIdx = dv.getUint32(off, true); off += 4;
    const justIdx = dv.getUint32(off, true); off += 4;
    if (justIdx < justCount && tripleIdx < tripleCount) {
      const inf = inferredN3Ids[tripleIdx];
      const quotedId = getOrCreateQuotedTripleId(store, inf.s, inf.p, inf.o);
      injectQuad(store, justN3Ids[justIdx], kjJustifiesId, quotedId, gId);
    }
  }
}
