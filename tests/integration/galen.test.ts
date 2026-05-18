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
import { assertMatchExcluding } from "../helpers/compare-native.js";

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
// Known divergences between WASM and native Konclude for GALEN
//
// WASM and native pick different IRI representatives for 14 equivalence-class
// nodes. Both representatives are semantically equivalent (same CHierarchyNode);
// the divergence is an artifact of concept-tag ordering (WASM uses
// first-encountered concept; native uses primary concept name).
//
// Each entry appears once as a native-only triple and once as a WASM-only
// triple (28 strings total). Excluded from set-equality until the
// representative-IRI selection is aligned with native (Unit 4 of plan-016).
//
// TODO(plan-016 Unit 4): fix representative IRI selection and remove this list.
// ---------------------------------------------------------------------------

const GALEN_KNOWN_DIVERGENCES: string[] = [
  // native-only (native picks these IRIs as representatives)
  `<http://ex.test/galen#AtrophicGastritisProcess> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#AtrophyProcess> .`,
  `<http://ex.test/galen#AtrophicGastritisProcess> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#Gastritis> .`,
  `<http://ex.test/galen#BrachiocephalVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#MirrorImagedBodyStructure> .`,
  `<http://ex.test/galen#BrachiocephalVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#ConductionFibres> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#Myocardium> .`,
  `<http://ex.test/galen#GastricMucosalAtrophy> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#AtrophyOfMucosa> .`,
  `<http://ex.test/galen#GastricMucosalHypertrophy> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#HypertrophyOfMucosa> .`,
  `<http://ex.test/galen#GreatSaphenousVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#Haem> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#ComplexChemicals> .`,
  `<http://ex.test/galen#Myocardium> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#Muscle> .`,
  `<http://ex.test/galen#ShortSaphenousVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#VitaminB12> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
  `<http://ex.test/galen#VitaminB1> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
  `<http://ex.test/galen#VitaminB6> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
  // WASM-only (WASM picks these IRIs as representatives instead)
  `<http://ex.test/galen#Atrophyic_HyperplasticGastritisGastritisProcess> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#AtrophyProcess> .`,
  `<http://ex.test/galen#Atrophyic_HyperplasticGastritisGastritisProcess> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#Gastritis> .`,
  `<http://ex.test/galen#AtrophyOfGastricMucosa> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#AtrophyOfMucosa> .`,
  `<http://ex.test/galen#BrachiocephalicVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#MirrorImagedBodyStructure> .`,
  `<http://ex.test/galen#BrachiocephalicVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#CardiacMuscle> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#Muscle> .`,
  `<http://ex.test/galen#Cobalamin> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
  `<http://ex.test/galen#ConductionFibres> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#CardiacMuscle> .`,
  `<http://ex.test/galen#GreaterSaphenousVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#Heme> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#ComplexChemicals> .`,
  `<http://ex.test/galen#HypertrophyOfGastricMucosa> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#HypertrophyOfMucosa> .`,
  `<http://ex.test/galen#LesserSaphenousVein> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVein> .`,
  `<http://ex.test/galen#Pyridoxine> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
  `<http://ex.test/galen#Thiamin> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.test/galen#NAMEDVitamin> .`,
];

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

  it("TBox matches native Konclude output excluding known representative-IRI divergences (set equality)", () => {
    assertMatchExcluding(inferred, "galen-native-tbox.nt", [SUBCLASS_OF, EQUIVALENT_CLASS], GALEN_KNOWN_DIVERGENCES);
  });
});
