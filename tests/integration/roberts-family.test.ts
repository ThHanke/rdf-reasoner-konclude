/**
 * Integration test: Roberts family ontology classification
 *
 * Uses the real Roberts family tree ontology from the Konclude test suite
 * (http://www.co-ode.org/roberts/family-tree.owl), converted to NTriples.
 * This is a rich OWL-DL ontology with nominals, property chains, and
 * individual names — substantially more demanding than the hand-crafted
 * pizza smoke test.
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
import { assertExactMatch } from "../helpers/compare-native.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("Roberts family ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];
  let inputQuads: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    inputQuads = loadFixture("roberts-family.nt");
    inferred = await reasoner.classify(inputQuads);
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds and returns inferred quads", () => {
    expect(Array.isArray(inferred)).toBe(true);
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("inferred quad count is substantial (rich ontology produces many triples)", () => {
    // The Roberts family ontology has dozens of named classes with complex
    // OWL-DL restrictions; the reasoner must produce many inferred subsumptions.
    expect(inferred.length).toBeGreaterThanOrEqual(20);
  });

  it("all returned quads are in the DefaultGraph", () => {
    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });

  it("TBox matches native Konclude output exactly (set equality)", () => {
    assertExactMatch(inferred, "roberts-native-tbox.nt", [SUBCLASS_OF, EQUIVALENT_CLASS]);
  });

  // ── Phase 3: ABox realization ─────────────────────────────────────────────

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

  it("ABox matches native Konclude output exactly (set equality)", () => {
    assertExactMatch(inferred, "roberts-native-abox.nt", [RDF_TYPE]);
  });

  it("sequential call stability: second classify() on same reasoner succeeds", async () => {
    // Call classify() again on the same reasoner with a different (small) ontology.
    // Tests that STPU + realizer threads reset correctly between calls.
    const lubmQuads = loadFixture("lubm.nt");
    const inferred2 = await reasoner.classify(lubmQuads);
    expect(Array.isArray(inferred2)).toBe(true);
    expect(inferred2.length).toBeGreaterThan(0);
  }, 30000);
});
