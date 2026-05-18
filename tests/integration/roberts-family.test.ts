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
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NS = "http://www.co-ode.org/roberts/family-tree.owl#";
const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSubsumption(
  quads: Quad[],
  subClass: string,
  superClass: string,
): boolean {
  return quads.some(
    (q) =>
      q.predicate.value === SUBCLASS_OF &&
      q.subject.value === subClass &&
      q.object.value === superClass,
  );
}

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("Roberts family ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];
  let inputQuads: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    inputQuads = loadFixture("roberts-family.nt");
    inferred = await reasoner.classify(inputQuads);
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds and returns inferred quads", () => {
    expect(Array.isArray(inferred)).toBe(true);
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("inferred quad count is substantial (rich ontology produces many triples)", () => {
    // The Roberts family ontology has dozens of named classes with complex
    // OWL-DL restrictions; the reasoner must produce many inferred subsumptions.
    expect(inferred.length).toBeGreaterThanOrEqual(20);
  });

  it("all returned quads are in the DefaultGraph", () => {
    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });

  it("AuntOfRobert ⊑ Aunt (nominal specialisation: hasValue ⊑ someValuesFrom)", () => {
    // AuntOfRobert ≡ Person ∩ ∃sisterOf.(Person ∩ ∃isParentOf.{robert_david_bright_1965})
    // Aunt        ≡ Person ∩ ∃sisterOf.(Person ∩ ∃isParentOf.Person)
    // Since the named individual is a Person, ∃isParentOf.{robert} ⊑ ∃isParentOf.Person,
    // so AuntOfRobert ⊑ Aunt follows by OWL-DL tableau reasoning.
    expect(
      hasSubsumption(inferred, `${NS}AuntOfRobert`, `${NS}Aunt`),
    ).toBe(true);
  });

  it("FemaleAncestor ⊑ Woman (intersection member subsumption)", () => {
    // FemaleAncestor ≡ Woman ∩ ∃isAncestorOf.Person
    // Every member of an equivalentClass intersection is a superclass.
    expect(
      hasSubsumption(inferred, `${NS}FemaleAncestor`, `${NS}Woman`),
    ).toBe(true);
  });

  // ── Phase 2: TBox classification correctness ─────────────────────────────

  it("FemaleAncestor ⊑ Ancestor (intersection member subsumption)", () => {
    expect(
      hasSubsumption(inferred, `${NS}FemaleAncestor`, `${NS}Ancestor`),
    ).toBe(true);
  });

  it("GreatAuntOfRobert ⊑ Woman (nominal + sisterOf chain)", () => {
    expect(
      hasSubsumption(inferred, `${NS}GreatAuntOfRobert`, `${NS}Woman`),
    ).toBe(true);
  });

  it("FirstCousinOfRobert ⊑ FirstCousin (nominal specialisation)", () => {
    expect(
      hasSubsumption(inferred, `${NS}FirstCousinOfRobert`, `${NS}FirstCousin`),
    ).toBe(true);
  });

  it("output contains ≥ 70 rdfs:subClassOf triples (TBox regression guard)", () => {
    const subClassOfCount = inferred.filter(
      (q) => q.predicate.value === SUBCLASS_OF,
    ).length;
    expect(subClassOfCount).toBeGreaterThanOrEqual(70);
  });

  // ── Phase 3: ABox realization ─────────────────────────────────────────────

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

  it("john_william_folland rdf:type Person appears in output (direct type echoed back)", () => {
    expect(
      inferred.some(
        (q) =>
          q.subject.value === `${NS}john_william_folland` &&
          q.predicate.value === RDF_TYPE &&
          q.object.value === `${NS}Person`,
      ),
    ).toBe(true);
  });

  it("at least one hasMother role assertion present (role realization ran)", () => {
    const hasMother = `${NS}hasMother`;
    expect(
      inferred.some((q) => q.predicate.value === hasMother),
    ).toBe(true);
  });

  it("ABox realization ran: inferred contains rdf:type triples", () => {
    expect(
      inferred.some((q) => q.predicate.value === RDF_TYPE),
    ).toBe(true);
  });

  it("sequential call stability: second classify() on same reasoner succeeds", async () => {
    // Call classify() again on the same reasoner with a different (small) ontology.
    // Tests that STPU + realizer threads reset correctly between calls.
    const lubmQuads = loadFixture("lubm.nt");
    const inferred2 = await reasoner.classify(lubmQuads);
    expect(Array.isArray(inferred2)).toBe(true);
    expect(inferred2.length).toBeGreaterThan(0);
  }, 30000);
});
