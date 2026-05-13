/**
 * Integration test: ABox realization
 *
 * Tests `RdfReasoner.classify()` against a small ontology that has both TBox
 * axioms and ABox assertions, verifying that:
 *   - individuals receive rdf:type from superclass chains
 *   - directly asserted rdf:type triples appear in the output
 *   - directly asserted object property triples appear in the output
 *   - TBox-only ontologies produce no rdf:type triples
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
// Fixtures
// ---------------------------------------------------------------------------

/**
 * ABox + TBox fixture:
 *   - Alice rdf:type Employee (asserted)
 *   - Bob   rdf:type Person   (asserted)
 *   - Alice knows Bob         (asserted)
 *   - Employee ⊑ Person       (TBox)
 *
 * Expected inferences:
 *   - Alice rdf:type Person   (via Employee ⊑ Person)
 */
const ABOX_NTRIPLES = `
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Employee> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://example.org/knows> <http://example.org/Bob> .
<http://example.org/Person> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Person> .
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
`.trim();

/**
 * TBox-only fixture: a simple subClassOf chain with no individuals.
 * The classifier should produce rdfs:subClassOf entailments but no rdf:type
 * triples (because there are no ABox individuals to realize).
 */
const TBOX_ONLY_NTRIPLES = `
<http://example.org/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Animal> .
<http://example.org/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Mammal> .
`.trim();

// ---------------------------------------------------------------------------
// IRIs used in assertions
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("ABox realization integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it(
    "individual gets rdf:type from superclass chain — Alice is Employee, Employee ⊑ Person → inferred Alice rdf:type Person",
    async () => {
      const quads = parseNTriples(ABOX_NTRIPLES);
      const inferred = await reasoner.classify(quads);

      expect(
        hasTriple(inferred, EX("Alice"), RDF_TYPE, EX("Person")),
        "Alice rdf:type Person must be inferred via Employee ⊑ Person",
      ).toBe(true);
    },
  );

  it("directly asserted rdf:type appears in output", async () => {
    const quads = parseNTriples(ABOX_NTRIPLES);
    const inferred = await reasoner.classify(quads);

    // The asserted type Employee should be echoed back in the output.
    expect(
      hasTriple(inferred, EX("Alice"), RDF_TYPE, EX("Employee")),
      "Alice rdf:type Employee (direct assertion) must appear in output",
    ).toBe(true);
  });

  it("object property assertion appears in output", async () => {
    const quads = parseNTriples(ABOX_NTRIPLES);
    const inferred = await reasoner.classify(quads);

    expect(
      hasTriple(inferred, EX("Alice"), EX("knows"), EX("Bob")),
      "Alice knows Bob (direct assertion) must appear in output",
    ).toBe(true);
  });

  it("TBox-only ontology produces no rdf:type triples", async () => {
    const quads = parseNTriples(TBOX_ONLY_NTRIPLES);
    const inferred = await reasoner.classify(quads);

    const typeTriples = inferred.filter((q) => q.predicate.value === RDF_TYPE);
    expect(
      typeTriples,
      "TBox-only ontology must produce zero rdf:type triples",
    ).toHaveLength(0);

    // Sanity-check: direct subClassOf edge Mammal ⊑ Animal must appear.
    // (Taxonomy emits direct edges only, not the full transitive closure.)
    expect(
      hasTriple(inferred, EX("Mammal"), RDFS_SUB_CLASS_OF, EX("Animal")),
      "Mammal rdfs:subClassOf Animal must appear in TBox-only run",
    ).toBe(true);
  });
});
