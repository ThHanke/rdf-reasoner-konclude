/**
 * Integration test: property hierarchy classification
 *
 * Tests `RdfReasoner.classifyProperties()` against a small ontology with an
 * explicit rdfs:subPropertyOf assertion, verifying that:
 *   - rdf:type and rdfs:subClassOf triples are NOT written to the inferred graph
 *   - the inferred graph is non-empty
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

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

function parseNTriples(ntriplesStr: string): Quad[] {
  return new Parser({ format: "N-Triples" }).parse(ntriplesStr) as Quad[];
}

// Fixture: friendOf rdfs:subPropertyOf knows
const PROP_NTRIPLES = `
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/friendOf> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/friendOf> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <http://example.org/knows> .
`.trim();

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

describe.skipIf(!wasmExists)("classifyProperties() integration", () => {
  let reasoner: RdfReasoner;
  let inferredOnly: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const store = new Store(parseNTriples(PROP_NTRIPLES));
    await reasoner.classifyProperties(store);
    inferredOnly = store.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI));
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("inferred graph is non-empty", () => {
    expect(inferredOnly.length).toBeGreaterThan(0);
  });

  it("inferred graph contains no rdf:type triples", () => {
    const typeTriples = inferredOnly.filter((q) => q.predicate.value === RDF_TYPE);
    expect(typeTriples, "classifyProperties() must not write rdf:type triples to inferred graph").toHaveLength(0);
  });

  it("inferred graph contains no rdfs:subClassOf triples", () => {
    const subClassTriples = inferredOnly.filter((q) => q.predicate.value === RDFS_SUB_CLASS_OF);
    expect(subClassTriples, "classifyProperties() must not write rdfs:subClassOf triples to inferred graph").toHaveLength(0);
  });
});
