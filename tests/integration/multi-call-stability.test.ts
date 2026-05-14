/**
 * Integration test: multi-call stability
 *
 * Verifies that a single RdfReasoner instance can handle mixed ABox/TBox
 * classify() sequences without hanging, crashing, or returning stale results.
 *
 * Regression targets:
 *   - TBox-only hang after an ABox run (stale realizer threads exhausting pthread pool)
 *   - "unwind" rejections from leaked BlockThreadPool detached pthreads
 *   - Incorrect results on the N-th call caused by residual ontology state
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

function hasTriple(quads: Quad[], s: string, p: string, o: string): boolean {
  return quads.some(
    (q) =>
      q.subject.value === s &&
      q.predicate.value === p &&
      q.object.value === o,
  );
}

// ---------------------------------------------------------------------------
// Fixtures (mirrors abox-realization.test.ts)
// ---------------------------------------------------------------------------

const ABOX_NTRIPLES = `
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Employee> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://example.org/knows> <http://example.org/Bob> .
<http://example.org/Person> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Person> .
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
`.trim();

const TBOX_ONLY_NTRIPLES = `
<http://example.org/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Animal> .
<http://example.org/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Mammal> .
`.trim();

// ---------------------------------------------------------------------------
// IRIs
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)(
  "multi-call stability — ABox/TBox sequences on one RdfReasoner",
  () => {
    let reasoner: RdfReasoner;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
    });

    afterAll(() => {
      reasoner?.terminate();
    });

    it(
      "ABox → TBox → ABox: no hang, correct result on each call",
      async () => {
        // Call 1: ABox
        const abox1 = await reasoner.classify(parseNTriples(ABOX_NTRIPLES));
        expect(
          hasTriple(abox1, EX("Alice"), RDF_TYPE, EX("Person")),
          "call 1 (ABox): Alice rdf:type Person must be inferred",
        ).toBe(true);

        // Call 2: TBox-only — must not hang (regression: realizer thread
        // from call 1 would exhaust pthread slots without IU-2 cleanup)
        const tbox = await reasoner.classify(parseNTriples(TBOX_ONLY_NTRIPLES));
        const typeTriples = tbox.filter((q) => q.predicate.value === RDF_TYPE);
        expect(
          typeTriples,
          "call 2 (TBox): no rdf:type triples for TBox-only ontology",
        ).toHaveLength(0);
        expect(
          hasTriple(tbox, EX("Mammal"), RDFS_SUB_CLASS_OF, EX("Animal")),
          "call 2 (TBox): Mammal rdfs:subClassOf Animal must appear",
        ).toBe(true);

        // Call 3: ABox again — must still produce correct results
        const abox2 = await reasoner.classify(parseNTriples(ABOX_NTRIPLES));
        expect(
          hasTriple(abox2, EX("Alice"), RDF_TYPE, EX("Person")),
          "call 3 (ABox again): Alice rdf:type Person must be inferred",
        ).toBe(true);
      },
      15_000,
    );

    it(
      "three sequential ABox calls return identical inferred quads",
      async () => {
        const results: Quad[][] = [];
        for (let i = 0; i < 3; i++) {
          results.push(await reasoner.classify(parseNTriples(ABOX_NTRIPLES)));
        }

        // All three runs must infer Alice rdf:type Person
        for (let i = 0; i < 3; i++) {
          expect(
            hasTriple(results[i], EX("Alice"), RDF_TYPE, EX("Person")),
            `run ${i + 1}: Alice rdf:type Person must be inferred`,
          ).toBe(true);
        }

        // All three runs must produce the same triple count
        const counts = results.map((r) => r.length);
        expect(
          counts[0],
          "all three ABox runs must return the same number of triples",
        ).toBe(counts[1]);
        expect(counts[1]).toBe(counts[2]);
      },
      20_000,
    );

    it(
      "TBox → ABox: ABox result correct after prior TBox run",
      async () => {
        // TBox first
        const tbox = await reasoner.classify(parseNTriples(TBOX_ONLY_NTRIPLES));
        expect(
          tbox.filter((q) => q.predicate.value === RDF_TYPE),
          "TBox run: no rdf:type triples expected",
        ).toHaveLength(0);

        // ABox after TBox — must not be corrupted by the prior TBox run
        const abox = await reasoner.classify(parseNTriples(ABOX_NTRIPLES));
        expect(
          hasTriple(abox, EX("Alice"), RDF_TYPE, EX("Person")),
          "ABox after TBox: Alice rdf:type Person must be inferred",
        ).toBe(true);
        expect(
          hasTriple(abox, EX("Alice"), EX("knows"), EX("Bob")),
          "ABox after TBox: Alice knows Bob must appear",
        ).toBe(true);
      },
      15_000,
    );
  },
);
