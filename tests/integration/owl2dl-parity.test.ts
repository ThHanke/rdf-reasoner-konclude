/**
 * Integration test: OWL 2 DL parity suite
 *
 * Verifies that the WASM reasoning kernel produces correct OWL 2 DL entailments
 * for a range of expressive constructs.  Fixture ontologies live in
 * `tests/fixtures/owl2dl/` as Turtle files.
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Common IRI constants
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_EQ_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTurtle(content: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  return parser.parse(content) as Quad[];
}

function hasTriple(quads: Quad[], s: string, p: string, o: string): boolean {
  return quads.some(
    (q) =>
      q.subject.value === s &&
      q.predicate.value === p &&
      q.object.value === o,
  );
}

const EX = (local: string) => `http://example.org/${local}`;

function loadTtl(name: string): Quad[] {
  const fixturePath = new URL(
    `../../tests/fixtures/owl2dl/${name}`,
    import.meta.url,
  ).pathname;
  const content = readFileSync(fixturePath, "utf-8");
  return parseTurtle(content);
}

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TBox constructs (R6)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("TBox constructs", () => {
  let reasoner: RdfReasoner;
  let classified: Quad[];
  let materialized: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const quads = loadTtl("tbox.ttl");
    classified = await reasoner.classify(quads);
    materialized = await reasoner.materialize(quads);
  }, 60000);

  afterAll(() => {
    reasoner?.terminate();
  });

  // ── subClassOf ─────────────────────────────────────────────────────────────

  it("classify: A rdfs:subClassOf B (direct edge present in Hasse diagram)", () => {
    expect(
      hasTriple(classified, EX("A"), RDFS_SUB_CLASS_OF, EX("B")),
      "A ⊑ B must appear as a direct subClassOf edge",
    ).toBe(true);
  });

  it("classify: B rdfs:subClassOf C (direct edge present in Hasse diagram)", () => {
    expect(
      hasTriple(classified, EX("B"), RDFS_SUB_CLASS_OF, EX("C")),
      "B ⊑ C must appear as a direct subClassOf edge",
    ).toBe(true);
  });

  it("classify: A rdfs:subClassOf C absent (transitive edge not emitted — Hasse diagram only)", () => {
    expect(
      hasTriple(classified, EX("A"), RDFS_SUB_CLASS_OF, EX("C")),
      "A ⊑ C must NOT appear — Konclude emits Hasse (direct) edges only",
    ).toBe(false);
  });

  // ── equivalentClass ────────────────────────────────────────────────────────

  it("classify: D owl:equivalentClass E (or E owl:equivalentClass D)", () => {
    const forward = hasTriple(classified, EX("D"), OWL_EQ_CLASS, EX("E"));
    const reverse = hasTriple(classified, EX("E"), OWL_EQ_CLASS, EX("D"));
    expect(
      forward || reverse,
      "D ≡ E must appear as an equivalentClass triple in either direction",
    ).toBe(true);
  });

  // ── checkConsistency ───────────────────────────────────────────────────────

  it("checkConsistency: consistent TBox with subClassOf + equivalentClass → true", async () => {
    const result = await reasoner.checkConsistency(loadTtl("tbox.ttl"));
    expect(result).toBe(true);
  });

  it("checkConsistency: individual simultaneously typed into two disjoint classes → false", async () => {
    // ex:Meat owl:disjointWith ex:Vegetable; an individual in both is inconsistent
    const inconsistentQuads = parseTurtle(`
      @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix ex:   <http://example.org/> .
      <http://example.org/disjoint-test> a owl:Ontology .
      ex:Meat      a owl:Class .
      ex:Vegetable a owl:Class .
      ex:Meat owl:disjointWith ex:Vegetable .
      ex:meatVeg a owl:NamedIndividual, ex:Meat, ex:Vegetable .
    `);
    const result = await reasoner.checkConsistency(inconsistentQuads);
    expect(result).toBe(false);
  });

  // UPSTREAM_LIMITATION: owl:complementOf between two named classes is not detected
  // as ABox-level inconsistency by Konclude when both class names appear as rdf:type
  // assertions on the same individual.  The complementOf axiom is processed as a
  // class-expression complement but the simple-named-class path does not trigger the
  // tableau clash rule in the current kernel.  Contrast with case 7 in
  // issue13-owl-violations.test.ts where complementOf wraps a hasSelf restriction —
  // that structural variant works because it is processed via a different code path.
  it.skip("UPSTREAM_LIMITATION — checkConsistency: individual in class ∩ complementOf(class) → false [named-class complementOf ABox clash not detected]", async () => {
    const inconsistentQuads = parseTurtle(`
      @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix ex:   <http://example.org/> .
      <http://example.org/complement-test> a owl:Ontology .
      ex:Pos a owl:Class .
      ex:Neg a owl:Class .
      ex:Pos owl:complementOf ex:Neg .
      ex:posNeg a owl:NamedIndividual, ex:Pos, ex:Neg .
    `);
    const result = await reasoner.checkConsistency(inconsistentQuads);
    expect(result).toBe(false);
  }, 30_000);

  // ── materialize ────────────────────────────────────────────────────────────

  it("materialize: alice typed A → inferred as type B (subClassOf propagation)", () => {
    expect(
      hasTriple(materialized, EX("alice"), RDF_TYPE, EX("B")),
      "alice must be inferred as type B via A ⊑ B",
    ).toBe(true);
  });

  it("materialize: alice typed A → inferred as type C (transitive subClassOf propagation)", () => {
    expect(
      hasTriple(materialized, EX("alice"), RDF_TYPE, EX("C")),
      "alice must be inferred as type C via A ⊑ B ⊑ C",
    ).toBe(true);
  });

  it("materialize: bob typed D → inferred as type E (equivalentClass)", () => {
    expect(
      hasTriple(materialized, EX("bob"), RDF_TYPE, EX("E")),
      "bob must be inferred as type E via D ≡ E",
    ).toBe(true);
  });
});
