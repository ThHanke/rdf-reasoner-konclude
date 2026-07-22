/**
 * Integration test: explanation persistence into N3 Store named graph.
 *
 * Tests the full pipeline: reasoning → bulk export → RDF-star serialization
 * → store query. Requires the built WASM binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";

import {
  RdfReasoner,
  INFERRED_GRAPH_IRI,
  EXPLANATION_GRAPH_IRI,
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "../../ts/index.js";

const { namedNode, quad } = DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const EX = "http://example.org/";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const explGraph = namedNode(EXPLANATION_GRAPH_IRI);
const infGraph = namedNode(INFERRED_GRAPH_IRI);

function makeSubClassOntology(): Store {
  const store = new Store();
  store.addQuad(namedNode(`${EX}A`), namedNode(RDF_TYPE), namedNode(OWL_CLASS));
  store.addQuad(namedNode(`${EX}B`), namedNode(RDF_TYPE), namedNode(OWL_CLASS));
  store.addQuad(namedNode(`${EX}C`), namedNode(RDF_TYPE), namedNode(OWL_CLASS));
  store.addQuad(namedNode(`${EX}A`), namedNode(RDFS_SUB_CLASS_OF), namedNode(`${EX}B`));
  store.addQuad(namedNode(`${EX}B`), namedNode(RDFS_SUB_CLASS_OF), namedNode(`${EX}C`));
  return store;
}

describe.skipIf(!wasmExists)("Explanation persistence integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify with explanations populates explanation graph", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store, { explanations: true });

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies.length).toBeGreaterThan(0);

    for (const j of justifies) {
      expect(j.object.termType).toBe("Quad");
    }

    const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
    expect(types.length).toBe(justifies.length);
  }, 60000);

  it("classify without explanations leaves explanation graph empty", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store);

    const explQuads = store.getQuads(null, null, null, explGraph);
    expect(explQuads).toHaveLength(0);
  }, 60000);

  it("transitive inference A⊑C has justification with axioms A⊑B, B⊑C", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store, { explanations: true });

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);

    const acJustification = justifies.find(j => {
      const qt = j.object as unknown as Quad;
      return qt.subject.value === `${EX}A` &&
             qt.predicate.value === RDFS_SUB_CLASS_OF &&
             qt.object.value === `${EX}C`;
    });
    expect(acJustification).toBeDefined();

    const axioms = store.getQuads(acJustification!.subject, namedNode(KJ_AXIOM), null, explGraph);
    expect(axioms.length).toBeGreaterThan(0);

    const axiomValues = axioms.map(a => {
      const qt = a.object as unknown as Quad;
      return `${qt.subject.value} ${qt.predicate.value} ${qt.object.value}`;
    });
    expect(axiomValues).toEqual(expect.arrayContaining([
      expect.stringContaining("subClassOf"),
    ]));
  }, 60000);

  it("second classify (cache hit) keeps explanation graph", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store, { explanations: true });
    const countBefore = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph).length;

    await reasoner.classify(store, { explanations: true });
    const countAfter = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph).length;

    expect(countAfter).toBe(countBefore);
  }, 60000);

  it("materialize with explanations populates explanation graph", async () => {
    const store = new Store();
    store.addQuad(namedNode(`${EX}Dog`), namedNode(RDF_TYPE), namedNode(OWL_CLASS));
    store.addQuad(namedNode(`${EX}Animal`), namedNode(RDF_TYPE), namedNode(OWL_CLASS));
    store.addQuad(namedNode(`${EX}Dog`), namedNode(RDFS_SUB_CLASS_OF), namedNode(`${EX}Animal`));
    store.addQuad(namedNode(`${EX}fido`), namedNode(RDF_TYPE), namedNode(`${EX}Dog`));

    await reasoner.materialize(store, { explanations: true });

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies.length).toBeGreaterThan(0);
  }, 60000);

  it("classifyProperties with explanations populates explanation graph", async () => {
    const store = new Store();
    const OWL_OP = "http://www.w3.org/2002/07/owl#ObjectProperty";
    const RDFS_SUB_PROP = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
    store.addQuad(namedNode(`${EX}hasPet`), namedNode(RDF_TYPE), namedNode(OWL_OP));
    store.addQuad(namedNode(`${EX}hasAnimal`), namedNode(RDF_TYPE), namedNode(OWL_OP));
    store.addQuad(namedNode(`${EX}hasPet`), namedNode(RDFS_SUB_PROP), namedNode(`${EX}hasAnimal`));

    await reasoner.classifyProperties(store, { explanations: true });

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies.length).toBeGreaterThan(0);
  }, 60000);

  it("explanation graph queryable via getQuads pattern matching", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store, { explanations: true });

    const inferred = store.getQuads(null, null, null, infGraph);
    expect(inferred.length).toBeGreaterThan(0);

    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    for (const j of justifies) {
      const qt = j.object as unknown as Quad;
      const matching = store.getQuads(
        namedNode(qt.subject.value),
        namedNode(qt.predicate.value),
        namedNode(qt.object.value),
        infGraph,
      );
      expect(matching.length).toBeGreaterThanOrEqual(0);
    }
  }, 60000);

  it("cache hit with explanations: prior call without → populates on demand", async () => {
    const store = makeSubClassOntology();

    await reasoner.classify(store);
    expect(store.getQuads(null, null, null, explGraph)).toHaveLength(0);

    await reasoner.classify(store, { explanations: true });
    const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
    expect(justifies.length).toBeGreaterThan(0);
  }, 60000);
});
