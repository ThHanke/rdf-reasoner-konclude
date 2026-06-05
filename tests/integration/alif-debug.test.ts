/**
 * Integration test: ALIF+ precomputing deadlock investigation (Unit 1)
 *
 * Investigates why materialize() with owl:FunctionalProperty (Fixture A — 1 filler,
 * COMPLETES in native Konclude ~19ms) hangs indefinitely in WASM.
 *
 * The test runs a warmup call first (non-FP ontology), then Fixture A (FP 1-filler).
 * With WASM_PRECOMP_VERBOSE=ON compiled into the binary, [WASM-PRECOMP] log lines
 * allow pinpointing the exact hang location in CTotallyPrecomputationThread.
 *
 * Expected outcome: Fixture A times out (6s) and the test FAILS. That is intentional —
 * the test is a diagnostic, not a passing assertion. The hang location is determined
 * from the [WASM-PRECOMP] log output.
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

describe.skipIf(!wasmExists)("ALIF+ precomputing deadlock — Unit 1 diagnostic", () => {
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
    "Fixture A: FP 1-filler → materialize() [EXPECTED TO HANG/TIMEOUT — diagnostic]",
    { timeout: 6000 },
    async () => {
      const quads = parseNTriples(FIXTURE_A_NT);
      // This call is expected to hang and time out. The timeout failure is the
      // diagnostic signal — check [WASM-PRECOMP] log lines in the test output
      // to determine the exact hang location.
      const result = await reasoner.materialize(quads);
      // If we reach here, the hang was unexpectedly resolved — log the result
      // so we know what inferences were produced.
      console.log("[alif-debug] materialize completed (unexpected!), result quads:", result.length);
      expect(result).toBeDefined();
    },
  );
});
