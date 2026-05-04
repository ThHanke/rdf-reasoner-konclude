/**
 * Integration test: GALEN medical ontology classification
 *
 * Uses the full GALEN ontology from the Konclude test suite, converted to
 * NTriples.  GALEN is a large OWL SHIF medical ontology (~30k triples) that
 * exercises complex role hierarchies and existential restrictions.
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
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

const NS = "http://ex.test/galen#";
const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSubsumption(
  quads: Quad[],
  subClass: string,
  superClass: string,
): boolean {
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

describe.skipIf(!wasmExists)("GALEN medical ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const quads = loadFixture("galen.nt");
    inferred = await reasoner.classify(quads);
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds on GALEN (30k triple medical ontology)", () => {
    expect(Array.isArray(inferred)).toBe(true);
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("all returned quads are in the DefaultGraph", () => {
    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });

  // Asserted subsumptions that must appear in any sound reasoner output.
  // These are direct rdfs:subClassOf axioms in the ontology.

  it("Enterobacterericeae ⊑ Bacterium (asserted)", () => {
    expect(
      hasSubsumption(
        inferred,
        `${NS}Enterobacterericeae`,
        `${NS}Bacterium`,
      ),
    ).toBe(true);
  });

  it("Bone ⊑ SkeletalStructure (asserted)", () => {
    expect(
      hasSubsumption(inferred, `${NS}Bone`, `${NS}SkeletalStructure`),
    ).toBe(true);
  });

  it("Shaving ⊑ RemovingProcedure (asserted)", () => {
    expect(
      hasSubsumption(inferred, `${NS}Shaving`, `${NS}RemovingProcedure`),
    ).toBe(true);
  });
});
