/**
 * Integration test: Pizza ontology classification (smoke test)
 *
 * NOTE: This is a smoke test using a hand-crafted Pizza ontology fragment.
 * The authoritative integration tests that exercise real-world OWL-DL
 * complexity are in roberts-family.test.ts (Roberts family tree, 3866 triples)
 * and lubm.test.ts (LUBM university benchmark schema, 307 triples).
 *
 * Loads a representative Pizza ontology fragment (NTriples), classifies it
 * using `RdfReasoner`, and asserts that known subsumption pairs appear in the
 * inferred quads.
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

function hasSubsumption(
  quads: Quad[],
  subClass: string,
  superClass: string,
): boolean {
  const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
  return quads.some(
    (q) =>
      q.predicate.value === SUBCLASS_OF &&
      q.subject.value === subClass &&
      q.object.value === superClass,
  );
}

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("Pizza ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];
  let inputQuads: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    inputQuads = loadFixture("pizza.nt");
    inferred = await reasoner.classify(inputQuads);
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds and returns inferred quads", () => {
    expect(Array.isArray(inferred)).toBe(true);
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("inferred quad count exceeds input axiom count (reasoner produces new triples)", () => {
    expect(inferred.length).toBeGreaterThan(inputQuads.length);
  });

  it("asserted axiom VegetarianPizza ⊑ Pizza appears in results", () => {
    expect(
      hasSubsumption(
        inferred,
        "http://example.org/pizza#VegetarianPizza",
        "http://example.org/pizza#Pizza",
      ),
    ).toBe(true);
  });

  it("asserted axiom MeatyPizza ⊑ Pizza appears in results", () => {
    expect(
      hasSubsumption(
        inferred,
        "http://example.org/pizza#MeatyPizza",
        "http://example.org/pizza#Pizza",
      ),
    ).toBe(true);
  });

  it("VegetarianPizza ⊑ Food inferred transitively (via Pizza ⊑ Food)", () => {
    expect(
      hasSubsumption(
        inferred,
        "http://example.org/pizza#VegetarianPizza",
        "http://example.org/pizza#Food",
      ),
    ).toBe(true);
  });

  it("asserted axiom IceCream ⊑ Food appears in results", () => {
    expect(
      hasSubsumption(
        inferred,
        "http://example.org/pizza#IceCream",
        "http://example.org/pizza#Food",
      ),
    ).toBe(true);
  });

  it("MeatyPizza ⊑ Food inferred transitively (via Pizza ⊑ Food)", () => {
    expect(
      hasSubsumption(
        inferred,
        "http://example.org/pizza#MeatyPizza",
        "http://example.org/pizza#Food",
      ),
    ).toBe(true);
  });

  it("all returned quads are in the DefaultGraph", () => {
    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });

  it("edge case: ontology with no subclass axioms → classify() returns empty or trivial result", async () => {
    // Load only OWL Class declarations, no subClassOf axioms.
    const minimalNt = `
<http://example.org/pizza> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/pizza#Solo> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
`.trim();

    const parser = new Parser({ format: "N-Triples" });
    const quads: Quad[] = [];
    parser.parse(minimalNt, (err, quad) => {
      if (err) throw err;
      if (quad) quads.push(quad as Quad);
    });

    const result = await reasoner.classify(quads);
    // No subClassOf axioms → no transitive inferences expected.
    const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
    const subClassInferences = result.filter(
      (q) => q.predicate.value === SUBCLASS_OF,
    );
    expect(subClassInferences.length).toBe(0);
  });
});
