import type { Quad, Term } from "@rdfjs/types";

export interface EncodedBuffers {
  tripleBuffer: ArrayBuffer;
  strTableBuffer: ArrayBuffer;
}

const enc = new TextEncoder();

export class InternTable {
  private readonly map = new Map<string, number>();
  private readonly entries: Uint8Array[] = [];

  private intern(key: string, bytes: Uint8Array, type: 0 | 1 | 2): number {
    const cached = this.map.get(key);
    if (cached !== undefined) return cached;
    const idx = this.entries.length;
    this.entries.push(bytes);
    const id = (idx & 0x3fffffff) | (type << 30);
    this.map.set(key, id);
    return id;
  }

  encodeTerm(term: Term): number {
    switch (term.termType) {
      case "NamedNode":
        return this.intern(`n\0${term.value}`, enc.encode(term.value), 0);
      case "BlankNode":
        return this.intern(`b\0${term.value}`, enc.encode(term.value), 1);
      case "Literal": {
        const dt = term.datatype?.value ?? "";
        const lang = term.language ?? "";
        const raw = `${term.value}\0${dt}\0${lang}`;
        return this.intern(`l\0${raw}`, enc.encode(raw), 2);
      }
      default:
        // DefaultGraph, Variable — map to empty named node
        return this.intern("n\0", enc.encode(""), 0);
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
