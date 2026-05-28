/**
 * Integration test: OWL-DL violation detection (ontosphere issue #13)
 *
 * Asserts WASM checkConsistency() verdict against native Konclude ground truth
 * recorded in tests/fixtures/issue13-native-verdicts.json.
 *
 * Gap classification (from native run on 2026-05-28):
 *   cases 1-2: PARITY      — both native and WASM detect inconsistency
 *   cases 3-4: UPSTREAM_LIMITATION — native also reports consistent (wrong);
 *              WASM agrees with native; test passes but both miss the violation
 *   case 5:   PARITY         — fixed by setting mConfExtractSimpleABoxAssertions=true in
 *              loadTripleBuffer() so buildSimpleABoxAxioms() registers DifferentIndividuals
 *              axioms (plan: docs/plans/2026-05-28-026-fix-differentfrom-abox-mapping-plan.md)
 *   case 6:   PARITY         — fixed by consistencyOnly pipeline (allValuesFrom detected)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// WASM + golden fixture guards
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const nativeVerdictsPath = new URL(
  "../../tests/fixtures/issue13-native-verdicts.json",
  import.meta.url
).pathname;

if (!existsSync(nativeVerdictsPath)) {
  throw new Error(
    `Missing native verdicts fixture: ${nativeVerdictsPath}\n` +
      "Run: bash scripts/run-native-issue13.sh > tests/fixtures/issue13-native-verdicts.json"
  );
}

interface NativeVerdict {
  case: number;
  name: string;
  fixture: string;
  verdict: "inconsistent" | "consistent" | "timeout" | "error";
  exitCode: number;
}

const nativeVerdicts: NativeVerdict[] = JSON.parse(
  readFileSync(nativeVerdictsPath, "utf8")
);

function nativeVerdict(caseNum: number): NativeVerdict {
  const v = nativeVerdicts.find((e) => e.case === caseNum);
  if (!v) throw new Error(`Native verdict for case ${caseNum} not found`);
  return v;
}

// ---------------------------------------------------------------------------
// Turtle parser
// ---------------------------------------------------------------------------

function parseTurtle(turtle: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  const quads: Quad[] = [];
  parser.parse(turtle, (err, quad) => {
    if (err) throw err;
    if (quad) quads.push(quad as Quad);
  });
  return quads;
}

// ---------------------------------------------------------------------------
// Inline Turtle ontologies for all six issue #13 cases
// ---------------------------------------------------------------------------

const ONTOLOGIES = {
  1: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    :Person a owl:Class .
    :Organization a owl:Class ; owl:disjointWith :Person .
    :alice a owl:NamedIndividual , :Person , :Organization .
  `,

  2: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    :Machine a owl:Class .
    :Component a owl:Class ; owl:disjointWith :Machine .
    :hasPart a owl:ObjectProperty ;
      rdfs:domain :Machine ;
      rdfs:range :Component .
    :widget a owl:NamedIndividual ; :hasPart :widget .
  `,

  3: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    :parentOf a owl:ObjectProperty , owl:AsymmetricProperty .
    :alice a owl:NamedIndividual ; :parentOf :bob .
    :bob   a owl:NamedIndividual ; :parentOf :alice .
  `,

  4: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    :properPartOf a owl:ObjectProperty , owl:IrreflexiveProperty .
    :part1 a owl:NamedIndividual ; :properPartOf :part1 .
  `,

  5: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
    :Vehicle a owl:Class .
    :VIN     a owl:Class .
    :hasVIN  a owl:ObjectProperty .
    :Vehicle rdfs:subClassOf [
      a owl:Restriction ;
      owl:onProperty :hasVIN ;
      owl:onClass :VIN ;
      owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger
    ] .
    :car1 a owl:NamedIndividual , :Vehicle ; :hasVIN :vinA , :vinB .
    :vinA a owl:NamedIndividual , :VIN .
    :vinB a owl:NamedIndividual , :VIN .
    :vinA owl:differentFrom :vinB .
  `,

  6: `
    @prefix :    <http://example.org/reasoner-test#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    :CleanRoom a owl:Class .
    :DirtyRoom a owl:Class ; owl:disjointWith :CleanRoom .
    :locatedIn a owl:ObjectProperty .
    :CleanRoomOnlyDevice a owl:Class ;
      rdfs:subClassOf [
        a owl:Restriction ;
        owl:onProperty :locatedIn ;
        owl:allValuesFrom :CleanRoom
      ] .
    :device1 a owl:NamedIndividual , :CleanRoomOnlyDevice ; :locatedIn :room9 .
    :room9   a owl:NamedIndividual , :DirtyRoom .
  `,
} as const;

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)(
  "OWL-DL violation detection (issue #13) vs native ground truth",
  () => {
    let reasoner: RdfReasoner;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
    });

    afterAll(() => {
      reasoner?.terminate();
    });

    // Case 1 — disjointWith (direct): PARITY
    it(
      "case 1: disjointWith (direct) — WASM detects inconsistency matching native",
      async () => {
        const native = nativeVerdict(1);
        const quads = parseTurtle(ONTOLOGIES[1]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );

    // Case 2 — disjointWith (via inference): PARITY
    it(
      "case 2: disjointWith (via inference) — WASM detects inconsistency matching native",
      async () => {
        const native = nativeVerdict(2);
        const quads = parseTurtle(ONTOLOGIES[2]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );

    // Case 3 — AsymmetricProperty: UPSTREAM_LIMITATION
    // Native Konclude also reports consistent (violation not detected).
    // WASM agrees with native — test passes but both miss the violation.
    it(
      "case 3: AsymmetricProperty — UPSTREAM_LIMITATION: native consistent; WASM agrees",
      async () => {
        const native = nativeVerdict(3);
        const quads = parseTurtle(ONTOLOGIES[3]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );

    // Case 4 — IrreflexiveProperty: UPSTREAM_LIMITATION
    // Native Konclude also reports consistent (violation not detected).
    it(
      "case 4: IrreflexiveProperty — UPSTREAM_LIMITATION: native consistent; WASM agrees",
      async () => {
        const native = nativeVerdict(4);
        const quads = parseTurtle(ONTOLOGIES[4]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );

    // Case 5 — maxQualifiedCardinality + differentFrom: PARITY
    // Fixed: setting mConfExtractSimpleABoxAssertions=true enables buildSimpleABoxAxioms()
    // which registers DifferentIndividuals axioms so the cardinality clash is detectable.
    it(
      "case 5: maxQualifiedCardinality + differentFrom — WASM detects inconsistency matching native",
      async () => {
        const native = nativeVerdict(5);
        const quads = parseTurtle(ONTOLOGIES[5]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );

    // Case 6 — allValuesFrom + disjointWith: PARITY (fixed by consistencyOnly)
    it(
      "case 6: allValuesFrom + disjointWith — WASM detects inconsistency matching native",
      async () => {
        const native = nativeVerdict(6);
        const quads = parseTurtle(ONTOLOGIES[6]);
        const consistent = await reasoner.checkConsistency(quads);
        expect(consistent, `WASM disagrees with native verdict "${native.verdict}"`).toBe(
          native.verdict === "consistent"
        );
      },
      30000
    );
  }
);
