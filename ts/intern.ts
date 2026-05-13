import type { Quad, Term } from "@rdfjs/types";

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
