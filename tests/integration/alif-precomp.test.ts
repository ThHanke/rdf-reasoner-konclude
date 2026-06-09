/**
 * Integration test: ALIF+ precomputing deadlock regression test
 *
 * Verifies that materialize() with owl:FunctionalProperty (Fixture A — 1 filler)
 * completes after a prior checkConsistency() call on the same RdfReasoner instance.
 *
 * Root cause (fixed by patch 034): mCurrRunningTestParallelCount in
 * CPrecomputationThread was not reset when a new ontology item was created.
 * A stale count > 0 from the previous call caused doNextPendingTests() →
 * canProcessMoreTests() → false → deadlock.
 *
 * See docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

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
// Fixtures
// ---------------------------------------------------------------------------

// Fixture A: FP, 1 filler — COMPLETES in native Konclude ~19ms, HANGS in WASM
// From docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md
const FIXTURE_A_NT = `\
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/eve> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/eve> .`;

// Warmup: trivial non-FP ontology (same as consistency.test.ts "consistent" case)
const WARMUP_NT = `\
<http://example.org/cons> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Animal> .`;

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("ALIF+ precomputing deadlock — regression test", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("warmup: non-FP ontology → checkConsistency() completes", async () => {
    const quads = parseNTriples(WARMUP_NT);
    const consistent = await reasoner.checkConsistency(quads);
    expect(typeof consistent).toBe("boolean");
  });

  it(
    "Fixture A: FP 1-filler → materialize() completes after warmup (regression for patch 034)",
    { timeout: 3000 },
    async () => {
      const quads = parseNTriples(FIXTURE_A_NT);
      const result = await reasoner.materialize(quads);
      expect(result).toBeDefined();
      // 1 filler → functional property does not force a merge → no sameAs needed
      expect(
        result.filter((q: Quad) => q.predicate.value === "http://www.w3.org/2002/07/owl#sameAs"),
      ).toHaveLength(0);
    },
  );
});
