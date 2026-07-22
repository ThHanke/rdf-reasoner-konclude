import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import { serializeExplanations } from "../../ts/explanationSerializer.js";
import {
  EXPLANATION_GRAPH_IRI,
  INFERRED_GRAPH_IRI,
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "../../ts/types.js";

const { namedNode, quad } = DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EX = "http://example.org/";
const explGraph = namedNode(EXPLANATION_GRAPH_IRI);

function makeBulkExport(entries: Array<{ sub: string; pred: string; obj: string; axioms: string }>): string {
  return entries
    .map(e => `${e.sub}\t${e.pred}\t${e.obj}\n${e.axioms}`)
    .join("\0");
}

describe("serializeExplanations", () => {
  it("single justification with 2 axioms", () => {
    const store = new Store();
    const bulk = makeBulkExport([{
      sub: `${EX}Dog`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}Animal`,
      axioms: `<${EX}Dog> <${RDFS_SUB_CLASS_OF}> <${EX}Pet> .\n<${EX}Pet> <${RDFS_SUB_CLASS_OF}> <${EX}Animal> .`,
    }]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(types).toHaveLength(1);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);
    expect(justifies[0].object.termType).toBe("Quad");

    const axioms = store.getQuads(types[0].subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(2);
    for (const ax of axioms) {
      expect(ax.object.termType).toBe("Quad");
    }
  });

  it("multiple justifications get unique blank nodes", () => {
    const store = new Store();
    const bulk = makeBulkExport([
      {
        sub: `${EX}A`,
        pred: RDFS_SUB_CLASS_OF,
        obj: `${EX}B`,
        axioms: `<${EX}A> <${RDFS_SUB_CLASS_OF}> <${EX}B> .`,
      },
      {
        sub: `${EX}C`,
        pred: RDFS_SUB_CLASS_OF,
        obj: `${EX}D`,
        axioms: `<${EX}C> <${RDFS_SUB_CLASS_OF}> <${EX}D> .`,
      },
    ]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(2);
    expect(justifies[0].subject.value).not.toBe(justifies[1].subject.value);
  });

  it("nil-path: no axioms in entry", () => {
    const store = new Store();
    const bulk = makeBulkExport([{
      sub: `${EX}Dog`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}Animal`,
      axioms: "",
    }]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);

    const axioms = store.getQuads(justifies[0].subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(0);
  });

  it("empty bulk export clears graph", () => {
    const store = new Store();
    // Pre-populate with stale data
    store.addQuad(quad(
      namedNode(`${EX}old`),
      namedNode(KJ_JUSTIFIES),
      namedNode(`${EX}stale`),
      explGraph,
    ));

    serializeExplanations(store, "", EXPLANATION_GRAPH_IRI);

    const all = store.getQuads(null, null, null, explGraph);
    expect(all).toHaveLength(0);
  });

  it("second call clears previous explanation quads", () => {
    const store = new Store();
    const bulk1 = makeBulkExport([{
      sub: `${EX}A`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}B`,
      axioms: `<${EX}A> <${RDFS_SUB_CLASS_OF}> <${EX}B> .`,
    }]);
    serializeExplanations(store, bulk1, EXPLANATION_GRAPH_IRI);

    const bulk2 = makeBulkExport([{
      sub: `${EX}C`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}D`,
      axioms: `<${EX}C> <${RDFS_SUB_CLASS_OF}> <${EX}D> .`,
    }]);
    serializeExplanations(store, bulk2, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);
    const quotedTriple = justifies[0].object as unknown as ReturnType<typeof quad>;
    expect(quotedTriple.subject.value).toBe(`${EX}C`);
  });

  it("malformed NTriples emits nil-path, continues with rest", () => {
    const store = new Store();
    const bulk = makeBulkExport([
      {
        sub: `${EX}Bad`,
        pred: RDFS_SUB_CLASS_OF,
        obj: `${EX}Entry`,
        axioms: "NOT VALID NTRIPLES!!!",
      },
      {
        sub: `${EX}Good`,
        pred: RDFS_SUB_CLASS_OF,
        obj: `${EX}Entry`,
        axioms: `<${EX}Good> <${RDFS_SUB_CLASS_OF}> <${EX}Entry> .`,
      },
    ]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(2);

    // Bad entry has no axioms (nil-path)
    const badJ = justifies.find(j => {
      const qt = j.object as unknown as ReturnType<typeof quad>;
      return qt.subject.value === `${EX}Bad`;
    });
    expect(badJ).toBeDefined();
    const badAxioms = store.getQuads(badJ!.subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(badAxioms).toHaveLength(0);

    // Good entry has axiom
    const goodJ = justifies.find(j => {
      const qt = j.object as unknown as ReturnType<typeof quad>;
      return qt.subject.value === `${EX}Good`;
    });
    expect(goodJ).toBeDefined();
    const goodAxioms = store.getQuads(goodJ!.subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(goodAxioms).toHaveLength(1);
  });

  it("blank node in axiom triple", () => {
    const store = new Store();
    const bulk = makeBulkExport([{
      sub: `${EX}Dog`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}Animal`,
      axioms: `_:b1 <${RDF_TYPE}> <${EX}Dog> .`,
    }]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const axioms = store.getQuads(null, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(1);
    const quotedAxiom = axioms[0].object as unknown as ReturnType<typeof quad>;
    expect(quotedAxiom.subject.termType).toBe("BlankNode");
  });

  it("nil-path for inferred triples without C++ justification", () => {
    const store = new Store();
    const infGraph = namedNode(INFERRED_GRAPH_IRI);

    // Add inferred triple that has NO corresponding bulk export entry
    store.addQuad(quad(
      namedNode(`${EX}Orphan`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Thing`),
      infGraph,
    ));

    // Bulk export has a different triple
    const bulk = makeBulkExport([{
      sub: `${EX}Dog`,
      pred: RDFS_SUB_CLASS_OF,
      obj: `${EX}Animal`,
      axioms: `<${EX}Dog> <${RDFS_SUB_CLASS_OF}> <${EX}Animal> .`,
    }]);

    serializeExplanations(store, bulk, EXPLANATION_GRAPH_IRI);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(2);

    // Orphan should have a nil-path entry
    const orphanJ = justifies.find(j => {
      const qt = j.object as unknown as ReturnType<typeof quad>;
      return qt.subject.value === `${EX}Orphan`;
    });
    expect(orphanJ).toBeDefined();
    const orphanAxioms = store.getQuads(orphanJ!.subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(orphanAxioms).toHaveLength(0);
  });
});
