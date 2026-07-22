import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import { serializeExplanations } from "../../ts/explanationSerializer.js";
import type { JustificationData } from "../../ts/intern.js";
import {
  EXPLANATION_GRAPH_IRI,
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "../../ts/types.js";

const { namedNode, quad } = DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EX = "http://example.org/";
const explGraph = namedNode(EXPLANATION_GRAPH_IRI);

function makeQuad(s: string, p: string, o: string) {
  return quad(namedNode(s), namedNode(p), namedNode(o));
}

describe("serializeExplanations", () => {
  it("single justification with 2 axioms", () => {
    const store = new Store();
    const inferredQuads = [makeQuad(`${EX}Dog`, RDFS_SUB_CLASS_OF, `${EX}Animal`)];
    const justData: JustificationData = {
      axioms: [
        makeQuad(`${EX}Dog`, RDFS_SUB_CLASS_OF, `${EX}Pet`),
        makeQuad(`${EX}Pet`, RDFS_SUB_CLASS_OF, `${EX}Animal`),
      ],
      entries: [{ iri: "urn:konclude:j#abc123", axiomIndices: [0, 1] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    };

    serializeExplanations(store, justData, inferredQuads, EXPLANATION_GRAPH_IRI);

    const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(types).toHaveLength(1);
    expect(types[0].subject.value).toBe("urn:konclude:j#abc123");

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);
    expect(justifies[0].object.termType).toBe("Quad");

    const axioms = store.getQuads(types[0].subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(2);
    for (const ax of axioms) {
      expect(ax.object.termType).toBe("Quad");
    }
  });

  it("multiple justifications get unique named nodes", () => {
    const store = new Store();
    const inferredQuads = [
      makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`),
      makeQuad(`${EX}C`, RDFS_SUB_CLASS_OF, `${EX}D`),
    ];
    const justData: JustificationData = {
      axioms: [
        makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`),
        makeQuad(`${EX}C`, RDFS_SUB_CLASS_OF, `${EX}D`),
      ],
      entries: [
        { iri: "urn:konclude:j#aaa", axiomIndices: [0] },
        { iri: "urn:konclude:j#bbb", axiomIndices: [1] },
      ],
      mappings: [
        { tripleIdx: 0, justIdx: 0 },
        { tripleIdx: 1, justIdx: 1 },
      ],
    };

    serializeExplanations(store, justData, inferredQuads, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(2);
    expect(justifies[0].subject.value).not.toBe(justifies[1].subject.value);
  });

  it("justification with zero axioms", () => {
    const store = new Store();
    const inferredQuads = [makeQuad(`${EX}Dog`, RDFS_SUB_CLASS_OF, `${EX}Animal`)];
    const justData: JustificationData = {
      axioms: [],
      entries: [{ iri: "urn:konclude:j#empty", axiomIndices: [] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    };

    serializeExplanations(store, justData, inferredQuads, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);

    const axioms = store.getQuads(justifies[0].subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(0);
  });

  it("empty justification data clears graph", () => {
    const store = new Store();
    store.addQuad(quad(namedNode(`${EX}old`), namedNode(KJ_JUSTIFIES), namedNode(`${EX}stale`), explGraph));

    const justData: JustificationData = { axioms: [], entries: [], mappings: [] };
    serializeExplanations(store, justData, [], EXPLANATION_GRAPH_IRI);

    const all = store.getQuads(null, null, null, explGraph);
    expect(all).toHaveLength(0);
  });

  it("second call clears previous explanation quads", () => {
    const store = new Store();
    const justData1: JustificationData = {
      axioms: [makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`)],
      entries: [{ iri: "urn:konclude:j#first", axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    };
    serializeExplanations(store, justData1, [makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`)], EXPLANATION_GRAPH_IRI);

    const justData2: JustificationData = {
      axioms: [makeQuad(`${EX}C`, RDFS_SUB_CLASS_OF, `${EX}D`)],
      entries: [{ iri: "urn:konclude:j#second", axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    };
    serializeExplanations(store, justData2, [makeQuad(`${EX}C`, RDFS_SUB_CLASS_OF, `${EX}D`)], EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);
    const quotedTriple = justifies[0].object as unknown as ReturnType<typeof quad>;
    expect(quotedTriple.subject.value).toBe(`${EX}C`);
  });

  it("two inferred triples sharing same justification", () => {
    const store = new Store();
    const inferredQuads = [
      makeQuad(`${EX}X`, RDF_TYPE, `${EX}A`),
      makeQuad(`${EX}X`, RDF_TYPE, `${EX}B`),
    ];
    const justData: JustificationData = {
      axioms: [makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`)],
      entries: [{ iri: "urn:konclude:j#shared", axiomIndices: [0] }],
      mappings: [
        { tripleIdx: 0, justIdx: 0 },
        { tripleIdx: 1, justIdx: 0 },
      ],
    };

    serializeExplanations(store, justData, inferredQuads, EXPLANATION_GRAPH_IRI);

    const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(types).toHaveLength(1);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(2);
    expect(justifies[0].subject.value).toBe(justifies[1].subject.value);
  });

  it("named node IRI matches urn:konclude:j# pattern", () => {
    const store = new Store();
    const justData: JustificationData = {
      axioms: [makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`)],
      entries: [{ iri: "urn:konclude:j#deadbeef01234567", axiomIndices: [0] }],
      mappings: [{ tripleIdx: 0, justIdx: 0 }],
    };

    serializeExplanations(store, justData, [makeQuad(`${EX}A`, RDFS_SUB_CLASS_OF, `${EX}B`)], EXPLANATION_GRAPH_IRI);

    const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(types[0].subject.value).toMatch(/^urn:konclude:j#[0-9a-f]+$/);
    expect(types[0].subject.termType).toBe("NamedNode");
  });
});
