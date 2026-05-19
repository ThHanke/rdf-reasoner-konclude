/**
 * Integration test: OWL 2 DL capabilities
 *
 * Verifies that Konclude handles OWL 2 DL constructs that a simple OWL-RL /
 * BGP reasoner cannot:
 *   - owl:equivalentClass with owl:intersectionOf
 *   - owl:equivalentClass with owl:minCardinality restrictions
 *
 * Expected DL inferences (none of these appear in OWL-RL output):
 *   Father rdfs:subClassOf Male     (via equivalentClass: Father ≡ Male ⊓ Parent)
 *   Father rdfs:subClassOf Parent   (via equivalentClass: Father ≡ Male ⊓ Parent)
 *   Father rdfs:subClassOf Person   (transitive: Father ⊑ Male ⊑ Person)
 *   Parent rdfs:subClassOf Person   (via equivalentClass: Parent ≡ Person ⊓ ≥1 hasChild)
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`). When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Fixture (Turtle) — OWL 2 DL vs OWL-RL comparison
// ---------------------------------------------------------------------------

const DL_TURTLE = `
@prefix ex:   <http://example.org/dl-demo#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<http://example.org/dl-demo> a owl:Ontology .

ex:Person a owl:Class .
ex:Male   a owl:Class ; rdfs:subClassOf ex:Person .
ex:Female a owl:Class ; rdfs:subClassOf ex:Person .
ex:Male owl:disjointWith ex:Female .

ex:hasChild a owl:ObjectProperty ;
    rdfs:domain ex:Person ;
    rdfs:range  ex:Person .

# Parent ≡ Person ⊓ ≥1 hasChild  [OWL 2 DL only]
ex:Parent a owl:Class ;
    owl:equivalentClass [
        a owl:Class ;
        owl:intersectionOf (
            ex:Person
            [ a owl:Restriction ; owl:onProperty ex:hasChild ; owl:minCardinality 1 ]
        )
    ] .

# Father ≡ Male ⊓ Parent  [OWL 2 DL only]
ex:Father a owl:Class ;
    owl:equivalentClass [
        a owl:Class ;
        owl:intersectionOf ( ex:Male ex:Parent )
    ] .
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EX  = (s: string) => `http://example.org/dl-demo#${s}`;
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSub(quads: Quad[], sub: string, sup: string): boolean {
  return quads.some((q) => q.subject.value === sub && q.predicate.value === SUB && q.object.value === sup);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("OWL 2 DL capabilities — classify()", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const parser = new Parser({ format: "Turtle" });
    const quads = parser.parse(DL_TURTLE) as Quad[];
    inferred = await reasoner.classify(quads);
  }, 30000);

  afterAll(() => reasoner?.terminate());

  it("Father rdfs:subClassOf Male (via equivalentClass: Father ≡ Male ⊓ Parent)", () => {
    expect(hasSub(inferred, EX("Father"), EX("Male"))).toBe(true);
  });

  it("Father rdfs:subClassOf Parent (via equivalentClass: Father ≡ Male ⊓ Parent)", () => {
    expect(hasSub(inferred, EX("Father"), EX("Parent"))).toBe(true);
  });

  it("Male rdfs:subClassOf Person + Father ⊑ Male form the chain Father → Male → Person (Hasse diagram, no redundant transitive edge)", () => {
    // Konclude emits direct (Hasse) edges only — Father ⊑ Person is NOT emitted
    // because it is subsumed by the direct path Father ⊑ Male ⊑ Person.
    expect(hasSub(inferred, EX("Father"), EX("Male"))).toBe(true);
    expect(hasSub(inferred, EX("Male"),   EX("Person"))).toBe(true);
    expect(hasSub(inferred, EX("Father"), EX("Person"))).toBe(false);
  });

  it("Parent rdfs:subClassOf Person (via equivalentClass: Parent ≡ Person ⊓ ≥1 hasChild)", () => {
    expect(hasSub(inferred, EX("Parent"), EX("Person"))).toBe(true);
  });

  it("Male rdfs:subClassOf Person (direct TBox assertion)", () => {
    expect(hasSub(inferred, EX("Male"), EX("Person"))).toBe(true);
  });

  it("no rdf:type triples in classify() output (TBox only)", () => {
    const typeTriples = inferred.filter(
      (q) => q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    );
    expect(typeTriples).toHaveLength(0);
  });
});
