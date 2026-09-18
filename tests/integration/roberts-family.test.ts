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
import { Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";
import { assertExactMatch, assertNativeIsSubset } from "../helpers/compare-native.js";

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
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("Roberts family ontology integration", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    store = new Store(loadFixture("roberts-family.nt"));
    await reasoner.classify(store);
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() writes inferred quads to the store", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    expect(inferred.length).toBeGreaterThanOrEqual(20);
  });

  it("TBox inferred graph is superset of native new inferences (OWL2-DL conformant)", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    assertNativeIsSubset(inferred, "roberts-inferred-tbox.nt", [SUBCLASS_OF, EQUIVALENT_CLASS]);
  });

  // ── Phase 3: ABox realization ─────────────────────────────────────────────

  it("ABox is superset of native Konclude output (OWL2-DL conformant)", async () => {
    const aboxReasoner = new RdfReasoner();
    await aboxReasoner.ready;
    try {
      const aboxStore = new Store(loadFixture("roberts-family.nt"));
      await aboxReasoner.materialize(aboxStore);
      const inferredABox = aboxStore.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
      assertNativeIsSubset(inferredABox, "roberts-native-abox.nt", [RDF_TYPE]);
    } finally {
      aboxReasoner.terminate();
    }
  }, 360000);

  it("sequential call stability: second classify() on same reasoner succeeds", async () => {
    const lubmStore = new Store(loadFixture("lubm.nt"));
    await reasoner.classify(lubmStore);
    const inferred2 = lubmStore.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    expect(inferred2.length).toBeGreaterThan(0);
  }, 30000);
});
