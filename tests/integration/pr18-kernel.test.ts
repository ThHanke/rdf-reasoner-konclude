/**
 * Integration test: kernel behaviour fixed by PR #18 (patches folded into 002/004).
 *
 *   1. Datatype clashes between value spaces (xsd:integer vs xsd:string) are detected.
 *   2. A negated derived datatype (not xsd:positiveInteger) does not close the whole integer value space.
 *   3. A blank-node class expression shared by several individuals does not corrupt the heap
 *      (buildComplexABoxAxioms used to free its list inside the loop over it); one reasoner, many loads.
 *   4. materialize() throws for a named/anonymous individual in an unsatisfiable class that the
 *      consistency step alone does not flag (W3C WebOnt-description-logic-008 and -012).
 *
 * Fixtures: tests/fixtures/pr18/ (small ontologies from the coworker's reviewer kit,
 * docs/experiments/pr18-reviewer-kit; W3C cases converted from RDF/XML to N-Triples).
 * One shared reasoner for the whole file (several Workers exhaust the pthread pool).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner, InconsistentOntologyError } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const dir = new URL("../fixtures/pr18/", import.meta.url);
const load = (name: string): Store => {
  const text = readFileSync(new URL(name, dir), "utf8");
  return new Store(new Parser({ format: name.endsWith(".nt") ? "N-Triples" : "text/turtle" }).parse(text));
};

describe.skipIf(!wasmExists)("PR #18 kernel fixes", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  describe("datatype value spaces", () => {
    const cases: [string, boolean][] = [
      ["a1-string-where-integer-required.ttl", false],
      ["a2-string-vs-integer-restriction.ttl", false],
      ["a3-control-integer-value.ttl", true],
      ["b1-not-positiveInteger-accepts-minus-one.ttl", true],
      ["b2-not-positiveInteger-rejects-five.ttl", false],
      ["b3-not-string-rejects-string.ttl", false],
    ];
    for (const [file, consistent] of cases) {
      it(`${file} is ${consistent ? "consistent" : "inconsistent"}`, async () => {
        expect(await reasoner.checkConsistency(load(file))).toBe(consistent);
      }, 60_000);
    }
  });

  describe("shared blank-node class expression (use after free)", () => {
    it("alternating loads of two ontologies in one reasoner do not trap", async () => {
      for (let i = 0; i < 40; i++) {
        expect(await reasoner.checkConsistency(load("c1-shared-blank-node-class-expression.ttl"))).toBe(true);
        expect(await reasoner.checkConsistency(load("c2-second-ontology.ttl"))).toBe(true);
      }
    }, 120_000);

    it("W3C Restriction-002 (inconsistent) then -003 (consistent): the pair that trapped deterministically before the fix", async () => {
      expect(await reasoner.checkConsistency(load("WebOnt-Restriction-002.nt"))).toBe(false);
      expect(await reasoner.checkConsistency(load("WebOnt-Restriction-003.nt"))).toBe(true);
    }, 60_000);
  });

  describe("individual in an unsatisfiable class", () => {
    // The consistency step used to miss these (the saturation approximation judged the individual sufficient); two kernel fixes
    // in patch 002 (critical cardinality looked up under the super role; a representative successor at the limit) make
    // checkConsistency itself answer correctly. materialize() keeps its unsatisfiable-class check as a stopgap.
    for (const id of ["WebOnt-description-logic-008", "WebOnt-description-logic-012"]) {
      it(`${id}: checkConsistency reports the inconsistency, materialize with failOnInconsistent rejects`, async () => {
        const store = load(`${id}.nt`);
        expect(await reasoner.checkConsistency(store)).toBe(false);
        await expect(reasoner.materialize(store, { failOnInconsistent: true })).rejects.toBeInstanceOf(InconsistentOntologyError);
      }, 90_000);
    }
  });
});
