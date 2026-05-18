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
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

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
    const quads = loadFixture("inconsistent.nt");
    const consistent = await reasoner.checkConsistency(quads);

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

    const quads = parseNTriples(ntriplesStr);
    const consistent = await reasoner.checkConsistency(quads);

    expect(consistent).toBe(true);
  });

  it("empty ontology → checkConsistency() returns true", async () => {
    const ntriplesStr =
      "<http://example.org/empty> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .";

    const quads = parseNTriples(ntriplesStr);
    const consistent = await reasoner.checkConsistency(quads);

    expect(consistent).toBe(true);
  });

  it("roberts-family (complex OWL-DL, 405 individuals) → checkConsistency() returns true", async () => {
    const quads = loadFixture("roberts-family.nt");
    const consistent = await reasoner.checkConsistency(quads);

    expect(consistent).toBe(true);
  }, 360000);

  it("concurrent classify() and checkConsistency() calls are serialized", async () => {
    // Fire both calls simultaneously — they must not interleave their
    // loadNTriples → classify sequences inside the Worker.
    const consistentNt = `
<http://example.org/cons2> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/X> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Y> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/X> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Y> .
`.trim();

    const quadsA = parseNTriples(consistentNt);
    const inconsistentQuads = loadFixture("inconsistent.nt");

    // Fire concurrently; the internal queue must serialize them.
    const [consistentResult, inconsistentResult] = await Promise.all([
      reasoner.checkConsistency(quadsA),
      reasoner.checkConsistency(inconsistentQuads),
    ]);

    expect(consistentResult).toBe(true);
    expect(inconsistentResult).toBe(false);
  });
});
