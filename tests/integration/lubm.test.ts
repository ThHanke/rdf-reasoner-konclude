/**
 * Integration test: LUBM university benchmark ontology classification
 *
 * Uses the LUBM (Lehigh University Benchmark) schema ontology
 * (http://www.lehigh.edu/~zhp2/2004/0401/univ-bench.owl), converted to NTriples.
 * LUBM is a well-known OWL benchmark with a clean academic hierarchy:
 * Professor subtypes, Publication subtypes, Staff subtypes, etc.
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
import { assertNativeIsSubset } from "../helpers/compare-native.js";

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

describe.skipIf(!wasmExists)("LUBM university benchmark ontology integration", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    store = new Store(loadFixture("lubm.nt"));
    await reasoner.classify(store);
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds and inferred triples are written to the store", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("TBox inferred graph is superset of native new inferences (OWL2-DL conformant)", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    assertNativeIsSubset(inferred, "lubm-inferred-tbox.nt", [SUBCLASS_OF, EQUIVALENT_CLASS]);
  });
});
