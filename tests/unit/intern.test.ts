import { describe, expect, it } from "vitest";
import { DataFactory } from "n3";
import { InternTable, encodeToBuffers } from "../../ts/intern.js";

const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

// ─── helpers ────────────────────────────────────────────────────────────────

function typeOf(id: number): number {
  return id >>> 30;
}
function indexOf(id: number): number {
  return id & 0x3fffffff;
}

function readStrTable(buf: ArrayBuffer): { count: number; entries: string[] } {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const headerBytes = 4 + 4 * count;
  const strDataLen = buf.byteLength - headerBytes;
  const strBytes = new Uint8Array(buf, headerBytes);
  const dec = new TextDecoder();

  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = dv.getUint32(4 + 4 * i, true);
    const end = i + 1 < count ? dv.getUint32(4 + 4 * (i + 1), true) : strDataLen;
    entries.push(dec.decode(strBytes.slice(start, end)));
  }
  return { count, entries };
}

// ─── InternTable ────────────────────────────────────────────────────────────

describe("InternTable", () => {
  it("NamedNode gets type bit 0", () => {
    const t = new InternTable();
    const id = t.encodeTerm(namedNode("http://example.org/A"));
    expect(typeOf(id)).toBe(0);
  });

  it("BlankNode gets type bit 1", () => {
    const t = new InternTable();
    const id = t.encodeTerm(blankNode("b1"));
    expect(typeOf(id)).toBe(1);
  });

  it("Literal gets type bit 2", () => {
    const t = new InternTable();
    const id = t.encodeTerm(literal("hello"));
    expect(typeOf(id)).toBe(2);
  });

  it("same term returns same id", () => {
    const t = new InternTable();
    const a = t.encodeTerm(namedNode("http://example.org/A"));
    const b = t.encodeTerm(namedNode("http://example.org/A"));
    expect(a).toBe(b);
  });

  it("different terms get distinct indices", () => {
    const t = new InternTable();
    const a = t.encodeTerm(namedNode("http://example.org/A"));
    const b = t.encodeTerm(namedNode("http://example.org/B"));
    expect(indexOf(a)).not.toBe(indexOf(b));
  });

  it("NamedNode and BlankNode with same value are distinct entries", () => {
    const t = new InternTable();
    const n = t.encodeTerm(namedNode("x"));
    const b = t.encodeTerm(blankNode("x"));
    // different type bits, but also different indices (separate entries)
    expect(n).not.toBe(b);
    expect(typeOf(n)).toBe(0);
    expect(typeOf(b)).toBe(1);
  });
});

// ─── buildStrTableBuffer ─────────────────────────────────────────────────────

describe("InternTable.buildStrTableBuffer", () => {
  it("count field is correct", () => {
    const t = new InternTable();
    t.encodeTerm(namedNode("http://a"));
    t.encodeTerm(namedNode("http://b"));
    const { count } = readStrTable(t.buildStrTableBuffer());
    expect(count).toBe(2);
  });

  it("NamedNode entry is the raw IRI", () => {
    const t = new InternTable();
    const id = t.encodeTerm(namedNode("http://example.org/"));
    const { entries } = readStrTable(t.buildStrTableBuffer());
    expect(entries[indexOf(id)]).toBe("http://example.org/");
  });

  it("BlankNode entry is the blank id", () => {
    const t = new InternTable();
    const id = t.encodeTerm(blankNode("node42"));
    const { entries } = readStrTable(t.buildStrTableBuffer());
    expect(entries[indexOf(id)]).toBe("node42");
  });

  it("Literal entry encodes value\\0datatype\\0language", () => {
    const t = new InternTable();
    const id = t.encodeTerm(literal("hello", "en"));
    const { entries } = readStrTable(t.buildStrTableBuffer());
    // language tag literal: datatype is rdf:langString
    const raw = entries[indexOf(id)];
    const parts = raw.split("\0");
    expect(parts[0]).toBe("hello");
    expect(parts[2]).toBe("en");
  });

  it("plain Literal has empty language", () => {
    const t = new InternTable();
    const id = t.encodeTerm(literal("42", namedNode("http://www.w3.org/2001/XMLSchema#integer")));
    const { entries } = readStrTable(t.buildStrTableBuffer());
    const parts = entries[indexOf(id)].split("\0");
    expect(parts[0]).toBe("42");
    expect(parts[1]).toBe("http://www.w3.org/2001/XMLSchema#integer");
    expect(parts[2]).toBe("");
  });

  it("offsets are valid byte positions within string-data section", () => {
    const t = new InternTable();
    t.encodeTerm(namedNode("http://a.example/"));
    t.encodeTerm(blankNode("b1"));
    const buf = t.buildStrTableBuffer();
    const dv = new DataView(buf);
    const count = dv.getUint32(0, true);
    const headerBytes = 4 + 4 * count;
    const strDataLen = buf.byteLength - headerBytes;
    for (let i = 0; i < count; i++) {
      expect(dv.getUint32(4 + 4 * i, true)).toBeLessThanOrEqual(strDataLen);
    }
  });
});

