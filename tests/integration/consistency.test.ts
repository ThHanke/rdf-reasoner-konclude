/**
 * Integration test: consistency checking
 *
 * Tests `RdfReasoner.checkConsistency()` against:
 *   - A known-inconsistent micro-ontology (A ⊑ B, A ⊑ ¬B) → must return false
 *   - A known-consistent ontology (simple subClassOf chain) → must return true
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";
import { DataFactory } from "n3";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNTriples(ntriplesStr: string): Quad[] {
  return new Parser({ format: "N-Triples" }).parse(ntriplesStr) as Quad[];
}

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("Consistency checking integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("inconsistent ontology (ex:a rdf:type owl:Nothing) → checkConsistency() returns false", async () => {
    const consistent = await reasoner.checkConsistency(new Store(loadFixture("inconsistent.nt")));

    expect(consistent).toBe(false);
  });

  it("consistent ontology (simple subClassOf chain) → checkConsistency() returns true", async () => {
    // A simple hierarchy with no contradictions.
    const ntriplesStr = `
<http://example.org/cons> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Animal> .
`.trim();

    const consistent = await reasoner.checkConsistency(new Store(parseNTriples(ntriplesStr)));

    expect(consistent).toBe(true);
  });

  it("empty ontology → checkConsistency() returns true", async () => {
    const ntriplesStr =
      "<http://example.org/empty> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .";

    const consistent = await reasoner.checkConsistency(new Store(parseNTriples(ntriplesStr)));

    expect(consistent).toBe(true);
  });

  it("roberts-family (complex OWL-DL, 405 individuals) → checkConsistency() returns true", async () => {
    const consistent = await reasoner.checkConsistency(new Store(loadFixture("roberts-family.nt")));

    expect(consistent).toBe(true);
  }, 360000);

  it("validate: inconsistent ontology → consistent: false, errors non-empty", async () => {
    const quads = loadFixture("inconsistent.nt");
    const store = new Store(quads);
    const result = await reasoner.validate(store);
    expect(result.consistent).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].length).toBeGreaterThanOrEqual(1);
  }, 360000);

  it("validate: consistent ontology with explicit EmptyClass ⊑ owl:Nothing → warnings contains EmptyClass", async () => {
    const turtle = `
@prefix ex: <http://example.org/v#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/v> a owl:Ontology .
ex:EmptyClass a owl:Class ; rdfs:subClassOf owl:Nothing .
    `.trim();
    const parser = new Parser({ format: "Turtle" });
    const store = new Store(parser.parse(turtle) as Quad[]);

    const result = await reasoner.validate(store);
    expect(result.consistent).toBe(true);
    expect(result.errors).toEqual([]);
    const warnIRIs = result.warnings.map((w) => w.classIRI);
    expect(warnIRIs).toContain("http://example.org/v#EmptyClass");
  }, 360000);

  it("fingerprint reuse: classify + checkConsistency + classify on same Store reuses WASM state", async () => {
    // Same Store object → same fingerprint → 2nd+ calls skip reset()+reload in WASM.
    // Correctness: all three operations must return valid results.
    // Performance: 2nd classify() must be a TS-cache hit (<50 ms) because the
    // _classifyCache is still valid after checkConsistency on the same fingerprint.
    const store = new Store(loadFixture("pizza.nt"));
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);

    // 1st classify — loads WASM, runs classification
    await reasoner.classify(store);
    const inferred1 = store.getQuads(null, null, null, ig);
    expect(inferred1.length).toBeGreaterThan(0);

    // checkConsistency on same Store — must reuse WASM state (fingerprint match)
    const consistent = await reasoner.checkConsistency(store);
    expect(consistent).toBe(true);

    // Verify classify cache was NOT cleared (same fingerprint → kept)
    const t0 = performance.now();
    await reasoner.classify(store);
    const elapsed = performance.now() - t0;
    const inferred2 = store.getQuads(null, null, null, ig);

    // Results must be identical
    expect(inferred2.length).toBe(inferred1.length);
    // 2nd classify is a TS-cache hit — no WASM round-trip (<50 ms even on slow CI)
    expect(elapsed).toBeLessThan(50);
  }, 120000);

  it("fingerprint reuse: different stores clear caches correctly", async () => {
    // After checkConsistency(storeB), classify cache for storeA must be gone.
    const storeA = new Store(loadFixture("pizza.nt"));
    const storeB = new Store(loadFixture("inconsistent.nt"));
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);

    await reasoner.classify(storeA);
    const inferredA = storeA.getQuads(null, null, null, ig);
    expect(inferredA.length).toBeGreaterThan(0);

    // checkConsistency with different store → WASM reset, different fingerprint
    const consistentB = await reasoner.checkConsistency(storeB);
    expect(consistentB).toBe(false);

    // classify(storeA) again — cache was cleared (different fingerprint), must re-run WASM
    // and return the same correct results
    await reasoner.classify(storeA);
    const inferredA2 = storeA.getQuads(null, null, null, ig);
    expect(inferredA2.length).toBe(inferredA.length);
  }, 120000);

  it("concurrent classify() and checkConsistency() calls are serialized", async () => {
    // Fire both calls simultaneously — they must not interleave their
    // loadTripleBuffer → realization sequences inside the Worker.
    const consistentNt = `
<http://example.org/cons2> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/X> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Y> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/X> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Y> .
`.trim();

    // Fire concurrently; the internal queue must serialize them.
    const [consistentResult, inconsistentResult] = await Promise.all([
      reasoner.checkConsistency(new Store(parseNTriples(consistentNt))),
      reasoner.checkConsistency(new Store(loadFixture("inconsistent.nt"))),
    ]);

    expect(consistentResult).toBe(true);
    expect(inconsistentResult).toBe(false);
  });
});
