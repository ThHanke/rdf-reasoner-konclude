/**
 * Integration test: property hierarchy classification
 *
 * Tests `RdfReasoner.classifyProperties()` against a small ontology with an
 * explicit rdfs:subPropertyOf assertion, verifying that:
 *   - rdfs:subPropertyOf entailments are returned
 *   - rdf:type and rdfs:subClassOf triples are NOT included in the result
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNTriples(ntriplesStr: string): Quad[] {
  const parser = new Parser({ format: "N-Triples" });
  const quads: Quad[] = [];
  parser.parse(ntriplesStr, (err, quad) => {
    if (err) throw err;
    if (quad) quads.push(quad as Quad);
  });
  return quads;
}

function hasTriple(quads: Quad[], s: string, p: string, o: string): boolean {
  return quads.some(
    (q) =>
      q.subject.value === s &&
      q.predicate.value === p &&
      q.object.value === o,
  );
}

// ---------------------------------------------------------------------------
// Fixture: property hierarchy
//   friendOf rdfs:subPropertyOf knows
// ---------------------------------------------------------------------------

const PROP_NTRIPLES = `
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/friendOf> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/friendOf> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <http://example.org/knows> .
`.trim();

// ---------------------------------------------------------------------------
// IRIs used in assertions
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("classifyProperties() integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("returns rdfs:subPropertyOf triple for explicit subproperty assertion", async () => {
    const quads = parseNTriples(PROP_NTRIPLES);
    const inferred = await reasoner.classifyProperties(quads);

    expect(
      hasTriple(inferred, EX("friendOf"), RDFS_SUB_PROPERTY_OF, EX("knows")),
      "friendOf rdfs:subPropertyOf knows must appear in classifyProperties() output",
    ).toBe(true);
  });

  it("result contains no rdf:type triples", async () => {
    const quads = parseNTriples(PROP_NTRIPLES);
    const inferred = await reasoner.classifyProperties(quads);

    const typeTriples = inferred.filter((q) => q.predicate.value === RDF_TYPE);
    expect(
      typeTriples,
      "classifyProperties() must not return rdf:type triples",
    ).toHaveLength(0);
  });

  it("result contains no rdfs:subClassOf triples", async () => {
    const quads = parseNTriples(PROP_NTRIPLES);
    const inferred = await reasoner.classifyProperties(quads);

    const subClassTriples = inferred.filter(
      (q) => q.predicate.value === RDFS_SUB_CLASS_OF,
    );
    expect(
      subClassTriples,
      "classifyProperties() must not return rdfs:subClassOf triples",
    ).toHaveLength(0);
  });

  it("all returned quads are in the DefaultGraph", async () => {
    const quads = parseNTriples(PROP_NTRIPLES);
    const inferred = await reasoner.classifyProperties(quads);

    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });
});
