/**
 * PoC spike: validate RDF-star quoted triples in N3 Store.
 *
 * Confirms:
 * - N3 Store stores and retrieves RDF-star quads (quoted triple as object)
 * - Blank nodes in quoted triple positions work correctly
 * - Nil-path entries (justification with no axioms) are queryable
 * - Memory footprint measurement (informational)
 */

import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";

const { namedNode, blankNode, quad, defaultGraph } = DataFactory;

const KJ_NS = "urn:konclude:justification#";
const KJ_JUSTIFICATION = `${KJ_NS}Justification`;
const KJ_JUSTIFIES = `${KJ_NS}justifies`;
const KJ_AXIOM = `${KJ_NS}axiom`;
const EXPLANATION_GRAPH = "urn:konclude:explanations";
const INFERRED_GRAPH = "urn:konclude:inferred";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const EX = "http://example.org/";

describe("RDF-star PoC spike", () => {
  it("stores and retrieves RDF-star justification quad", () => {
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);

    const inferredTriple = quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
    );

    const j1 = blankNode("j1");
    store.addQuad(quad(j1, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph));
    store.addQuad(quad(j1, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));

    const results = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(results).toHaveLength(1);
    expect(results[0].object.termType).toBe("Quad");
    const quotedTriple = results[0].object as unknown as ReturnType<typeof quad>;
    expect(quotedTriple.subject.value).toBe(`${EX}Dog`);
    expect(quotedTriple.predicate.value).toBe(RDFS_SUB_CLASS_OF);
    expect(quotedTriple.object.value).toBe(`${EX}Animal`);
  });

  it("stores complete justification with multiple axioms", () => {
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);

    const inferredTriple = quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
    );

    const axiom1 = quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Pet`),
    );
    const axiom2 = quad(
      namedNode(`${EX}Pet`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
    );

    const j1 = blankNode("j1");
    store.addQuad(quad(j1, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph));
    store.addQuad(quad(j1, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));
    store.addQuad(quad(j1, namedNode(KJ_AXIOM), axiom1, explGraph));
    store.addQuad(quad(j1, namedNode(KJ_AXIOM), axiom2, explGraph));

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);

    const axioms = store.getQuads(j1, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(2);
    for (const ax of axioms) {
      expect(ax.object.termType).toBe("Quad");
    }
  });

  it("handles blank node in quoted triple position", () => {
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);

    const inferredTriple = quad(
      blankNode("b1"),
      namedNode(RDF_TYPE),
      namedNode(`${EX}Dog`),
    );

    const j1 = blankNode("j1");
    store.addQuad(quad(j1, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));

    const results = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(results).toHaveLength(1);
    const quotedTriple = results[0].object as unknown as ReturnType<typeof quad>;
    expect(quotedTriple.subject.termType).toBe("BlankNode");
    expect(quotedTriple.subject.value).toBe("b1");
  });

  it("nil-path: justification with no axioms", () => {
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);

    const inferredTriple = quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
    );

    const j1 = blankNode("j1");
    store.addQuad(quad(j1, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph));
    store.addQuad(quad(j1, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));

    const axioms = store.getQuads(j1, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms).toHaveLength(0);

    const justifies = store.getQuads(j1, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies).toHaveLength(1);
  });

  it("cross-graph query: match quoted triple against inferred graph", () => {
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);
    const infGraph = namedNode(INFERRED_GRAPH);

    store.addQuad(quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
      infGraph,
    ));

    const inferredTriple = quad(
      namedNode(`${EX}Dog`),
      namedNode(RDFS_SUB_CLASS_OF),
      namedNode(`${EX}Animal`),
    );
    const j1 = blankNode("j1");
    store.addQuad(quad(j1, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));

    const justifications = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifications).toHaveLength(1);

    const quotedTriple = justifications[0].object as unknown as ReturnType<typeof quad>;
    const matching = store.getQuads(
      namedNode(quotedTriple.subject.value),
      namedNode(quotedTriple.predicate.value),
      namedNode(quotedTriple.object.value),
      infGraph,
    );
    expect(matching).toHaveLength(1);
  });

  it("memory footprint measurement (informational)", () => {
    const COUNT = 1000;
    const store = new Store();
    const explGraph = namedNode(EXPLANATION_GRAPH);

    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < COUNT; i++) {
      const inferredTriple = quad(
        namedNode(`${EX}Class${i}`),
        namedNode(RDFS_SUB_CLASS_OF),
        namedNode(`${EX}SuperClass${i}`),
      );
      const axiomTriple = quad(
        namedNode(`${EX}Class${i}`),
        namedNode(RDFS_SUB_CLASS_OF),
        namedNode(`${EX}Mid${i}`),
      );
      const j = blankNode(`j${i}`);
      store.addQuad(quad(j, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph));
      store.addQuad(quad(j, namedNode(KJ_JUSTIFIES), inferredTriple, explGraph));
      store.addQuad(quad(j, namedNode(KJ_AXIOM), axiomTriple, explGraph));
    }

    const after = process.memoryUsage().heapUsed;
    const storeQuadCount = store.getQuads(null, null, null, explGraph).length;
    const bytesPerQuad = Math.round((after - before) / storeQuadCount);

    console.log(`  N3 Store: ${storeQuadCount} quads, ~${bytesPerQuad} bytes/quad`);
    console.log(`  Total heap delta: ${Math.round((after - before) / 1024)} KB`);

    expect(storeQuadCount).toBe(COUNT * 3);
  });
});
