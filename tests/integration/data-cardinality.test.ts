/**
 * Integration test: known gaps in data cardinality over enumerated (finite) data ranges. Konclude's value counting for
 * `owl:oneOf` data ranges is incomplete (PR #18 lists "data cardinality over finite value spaces" as not included):
 *   a: forall dp. {v1, v2}  and  a: minCardinality 2 dp   -- consistent iff v1 and v2 are two distinct values.
 * Fixed by three kernel changes (patch 002): distinct-node value exclusion in checkSatisfiability, non-integer points in
 * CDatatypeRealValueSpaceMap::getNextPossibleDataValue, and data cardinality above 1 sent to the tableau instead of the saturation.
 * W3C New-Feature-Rational-003 is the {0.333.. decimal, 1/3 rational} case. One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const X = "http://www.w3.org/2001/XMLSchema#", O = "http://www.w3.org/2002/07/owl#";
const ontology = (vals: string) =>
  new Store(new Parser().parse(`@prefix : <http://ex.org/> . @prefix owl: <${O}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:dp a owl:DatatypeProperty . :a a [ a owl:Restriction ; owl:onProperty :dp ; owl:allValuesFrom [ a rdfs:Datatype ; owl:oneOf ( ${vals} ) ] ],
  [ a owl:Restriction ; owl:onProperty :dp ; owl:minCardinality "2"^^<${X}nonNegativeInteger> ] .`));
const dec = (v: string) => `"${v}"^^<${X}decimal>`, rat = (v: string) => `"${v}"^^<${O}rational>`, int = (v: string) => `"${v}"^^<${X}integer>`, str = (v: string) => `"${v}"^^<${X}string>`;

// [label, enumeration, correct verdict]
const cases: [string, string, boolean][] = [
  ["{1, 2} integers", `${int("1")} ${int("2")}`, true],
  ["{a, b} strings", `${str("a")} ${str("b")}`, true],
  ["{0.5, 1} decimal and integer", `${dec("0.5")} ${int("1")}`, true],
  ["{0.5 dec, 1/2 rat} the same value", `${dec("0.5")} ${rat("1/2")}`, false],
  ["{1/3 rat, 2/6 rat} the same value", `${rat("1/3")} ${rat("2/6")}`, false],
  ["{0.5, 0.25} two decimals", `${dec("0.5")} ${dec("0.25")}`, true],
  ["{1/3, 2/3} two rationals", `${rat("1/3")} ${rat("2/3")}`, true],
  ["{0.3333333333333333 dec, 1/3 rat} W3C Rational-003", `${dec("0.3333333333333333")} ${rat("1/3")}`, true],
  ["{a} one string, minCardinality 2", `${str("a")}`, false],
  ["{1, 1} equal integers, minCardinality 2", `${int("1")} ${int("1")}`, false],
];

describe.skipIf(!wasmExists)("data cardinality over enumerated data ranges (fixed)", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const [label, vals, correct] of cases) {
    it(`${label}: ${correct ? "consistent" : "inconsistent"}`, async () => {
      expect(await reasoner.checkConsistency(ontology(vals))).toBe(correct);
    }, 60_000);
  }
});
