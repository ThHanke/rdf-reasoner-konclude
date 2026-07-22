/**
 * Tests for injectExplanationsFromBuffer — populates N3 Store explanation graph
 * directly from the combined binary buffer, bypassing Quad allocation.
 */

import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import {
  injectExplanationsFromBuffer,
  getOrCreateId,
  injectQuad,
} from "../../ts/n3Inject.js";
import { decodeBuffers } from "../../ts/intern.js";
import { serializeExplanations } from "../../ts/explanationSerializer.js";
import {
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "../../ts/types.js";

const { namedNode, quad } = DataFactory;
const EXPL_GRAPH = "urn:konclude:explanations";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ---------------------------------------------------------------------------
// Buffer construction helpers — mimic C++ buildInferredTripleBuffer output
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

interface TermEntry {
  raw: string;
  type: 0 | 1 | 2;
}

function buildCombinedBuffer(opts: {
  terms: TermEntry[];
  triples: [number, number, number][]; // indices with type tags baked in
  axioms?: [number, number, number][];
  justifications?: { hashHigh: number; hashLow: number; axiomIndices: number[] }[];
  mappings?: { tripleIdx: number; justIdx: number }[];
}): ArrayBuffer {
  const { terms, triples, axioms = [], justifications = [], mappings = [] } = opts;

  // Build string table
  const encoded = terms.map(t => enc.encode(t.raw));
  const headerBytes = 4 + 4 * terms.length;
  let dataBytes = 0;
  for (const e of encoded) dataBytes += e.byteLength;
  const strTableLen = headerBytes + dataBytes;

  // Calculate total buffer size
  const tripleBytes = triples.length * 12;
  const hasJust = axioms.length > 0 || justifications.length > 0 || mappings.length > 0;
  let justBytes = 0;
  if (hasJust) {
    justBytes += 8; // magic + tripleCount
    justBytes += 4 + axioms.length * 12; // axiomCount + axiom triples
    justBytes += 4; // justCount
    for (const j of justifications) justBytes += 12 + j.axiomIndices.length * 4;
    justBytes += 4 + mappings.length * 8; // mappingCount + mappings
  }

  const totalLen = 4 + strTableLen + tripleBytes + justBytes;
  const buf = new ArrayBuffer(totalLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // [strTableLen:u32]
  dv.setUint32(0, strTableLen, true);

  // String table: [count:u32][offsets...][data...]
  let pos = 4;
  dv.setUint32(pos, terms.length, true); pos += 4;
  let dataOffset = 0;
  for (let i = 0; i < terms.length; i++) {
    dv.setUint32(pos, dataOffset, true); pos += 4;
    dataOffset += encoded[i].byteLength;
  }
  for (const e of encoded) {
    u8.set(e, pos);
    pos += e.byteLength;
  }

  // Inferred triples: [s:u32, p:u32, o:u32]...
  for (const [s, p, o] of triples) {
    dv.setUint32(pos, s, true); pos += 4;
    dv.setUint32(pos, p, true); pos += 4;
    dv.setUint32(pos, o, true); pos += 4;
  }

  if (!hasJust) return buf;

  // Magic marker + tripleCount
  dv.setUint32(pos, 0xDEADBEEF, true); pos += 4;
  dv.setUint32(pos, triples.length, true); pos += 4;

  // Axiom triples
  dv.setUint32(pos, axioms.length, true); pos += 4;
  for (const [s, p, o] of axioms) {
    dv.setUint32(pos, s, true); pos += 4;
    dv.setUint32(pos, p, true); pos += 4;
    dv.setUint32(pos, o, true); pos += 4;
  }

  // Justification entries
  dv.setUint32(pos, justifications.length, true); pos += 4;
  for (const j of justifications) {
    dv.setUint32(pos, j.hashHigh, true); pos += 4;
    dv.setUint32(pos, j.hashLow, true); pos += 4;
    dv.setUint32(pos, j.axiomIndices.length, true); pos += 4;
    for (const idx of j.axiomIndices) {
      dv.setUint32(pos, idx, true); pos += 4;
    }
  }

  // Mappings
  dv.setUint32(pos, mappings.length, true); pos += 4;
  for (const m of mappings) {
    dv.setUint32(pos, m.tripleIdx, true); pos += 4;
    dv.setUint32(pos, m.justIdx, true); pos += 4;
  }

  return buf;
}

function makeTermId(index: number, type: 0 | 1 | 2): number {
  return (index & 0x3FFFFFFF) | (type << 30);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("injectExplanationsFromBuffer", () => {
  it("1 justification, 2 axioms, 1 mapping → correct explanation graph", () => {
    // Terms: 0=ex:Alice(NN), 1=rdf:type(NN), 2=ex:Person(NN), 3=ex:Human(NN), 4=rdfs:subClassOf(NN)
    const terms: TermEntry[] = [
      { raw: "ex:Alice", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:Person", type: 0 },
      { raw: "ex:Human", type: 0 },
      { raw: "http://www.w3.org/2000/01/rdf-schema#subClassOf", type: 0 },
    ];

    // Inferred: ex:Alice rdf:type ex:Person
    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
    ];

    // Axioms: (0) ex:Alice rdf:type ex:Human, (1) ex:Human rdfs:subClassOf ex:Person
    const axioms: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(3, 0)],
      [makeTermId(3, 0), makeTermId(4, 0), makeTermId(2, 0)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms,
      justifications: [{ hashHigh: 0x00000001, hashLow: 0x00000002, axiomIndices: [0, 1] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    const explGraph = namedNode(EXPL_GRAPH);

    // rdf:type Justification
    const typeQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(typeQuads.length).toBe(1);
    expect(typeQuads[0].subject.value).toBe("urn:konclude:j#0000000100000002");

    // kj:axiom — 2 axiom quoted triples
    const axiomQuads = store.getQuads(null, namedNode(KJ_AXIOM), null, explGraph);
    expect(axiomQuads.length).toBe(2);
    for (const aq of axiomQuads) {
      expect((aq.object as any).termType).toBe("Quad");
    }

    // kj:justifies — quoted inferred triple
    const justifiesQuads = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifiesQuads.length).toBe(1);
    const qt = justifiesQuads[0].object as any;
    expect(qt.termType).toBe("Quad");
    expect(qt.subject.value).toBe("ex:Alice");
    expect(qt.predicate.value).toBe(RDF_TYPE);
    expect(qt.object.value).toBe("ex:Person");
  });

  it("multiple justifications sharing axioms → axiom entity keys deduplicated", () => {
    const terms: TermEntry[] = [
      { raw: "ex:A", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:X", type: 0 },
      { raw: "ex:Y", type: 0 },
      { raw: "ex:B", type: 0 },
    ];

    // Inferred: ex:A rdf:type ex:X, ex:A rdf:type ex:Y
    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(3, 0)],
    ];

    // Shared axiom: ex:A rdf:type ex:B
    const axioms: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(4, 0)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms,
      justifications: [
        { hashHigh: 0xAA, hashLow: 0xBB, axiomIndices: [0] },
        { hashHigh: 0xCC, hashLow: 0xDD, axiomIndices: [0] },
      ],
      mappings: [
        { tripleIdx: 0, justIdx: 0 },
        { tripleIdx: 1, justIdx: 1 },
      ],
    });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    const explGraph = namedNode(EXPL_GRAPH);

    // 2 justification nodes
    const typeQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(typeQuads.length).toBe(2);

    // Both share same axiom quoted triple → same N3 entity ID
    const axiomQuads = store.getQuads(null, namedNode(KJ_AXIOM), null, explGraph);
    expect(axiomQuads.length).toBe(2);
    expect((axiomQuads[0].object as any).subject.value).toBe("ex:A");
    expect((axiomQuads[1].object as any).subject.value).toBe("ex:A");

    // 2 justifies mappings
    const justifiesQuads = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifiesQuads.length).toBe(2);
  });

  it("_lookupJustificationFromStore pattern works with injected data", () => {
    const terms: TermEntry[] = [
      { raw: "ex:Alice", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:Person", type: 0 },
      { raw: "ex:Human", type: 0 },
    ];

    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
    ];

    const axioms: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(3, 0)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms,
      justifications: [{ hashHigh: 0x11, hashLow: 0x22, axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    // Replicate _lookupJustificationFromStore logic
    const explGraphNode = namedNode(EXPL_GRAPH);
    const quotedTriple = quad(
      namedNode("ex:Alice"),
      namedNode(RDF_TYPE),
      namedNode("ex:Person"),
    );
    const justifiesMatches = store.getQuads(null, namedNode(KJ_JUSTIFIES), quotedTriple as any, explGraphNode);
    expect(justifiesMatches.length).toBe(1);

    const jNode = justifiesMatches[0].subject;
    const axiomResults = store.getQuads(jNode, namedNode(KJ_AXIOM), null, explGraphNode);
    expect(axiomResults.length).toBe(1);
    const aq = axiomResults[0].object as any;
    expect(aq.termType).toBe("Quad");
    expect(aq.subject.value).toBe("ex:Alice");
    expect(aq.predicate.value).toBe(RDF_TYPE);
    expect(aq.object.value).toBe("ex:Human");
  });

  it("zero justifications (no magic marker) → no explanation graph entries", () => {
    const terms: TermEntry[] = [
      { raw: "ex:A", type: 0 },
      { raw: "ex:B", type: 0 },
      { raw: "ex:C", type: 0 },
    ];
    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
    ];

    // No axioms/justifications/mappings → no magic marker written
    const buf = buildCombinedBuffer({ terms, triples });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    expect(store.getQuads(null, null, null, namedNode(EXPL_GRAPH)).length).toBe(0);
  });

  it("justification with zero axioms → rdf:type present, no kj:axiom quads", () => {
    const terms: TermEntry[] = [
      { raw: "ex:A", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:B", type: 0 },
    ];

    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms: [],
      justifications: [{ hashHigh: 0xFF, hashLow: 0xEE, axiomIndices: [] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    const explGraph = namedNode(EXPL_GRAPH);
    const typeQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(typeQuads.length).toBe(1);

    const axiomQuads = store.getQuads(null, namedNode(KJ_AXIOM), null, explGraph);
    expect(axiomQuads.length).toBe(0);

    const justifiesQuads = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifiesQuads.length).toBe(1);
  });

  it("comparison: identical results to decodeBuffers + serializeExplanations", () => {
    const terms: TermEntry[] = [
      { raw: "ex:S1", type: 0 },
      { raw: "ex:p", type: 0 },
      { raw: "ex:O1", type: 0 },
      { raw: "ex:S2", type: 0 },
      { raw: "ex:O2", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:Class1", type: 0 },
    ];

    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
      [makeTermId(3, 0), makeTermId(1, 0), makeTermId(4, 0)],
    ];

    const axioms: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(5, 0), makeTermId(6, 0)],
      [makeTermId(3, 0), makeTermId(5, 0), makeTermId(6, 0)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms,
      justifications: [
        { hashHigh: 0x10, hashLow: 0x20, axiomIndices: [0] },
        { hashHigh: 0x30, hashLow: 0x40, axiomIndices: [1] },
      ],
      mappings: [
        { tripleIdx: 0, justIdx: 0 },
        { tripleIdx: 1, justIdx: 1 },
      ],
    });

    // Reference path: decodeBuffers + serializeExplanations
    const refStore = new Store();
    const decoded = decodeBuffers(buf, { withJustifications: true });
    serializeExplanations(refStore, decoded.justifications, decoded.quads, EXPL_GRAPH);

    // Test path: injectExplanationsFromBuffer
    const testStore = new Store();
    injectExplanationsFromBuffer(testStore, buf, EXPL_GRAPH);

    const explGraph = namedNode(EXPL_GRAPH);
    const refQuads = refStore.getQuads(null, null, null, explGraph);
    const testQuads = testStore.getQuads(null, null, null, explGraph);

    expect(testQuads.length).toBe(refQuads.length);

    for (const rq of refQuads) {
      const sVal = rq.subject.value;
      const pVal = rq.predicate.value;
      const oType = (rq.object as any).termType;

      let found: boolean;
      if (oType === "Quad") {
        const ro = rq.object as any;
        found = testQuads.some(tq => {
          const to = tq.object as any;
          return tq.subject.value === sVal &&
            tq.predicate.value === pVal &&
            to.termType === "Quad" &&
            to.subject.value === ro.subject.value &&
            to.predicate.value === ro.predicate.value &&
            to.object.value === ro.object.value;
        });
      } else {
        found = testQuads.some(tq =>
          tq.subject.value === sVal &&
          tq.predicate.value === pVal &&
          tq.object.value === rq.object.value,
        );
      }
      expect(found, `Missing in test store: ${sVal} ${pVal} ${rq.object.value}`).toBe(true);
    }
  });

  it("handles blank node and literal terms in axioms", () => {
    const terms: TermEntry[] = [
      { raw: "b0", type: 1 },           // blank node
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:Class", type: 0 },
      { raw: "hello\0\0en", type: 2 },   // literal with language
      { raw: "ex:label", type: 0 },
    ];

    // Inferred: _:b0 rdf:type ex:Class
    const triples: [number, number, number][] = [
      [makeTermId(0, 1), makeTermId(1, 0), makeTermId(2, 0)],
    ];

    // Axiom: _:b0 ex:label "hello"@en
    const axioms: [number, number, number][] = [
      [makeTermId(0, 1), makeTermId(4, 0), makeTermId(3, 2)],
    ];

    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms,
      justifications: [{ hashHigh: 0xAB, hashLow: 0xCD, axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    });

    const store = new Store();
    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    const explGraph = namedNode(EXPL_GRAPH);

    // Verify axiom quoted triple has blank node subject and literal object
    const axiomQuads = store.getQuads(null, namedNode(KJ_AXIOM), null, explGraph);
    expect(axiomQuads.length).toBe(1);
    const aq = axiomQuads[0].object as any;
    expect(aq.termType).toBe("Quad");
    expect(aq.subject.value).toBe("b0");
    expect(aq.subject.termType).toBe("BlankNode");
    expect(aq.object.value).toBe("hello");
    expect(aq.object.language).toBe("en");

    // Verify justifies has blank node subject in quoted triple
    const justifiesQuads = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifiesQuads.length).toBe(1);
    const jqt = justifiesQuads[0].object as any;
    expect(jqt.subject.termType).toBe("BlankNode");
    expect(jqt.subject.value).toBe("b0");
  });

  it("clears existing explanation graph before injection", () => {
    const store = new Store();
    const explGraph = namedNode(EXPL_GRAPH);
    // Pre-populate with stale data
    store.addQuad(quad(namedNode("ex:old"), namedNode("ex:stale"), namedNode("ex:data"), explGraph));
    expect(store.getQuads(null, null, null, explGraph).length).toBe(1);

    const terms: TermEntry[] = [
      { raw: "ex:A", type: 0 },
      { raw: RDF_TYPE, type: 0 },
      { raw: "ex:B", type: 0 },
    ];
    const triples: [number, number, number][] = [
      [makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)],
    ];
    const buf = buildCombinedBuffer({
      terms,
      triples,
      axioms: [[makeTermId(0, 0), makeTermId(1, 0), makeTermId(2, 0)]],
      justifications: [{ hashHigh: 1, hashLow: 2, axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    });

    injectExplanationsFromBuffer(store, buf, EXPL_GRAPH);

    // Old data gone, new data present
    const quads = store.getQuads(null, null, null, explGraph);
    expect(quads.some(q => q.subject.value === "ex:old")).toBe(false);
    expect(quads.length).toBeGreaterThan(0);
  });
});
