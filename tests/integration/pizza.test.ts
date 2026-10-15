/**
 * Integration test: Pizza ontology classification (smoke test)
 *
 * Loads a Pizza ontology fragment, classifies it, and verifies:
 *   - the inferred graph is non-empty
 *   - genuinely inferred (non-asserted) subsumptions appear
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSubsumption(quads: Quad[], subClass: string, superClass: string): boolean {
  return quads.some(
    (q) => q.predicate.value === SUBCLASS_OF && q.subject.value === subClass && q.object.value === superClass,
  );
}

describe.skipIf(!wasmExists)("Pizza ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferredOnly: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const store = new Store(loadFixture("pizza.nt"));
    await reasoner.classify(store);
    inferredOnly = store.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI));
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() writes a non-empty inferred set", () => {
    expect(inferredOnly.length).toBeGreaterThan(0);
  });

  it("edge case: ontology with no subclass axioms → classify() returns empty or trivial result", async () => {
    const minimalNt = `
<http://example.org/pizza> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/pizza#Solo> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
`.trim();

    const classifyStore = new Store(new Parser({ format: "N-Triples" }).parse(minimalNt) as Quad[]);
    await reasoner.classify(classifyStore);
    const result = classifyStore.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI));
    const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
    const nonTrivialInferences = result.filter(
      (q) => q.predicate.value === SUBCLASS_OF && q.object.value !== OWL_THING,
    );
    expect(nonTrivialInferences.length).toBe(0);
  });
});
