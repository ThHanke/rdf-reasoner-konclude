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

const NS = "http://www.lehigh.edu/~zhp2/2004/0401/univ-bench.owl#";
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

describe.skipIf(!wasmExists)("LUBM university benchmark ontology integration", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const inputQuads = loadFixture("lubm.nt");
    inferred = await reasoner.classify(inputQuads);
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("classify() succeeds and returns inferred quads", () => {
    expect(Array.isArray(inferred)).toBe(true);
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("all returned quads are in the DefaultGraph", () => {
    for (const q of inferred) {
      expect(q.graph.termType).toBe("DefaultGraph");
    }
  });

  // Direct asserted subsumptions that the reasoner must reproduce.
  // All of these are explicit rdfs:subClassOf axioms in the LUBM ontology,
  // so they must appear in any sound reasoner's output.

  it("AssistantProfessor ⊑ Professor (asserted)", () => {
    expect(
      hasSubsumption(
        inferred,
        `${NS}AssistantProfessor`,
        `${NS}Professor`,
      ),
    ).toBe(true);
  });

  it("AssociateProfessor ⊑ Professor (asserted)", () => {
    expect(
      hasSubsumption(
        inferred,
        `${NS}AssociateProfessor`,
        `${NS}Professor`,
      ),
    ).toBe(true);
  });

  it("Chair ⊑ Professor (asserted)", () => {
    expect(
      hasSubsumption(inferred, `${NS}Chair`, `${NS}Professor`),
    ).toBe(true);
  });

  it("Dean ⊑ Professor (asserted)", () => {
    expect(
      hasSubsumption(inferred, `${NS}Dean`, `${NS}Professor`),
    ).toBe(true);
  });

  it("ConferencePaper ⊑ Publication (transitive: ConferencePaper ⊑ Article ⊑ Publication)", () => {
    // ConferencePaper subClassOf Article (asserted)
    // Article subClassOf Publication (asserted)
    // ConferencePaper subClassOf Publication is a transitive inference.
    expect(
      hasSubsumption(
        inferred,
        `${NS}ConferencePaper`,
        `${NS}Publication`,
      ),
    ).toBe(true);
  });

  it("at least 5 known LUBM subsumption pairs present in output", () => {
    const knownPairs: [string, string][] = [
      ["AssistantProfessor", "Professor"],
      ["AssociateProfessor", "Professor"],
      ["Chair", "Professor"],
      ["Dean", "Professor"],
      ["ConferencePaper", "Article"],
      ["Article", "Publication"],
      ["Book", "Publication"],
      ["ClericalStaff", "AdministrativeStaff"],
      ["Professor", "Faculty"],
      ["Faculty", "Employee"],
    ];

    const foundCount = knownPairs.filter(([sub, sup]) =>
      hasSubsumption(inferred, `${NS}${sub}`, `${NS}${sup}`),
    ).length;

    expect(foundCount).toBeGreaterThanOrEqual(5);
  });
});
