import type { Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

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
export function decodeBuffers(combined: ArrayBuffer): Quad[] {
  if (combined.byteLength < 4) return [];

  const dv = new DataView(combined);
  const strTableLen = dv.getUint32(0, true);

  const strTableStart = 4;
  const tripleStart = 4 + strTableLen;

  if (strTableLen < 4) return [];

  // Parse string table
  const strDv = new DataView(combined, strTableStart, strTableLen);
  const termCount = strDv.getUint32(0, true);
  const headerBytes = 4 + 4 * termCount;
  const strDataLen = strTableLen - headerBytes;
  const strBytes = new Uint8Array(combined, strTableStart + headerBytes, strDataLen);

  // Decode raw string for each entry (preserves null bytes for literals)
  const rawStrings: string[] = new Array(termCount);
  for (let i = 0; i < termCount; i++) {
    const start = strDv.getUint32(4 + 4 * i, true);
    const end = i + 1 < termCount ? strDv.getUint32(4 + 4 * (i + 1), true) : strDataLen;
    rawStrings[i] = dec.decode(strBytes.slice(start, end));
  }

  // Decode triples
  const tripleBytes = combined.byteLength - tripleStart;
  const tripleCount = Math.floor(tripleBytes / 12); // 3 × u32 per triple
  if (tripleCount === 0) return [];

  const tripDv = new DataView(combined, tripleStart, tripleCount * 12);
  const quads: Quad[] = new Array(tripleCount);

  for (let i = 0; i < tripleCount; i++) {
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
