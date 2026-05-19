/**
 * Integration test: ABox realization on stripped-down Roberts family ontology
 *
 * Loads the full roberts-family TBox (class hierarchy, property chains, nominals)
 * but strips all 405 ABox individuals down to 3, verifying that realization
 * actually works on a complex OWL-DL ontology without the 60s timeout from
 * the full 405-individual dataset.
 *
 * This is a sanity check that the realization mechanism works at all before
 * debugging large-ontology performance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const NS = "http://www.co-ode.org/roberts/family-tree.owl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_NI = "http://www.w3.org/2002/07/owl#NamedIndividual";

/**
 * Keep only TBox triples + direct assertions for a small set of individuals.
 *
 * Strategy: collect all NamedIndividual IRIs, then drop every triple whose
 * *subject* is a removed individual.  Triples where a removed individual
 * appears only as *object* (e.g. owl:hasValue class definitions) are kept
 * because they belong to the TBox.
 */
function stripABox(allQuads: Quad[], keepIndividuals: Set<string>): Quad[] {
  // Build the full individual set from NamedIndividual declarations
  const allIndividuals = new Set<string>();
  for (const q of allQuads) {
    if (
      q.subject.termType === "NamedNode" &&
      q.predicate.value === RDF_TYPE &&
      q.object.value === OWL_NI
    ) {
      allIndividuals.add(q.subject.value);
    }
  }

  return allQuads.filter((q) => {
    if (q.subject.termType !== "NamedNode") return true; // blank nodes → TBox
    const s = q.subject.value;
    if (!allIndividuals.has(s)) return true; // class/property IRI → TBox
    return keepIndividuals.has(s); // individual → keep only if in set
  });
}

// Individuals to keep:
//   john_william_folland — explicitly typed as Person (direct assertion echoed back)
//   robert_david_bright_1965 — focal individual (owl:hasValue in AuntOfRobert def)
//   david_bright_1934 — robert's father (hasFather chain)
const KEEP = new Set([
  NS + "john_william_folland",
  NS + "robert_david_bright_1965",
  NS + "david_bright_1934",
]);

describe.skipIf(!wasmExists)(
  "Roberts minimal realization (3 individuals)",
  () => {
    let reasoner: RdfReasoner;
    let inferred: Quad[];

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;

      const allQuads = loadFixture("roberts-family.nt");
      const filtered = stripABox(allQuads, KEEP);
      inferred = await reasoner.materialize(filtered, { includeClassHierarchy: true });
    }, 30000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("materialize() returns inferred quads without crashing", () => {
      expect(Array.isArray(inferred)).toBe(true);
      expect(inferred.length).toBeGreaterThan(0);
    });

    it("directly asserted rdf:type Person echoed back for john_william_folland", () => {
      const hasType = inferred.some(
        (q) =>
          q.subject.value === NS + "john_william_folland" &&
          q.predicate.value === RDF_TYPE &&
          q.object.value === NS + "Person",
      );
      expect(hasType, "john_william_folland rdf:type Person must appear").toBe(
        true,
      );
    });

    it("robert_david_bright_1965 appears in output (NamedIndividual)", () => {
      const hasRobert = inferred.some(
        (q) =>
          q.subject.value === NS + "robert_david_bright_1965" ||
          q.object.value === NS + "robert_david_bright_1965",
      );
      expect(
        hasRobert,
        "robert_david_bright_1965 must be mentioned in output",
      ).toBe(true);
    });

    it("TBox subsumption inferred (FemaleAncestor ⊑ FemaleDescendent)", () => {
      const hasSub = inferred.some(
        (q) =>
          q.subject.value === NS + "FemaleAncestor" &&
          q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#subClassOf" &&
          q.object.value === NS + "FemaleDescendent",
      );
      expect(hasSub, "FemaleAncestor ⊑ FemaleDescendent must be inferred").toBe(true);
    });
  },
);
