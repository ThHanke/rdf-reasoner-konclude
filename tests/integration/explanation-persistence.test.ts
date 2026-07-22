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
import { loadFixture } from "../helpers/fixture.js";

const { namedNode } = DataFactory;
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

  it("classify with explanations does not crash (simple ontology)", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store, { explanations: true });

    const inferred = store.getQuads(null, null, null, infGraph);
    expect(inferred.length).toBeGreaterThan(0);
  }, 60000);

  it("classify without explanations leaves explanation graph empty", async () => {
    const store = makeSubClassOntology();
    await reasoner.classify(store);

    const explQuads = store.getQuads(null, null, null, explGraph);
    expect(explQuads).toHaveLength(0);
  }, 60000);

  it("materialize with explanations populates explanation graph (Roberts family)", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.materialize(store, { explanations: true });

      const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
      expect(justifies.length).toBeGreaterThan(0);

      for (const j of justifies) {
        expect(j.object.termType).toBe("Quad");
      }

      const types = store.getQuads(null, namedNode(RDF_TYPE), namedNode(KJ_JUSTIFICATION), explGraph);
      expect(types.length).toBe(justifies.length);
    } finally {
      r.terminate();
    }
  }, 60000);

  it("justification node has kj:axiom quads linking to proof axioms", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.materialize(store, { explanations: true });

      const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
      const withAxioms = justifies.filter(j => {
        const axioms = store.getQuads(j.subject, namedNode(KJ_AXIOM), null, explGraph);
        return axioms.length > 0;
      });
      expect(withAxioms.length).toBeGreaterThan(0);

      const firstWithAxioms = withAxioms[0];
      const axioms = store.getQuads(firstWithAxioms.subject, namedNode(KJ_AXIOM), null, explGraph);
      for (const ax of axioms) {
        expect(ax.object.termType).toBe("Quad");
      }
    } finally {
      r.terminate();
    }
  }, 60000);

  it("second classify (cache hit) keeps explanation graph", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.classify(store, { explanations: true });

      const firstCount = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph).length;
      expect(firstCount).toBeGreaterThanOrEqual(0);

      await r.classify(store, { explanations: true });

      const secondCount = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph).length;
      expect(secondCount).toBe(firstCount);
    } finally {
      r.terminate();
    }
  }, 60000);

  it("classifyProperties with explanations works", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.classifyProperties(store, { explanations: true });

      const inferred = store.getQuads(null, null, null, infGraph);
      expect(inferred.length).toBeGreaterThan(0);
    } finally {
      r.terminate();
    }
  }, 60000);

  it("explanation graph queryable via getQuads pattern matching", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.materialize(store, { explanations: true });

      const allExpl = store.getQuads(null, null, null, explGraph);
      const typeQuads = store.getQuads(null, namedNode(RDF_TYPE), null, explGraph);
      const justifiesQuads = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);

      expect(allExpl.length).toBeGreaterThan(0);
      expect(typeQuads.length).toBe(justifiesQuads.length);
    } finally {
      r.terminate();
    }
  }, 60000);

  it("cache hit with explanations: prior call without → populates on demand", async () => {
    const quads = loadFixture("roberts-family.nt");
    const store = new Store(quads);
    const r = new RdfReasoner();
    await r.ready;
    try {
      await r.materialize(store);
      expect(store.getQuads(null, null, null, explGraph)).toHaveLength(0);

      await r.materialize(store, { explanations: true });
      const justifies = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph);
      expect(justifies.length).toBeGreaterThan(0);
    } finally {
      r.terminate();
    }
  }, 60000);
});
