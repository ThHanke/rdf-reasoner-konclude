import type { Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";
import { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI } from "./types.js";

export interface EncodedBuffers {
  tripleBuffer: ArrayBuffer;
  strTableBuffer: ArrayBuffer;
}

const enc = new TextEncoder();

export class InternTable {
  // Separate maps per term type to avoid key-prefix construction on cache hits.
  private readonly namedNodes = new Map<string, number>();
  private readonly blankNodes = new Map<string, number>();
  private readonly literals = new Map<string, number>();
  private readonly entries: Uint8Array[] = [];

  private addEntry(bytes: Uint8Array, type: 0 | 1 | 2): number {
    const id = (this.entries.length & 0x3fffffff) | (type << 30);
    this.entries.push(bytes);
    return id;
  }

  encodeTerm(term: Term): number {
    switch (term.termType) {
      case "NamedNode": {
        let id = this.namedNodes.get(term.value);
        if (id === undefined) {
          id = this.addEntry(enc.encode(term.value), 0);
          this.namedNodes.set(term.value, id);
        }
        return id;
      }
      case "BlankNode": {
        let id = this.blankNodes.get(term.value);
        if (id === undefined) {
          id = this.addEntry(enc.encode(term.value), 1);
          this.blankNodes.set(term.value, id);
        }
        return id;
      }
      case "Literal": {
        const dt = term.datatype?.value ?? "";
        const lang = term.language ?? "";
        const raw = `${term.value}\0${dt}\0${lang}`;
        let id = this.literals.get(raw);
        if (id === undefined) {
          id = this.addEntry(enc.encode(raw), 2);
          this.literals.set(raw, id);
        }
        return id;
      }
      default: {
        // DefaultGraph, Variable — map to empty named node
        let id = this.namedNodes.get("");
        if (id === undefined) {
          id = this.addEntry(enc.encode(""), 0);
          this.namedNodes.set("", id);
        }
        return id;
      }
    }
  }

  buildStrTableBuffer(): ArrayBuffer {
    const count = this.entries.length;
    const headerBytes = 4 + 4 * count;
    let dataBytes = 0;
    for (const e of this.entries) dataBytes += e.byteLength;

    const buf = new ArrayBuffer(headerBytes + dataBytes);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setUint32(0, count, true);

    let offset = 0;
    let dataPos = headerBytes;
    for (let i = 0; i < count; i++) {
      dv.setUint32(4 + 4 * i, offset, true);
      const entry = this.entries[i];
      u8.set(entry, dataPos);
      offset += entry.byteLength;
      dataPos += entry.byteLength;
    }

    return buf;
  }
}

const dec = new TextDecoder();

// decodeBuffers — reverse of encodeToBuffers for the C++ output path.
//
// Accepts the combined buffer produced by buildInferredTripleBuffer():
//   [strTableLen:u32][strTableBytes…][tripleBytes…]
//
// String table layout: [count:u32][offset0:u32…][UTF-8 data…]
// Triple layout: flat uint32 [s,p,o] tuples; top 2 bits = term type,
//   lower 30 bits = string-table index.
//   0 = NamedNode, 1 = BlankNode, 2 = Literal (value\0datatype\0language)
//
export interface JustificationEntry {
  iri: string;
  axiomIndices: number[];
}

export interface JustificationMapping {
  tripleIdx: number;
  justIdx: number;
}

export interface JustificationData {
  axioms: Quad[];
  entries: JustificationEntry[];
  mappings: JustificationMapping[];
}

export interface DecodeResult {
  quads: Quad[];
  justifications: JustificationData;
}

export function decodeBuffers(combined: ArrayBuffer): Quad[];
export function decodeBuffers(combined: ArrayBuffer, opts: { withJustifications: true }): DecodeResult;
export function decodeBuffers(combined: ArrayBuffer, opts?: { withJustifications?: boolean }): Quad[] | DecodeResult {
  const emptyJust: JustificationData = { axioms: [], entries: [], mappings: [] };
  const wantJust = opts?.withJustifications === true;

  if (combined.byteLength < 4) return wantJust ? { quads: [], justifications: emptyJust } : [];

  const dv = new DataView(combined);
  const strTableLen = dv.getUint32(0, true);
  const tripleStart = 4 + strTableLen;

  if (strTableLen < 4) return wantJust ? { quads: [], justifications: emptyJust } : [];

  const rawStrings = parseStringTable(combined, 4, strTableLen);

  // Without justifications: triple data fills remaining bytes (legacy format).
  // With justifications: [triples][tripleCount:u32][axiomCount:u32][axioms]
  //   [justCount:u32][justEntries...][mappingCount:u32][mappings...]
  let tripleCount: number;
  if (!wantJust) {
    tripleCount = Math.floor((combined.byteLength - tripleStart) / 12);
  } else {
    // Self-referential sentinel: at offset tripleStart + c*12, u32 value === c.
    const maxTriples = Math.floor((combined.byteLength - tripleStart) / 12);
    tripleCount = 0;
    for (let c = maxTriples; c >= 0; c--) {
      const sentinelOff = tripleStart + c * 12;
      if (sentinelOff + 4 <= combined.byteLength && dv.getUint32(sentinelOff, true) === c) {
        tripleCount = c;
        break;
      }
    }
  }

  const quads = decodeTriples(combined, tripleStart, tripleCount, rawStrings);
  if (!wantJust) return quads;

  let off = tripleStart + tripleCount * 12 + 4; // skip past sentinel
  if (off + 4 > combined.byteLength) return { quads, justifications: emptyJust };

  // Axiom triples
  const axiomCount = dv.getUint32(off, true); off += 4;
  const axioms = decodeTriples(combined, off, axiomCount, rawStrings);
  off += axiomCount * 12;

  // Justification entries: [hashHigh:u32][hashLow:u32][numAxioms:u32][axiomIdx:u32...]
  if (off + 4 > combined.byteLength) return { quads, justifications: { axioms, entries: [], mappings: [] } };
  const justCount = dv.getUint32(off, true); off += 4;
  const entries: JustificationEntry[] = new Array(justCount);
  for (let i = 0; i < justCount; i++) {
    const hashHigh = dv.getUint32(off, true); off += 4;
    const hashLow = dv.getUint32(off, true); off += 4;
    const numAxioms = dv.getUint32(off, true); off += 4;
    const axiomIndices: number[] = new Array(numAxioms);
    for (let j = 0; j < numAxioms; j++) {
      axiomIndices[j] = dv.getUint32(off, true); off += 4;
    }
    const hex = toHex16(hashHigh, hashLow);
    entries[i] = { iri: `urn:konclude:j#${hex}`, axiomIndices };
  }

  // Mappings: [tripleIdx:u32][justIdx:u32]
  if (off + 4 > combined.byteLength) return { quads, justifications: { axioms, entries, mappings: [] } };
  const mappingCount = dv.getUint32(off, true); off += 4;
  const mappings: JustificationMapping[] = new Array(mappingCount);
  for (let i = 0; i < mappingCount; i++) {
    mappings[i] = { tripleIdx: dv.getUint32(off, true), justIdx: dv.getUint32(off + 4, true) };
    off += 8;
  }

  return { quads, justifications: { axioms, entries, mappings } };
}

function toHex16(high: number, low: number): string {
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}

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

function decodeTriples(buf: ArrayBuffer, start: number, count: number, rawStrings: string[]): Quad[] {
  if (count === 0) return [];
  const tripDv = new DataView(buf, start, count * 12);
  const quads: Quad[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const sId = tripDv.getUint32(i * 12, true);
    const pId = tripDv.getUint32(i * 12 + 4, true);
    const oId = tripDv.getUint32(i * 12 + 8, true);
    quads[i] = DataFactory.quad(
      decodeTerm(sId, rawStrings) as ReturnType<typeof DataFactory.namedNode>,
      decodeTerm(pId, rawStrings) as ReturnType<typeof DataFactory.namedNode>,
      decodeTerm(oId, rawStrings),
      DataFactory.defaultGraph(),
    );
  }
  return quads;
}

function decodeTerm(
  id: number,
  rawStrings: string[],
): ReturnType<typeof DataFactory.namedNode> | ReturnType<typeof DataFactory.blankNode> | ReturnType<typeof DataFactory.literal> {
  const type = id >>> 30;
  const idx = id & 0x3fffffff;
  const raw = rawStrings[idx] ?? "";

  switch (type) {
    case 1:
      return DataFactory.blankNode(raw);
    case 2: {
      const nul1 = raw.indexOf("\0");
      const value = nul1 >= 0 ? raw.slice(0, nul1) : raw;
      const rest = nul1 >= 0 ? raw.slice(nul1 + 1) : "";
      const nul2 = rest.indexOf("\0");
      const datatype = nul2 >= 0 ? rest.slice(0, nul2) : rest;
      const language = nul2 >= 0 ? rest.slice(nul2 + 1) : "";
      if (language) return DataFactory.literal(value, language);
      if (datatype) return DataFactory.literal(value, DataFactory.namedNode(datatype));
      return DataFactory.literal(value);
    }
    default: // 0 = NamedNode
      return DataFactory.namedNode(raw);
  }
}

export function encodeToBuffers(quads: Iterable<Quad>): EncodedBuffers {
  const table = new InternTable();
  const ids: number[] = [];

  for (const quad of quads) {
    ids.push(
      table.encodeTerm(quad.subject),
      table.encodeTerm(quad.predicate),
      table.encodeTerm(quad.object),
    );
  }

  const tripleBuffer = new Uint32Array(ids).buffer;
  const strTableBuffer = table.buildStrTableBuffer();

  return { tripleBuffer, strTableBuffer };
}

/**
 * Compute a stable content hash (djb2, hex) for a collection of quads,
 * ignoring quads in the INFERRED_GRAPH_IRI and HYPOTHETICAL_IRI graphs.
 *
 * The fingerprint is order-independent: quads are serialized to N-Triples
 * canonical strings, sorted, concatenated, then hashed with djb2.
 */
export function computeStoreFingerprint(quads: Quad[]): string {
  const strings: string[] = [];
  for (const q of quads) {
    const g = q.graph.value;
    if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI || g === EXPLANATION_GRAPH_IRI) continue;
    strings.push(quadToNTriples(q));
  }
  strings.sort();
  const combined = strings.join("");

  // djb2 over the combined string, unsigned 32-bit arithmetic
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = (((hash << 5) + hash) ^ combined.charCodeAt(i)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function termToNTriples(term: Quad["subject"] | Quad["predicate"] | Quad["object"]): string {
  switch (term.termType) {
    case "NamedNode":
      return `<${term.value}>`;
    case "BlankNode":
      return `_:${term.value}`;
    case "Literal": {
      const escaped = term.value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
      if (term.language) return `"${escaped}"@${term.language}`;
      if (term.datatype?.value) return `"${escaped}"^^<${term.datatype.value}>`;
      return `"${escaped}"`;
    }
    default:
      return `<>`;
  }
}

function quadToNTriples(q: Quad): string {
  return `${termToNTriples(q.subject)} ${termToNTriples(q.predicate)} ${termToNTriples(q.object)} .`;
}
