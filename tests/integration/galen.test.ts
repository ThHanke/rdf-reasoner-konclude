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

describe.skipIf(!wasmExists)("GALEN medical ontology integration", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    store = new Store(loadFixture("galen.nt"));
    await reasoner.classify(store);
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds on GALEN (30k triple medical ontology)", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("TBox inferred graph is superset of native new inferences (OWL2-DL conformant)", () => {
    const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
    assertNativeIsSubset(inferred, "galen-inferred-tbox.nt", [SUBCLASS_OF, EQUIVALENT_CLASS]);
  });
});
