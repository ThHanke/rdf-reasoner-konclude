/**
 * Documents known gaps between WASM Konclude and OWL 2 DL semantics.
 *
 * Tests here use it.skip to keep them visible without polluting the passing
 * suite.  Each skip has a label that matches a plan/issue for tracking.
 */

import { describe, it } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

function parseTurtle(content: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  return parser.parse(content) as Quad[];
}

const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// ALIF+ hang: FunctionalProperty + InverseFunctionalProperty + 1 filler
// ---------------------------------------------------------------------------
// Upstream Konclude bug: when a role has both FP and IFP axioms and the ABox
// has exactly one filler, the ALIF+ saturation rule triggers a precomputation
// loop that never terminates in WASM (plan-043, upstream-bug-003).
// JS workaround in ts/index.ts strips FP/IFP before WASM and materialises
// sameAs pairs in JS — covers the standard FP-only case but not FP+IFP combos.
describe.skipIf(!wasmExists)("known-limitations: ALIF+ (FP+IFP 1-filler hang)", () => {
  it.skip(
    "FP+IFP: 1 filler → both sameAs directions via ALIF+ (hangs, plan-043)",
    async () => {
      const reasoner = new RdfReasoner();
      await reasoner.ready;
      try {
        const quads = parseTurtle(`
          @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
          @prefix owl:  <http://www.w3.org/2002/07/owl#> .
          @prefix ex:   <http://example.org/> .
          ex:hasMother a owl:ObjectProperty ,
                         owl:FunctionalProperty ,
                         owl:InverseFunctionalProperty .
          ex:Eve   a owl:NamedIndividual ; ex:hasMother ex:Carol .
          ex:Alice a owl:NamedIndividual ; ex:hasMother ex:Carol .
        `);
        const inferred = await reasoner.materialize(quads);
        const eveSameAsAlice = inferred.some(
          (q) => q.predicate.value === OWL_SAME_AS && q.subject.value === EX("Eve") && q.object.value === EX("Alice"),
        );
        void eveSameAsAlice;
      } finally {
        reasoner.terminate();
      }
    },
    30_000,
  );
});