// ─── encodeToBuffers ─────────────────────────────────────────────────────────

describe("encodeToBuffers", () => {
  it("empty input yields zero-length triple buffer and count=0 str table", () => {
    const { tripleBuffer, strTableBuffer } = encodeToBuffers([]);
    expect(tripleBuffer.byteLength).toBe(0);
    const { count } = readStrTable(strTableBuffer);
    expect(count).toBe(0);
  });

  it("triple buffer has 3 uint32s per quad", () => {
    const q = quad(
      namedNode("http://s"),
      namedNode("http://p"),
      namedNode("http://o"),
      defaultGraph(),
    );
    const { tripleBuffer } = encodeToBuffers([q]);
    expect(tripleBuffer.byteLength).toBe(12);
  });

  it("subject/predicate/object ids are in correct positions", () => {
    const q = quad(
      namedNode("http://s"),
      namedNode("http://p"),
      blankNode("o"),
      defaultGraph(),
    );
    const { tripleBuffer } = encodeToBuffers([q]);
    const u32 = new Uint32Array(tripleBuffer);
    // subject and predicate are NamedNodes (type 0), object is BlankNode (type 1)
    expect(typeOf(u32[0])).toBe(0);
    expect(typeOf(u32[1])).toBe(0);
    expect(typeOf(u32[2])).toBe(1);
  });

  it("shared terms reuse the same id across quads", () => {
    const s = namedNode("http://s");
    const p = namedNode("http://p");
    const q1 = quad(s, p, namedNode("http://o1"), defaultGraph());
    const q2 = quad(s, p, namedNode("http://o2"), defaultGraph());
    const { tripleBuffer, strTableBuffer } = encodeToBuffers([q1, q2]);
    const u32 = new Uint32Array(tripleBuffer);
    // s is at position 0 and 3; p is at position 1 and 4 — same id
    expect(u32[0]).toBe(u32[3]);
    expect(u32[1]).toBe(u32[4]);
    // o1 and o2 are different
    expect(u32[2]).not.toBe(u32[5]);
    // Only 4 distinct terms interned
    const { count } = readStrTable(strTableBuffer);
    expect(count).toBe(4);
  });

  it("multiple quads produce correctly sized triple buffer", () => {
    const quads = [
      quad(namedNode("http://a"), namedNode("http://b"), namedNode("http://c"), defaultGraph()),
      quad(namedNode("http://d"), namedNode("http://e"), namedNode("http://f"), defaultGraph()),
      quad(namedNode("http://g"), namedNode("http://h"), namedNode("http://i"), defaultGraph()),
    ];
    const { tripleBuffer } = encodeToBuffers(quads);
    expect(tripleBuffer.byteLength).toBe(3 * 3 * 4); // 3 quads × 3 terms × 4 bytes
  });
});
