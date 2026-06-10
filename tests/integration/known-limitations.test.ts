/**
 * Documents known gaps between WASM Konclude and OWL 2 DL semantics.
 *
 * Tests here use it.skip to keep them visible without polluting the passing
 * suite.  Each skip has a label that matches a plan/issue for tracking.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

function parseTurtle(content: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  return parser.parse(content) as Quad[];
}

const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// ABox realization gap: owl:minCardinality / owl:minQualifiedCardinality
// ---------------------------------------------------------------------------
// Discovered 2026-06-10 during ontosphere integration. Konclude's realizer
// does not produce rdf:type assertions from cardinality restrictions. classify()
// and checkConsistency() work; materialize() does not fire.
// Workaround: use owl:intersectionOf of two owl:someValuesFrom restrictions.
describe.skipIf(!wasmExists)("known-limitations: minCardinality ABox realization gap", () => {
  it.skip("minCardinality 2: individual satisfying restriction not typed as restricted class", async () => {
    const reasoner = new RdfReasoner();
    await reasoner.ready;
    try {
      const quads = parseTurtle(`
        @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix owl:  <http://www.w3.org/2002/07/owl#> .
        @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
        @prefix ex:   <http://example.org/> .

        ex:manages a owl:ObjectProperty .
        ex:TeamLead a owl:Class ;
            owl:equivalentClass [
                a owl:Restriction ;
                owl:onProperty ex:manages ;
                owl:minCardinality 2
            ] .
        ex:dave a owl:NamedIndividual ;
            ex:manages ex:bob , ex:eve .
        ex:bob  a owl:NamedIndividual .
        ex:eve  a owl:NamedIndividual .
        ex:bob owl:differentFrom ex:eve .
      `);
      const inferred = await reasoner.materialize(quads);
      const daveIsTeamLead = inferred.some(
        (q) => q.predicate.value === RDF_TYPE && q.subject.value === EX("dave") && q.object.value === EX("TeamLead"),
      );
      expect(daveIsTeamLead).toBe(true);
    } finally {
      reasoner.terminate();
    }
  });
});

// ---------------------------------------------------------------------------
// ABox realization gap: owl:oneOf (nominal class)
// ---------------------------------------------------------------------------
// Discovered 2026-06-10 during ontosphere integration. materialize() emits
// only LeadershipTeam rdfs:subClassOf owl:Thing; no individual rdf:type
// assertions for enumerated members.
// Workaround: use owl:equivalentClass [ a owl:Class ; owl:unionOf (...) ].
describe.skipIf(!wasmExists)("known-limitations: owl:oneOf ABox realization gap", () => {
  it.skip("oneOf: enumerated individuals not typed as nominal class", async () => {
    const reasoner = new RdfReasoner();
    await reasoner.ready;
    try {
      const quads = parseTurtle(`
        @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix owl:  <http://www.w3.org/2002/07/owl#> .
        @prefix ex:   <http://example.org/> .

        ex:LeadershipTeam a owl:Class ;
            owl:oneOf (ex:alice ex:dave) .
        ex:alice a owl:NamedIndividual .
        ex:dave  a owl:NamedIndividual .
      `);
      const inferred = await reasoner.materialize(quads);
      const aliceTyped = inferred.some(
        (q) => q.predicate.value === RDF_TYPE && q.subject.value === EX("alice") && q.object.value === EX("LeadershipTeam"),
      );
      expect(aliceTyped).toBe(true);
    } finally {
      reasoner.terminate();
    }
  });
});

// ---------------------------------------------------------------------------
// ALIF+ hang: FunctionalProperty + InverseFunctionalProperty + 1 filler
// ---------------------------------------------------------------------------
// Upstream Konclude bug: when a role has both FP and IFP axioms and the ABox
// has exactly one filler, the ALIF+ saturation rule triggers a precomputation
// loop that never terminates in WASM (plan-043, upstream-bug-003).
// JS workaround in ts/index.ts strips FP/IFP before WASM and materialises
// sameAs pairs in JS — covers the standard FP-only case but not FP+IFP combos.
describe.skipIf(!wasmExists)("known-limitations: ALIF+ (FP+IFP 1-filler hang)", () => {
  it.skip(
    "FP+IFP: 1 filler → both sameAs directions via ALIF+ (hangs, plan-043)",
    async () => {
      const reasoner = new RdfReasoner();
      await reasoner.ready;
      try {
        const quads = parseTurtle(`
          @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
          @prefix owl:  <http://www.w3.org/2002/07/owl#> .
          @prefix ex:   <http://example.org/> .
          ex:hasMother a owl:ObjectProperty ,
                         owl:FunctionalProperty ,
                         owl:InverseFunctionalProperty .
          ex:Eve   a owl:NamedIndividual ; ex:hasMother ex:Carol .
          ex:Alice a owl:NamedIndividual ; ex:hasMother ex:Carol .
        `);
        const inferred = await reasoner.materialize(quads);
        const eveSameAsAlice = inferred.some(
          (q) => q.predicate.value === OWL_SAME_AS && q.subject.value === EX("Eve") && q.object.value === EX("Alice"),
        );
        void eveSameAsAlice;
      } finally {
        reasoner.terminate();
      }
    },
    30_000,
  );
});
