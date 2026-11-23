/**
 * Integration test: known gaps in data cardinality over enumerated (finite) data ranges. Konclude's value counting for
 * `owl:oneOf` data ranges is incomplete (PR #18 lists "data cardinality over finite value spaces" as not included):
 *   a: forall dp. {v1, v2}  and  a: minCardinality 2 dp   -- consistent iff v1 and v2 are two distinct values.
 * Works: integer and string enumerations. Wrong: two distinct non-integer values (decimal/rational) give "inconsistent",
 * and a single value (or two equal values) with minCardinality 2 gives "consistent". W3C New-Feature-Rational-003 is the
 * first kind. The test pins the current verdicts; fixing the kernel flips them. One shared reasoner for the file.
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

// [label, enumeration, correct verdict, verdict the kernel gives today]
const cases: [string, string, boolean, boolean][] = [
  ["{1, 2} integers", `${int("1")} ${int("2")}`, true, true],
  ["{a, b} strings", `${str("a")} ${str("b")}`, true, true],
  ["{0.5, 1} decimal and integer", `${dec("0.5")} ${int("1")}`, true, true],
  ["{0.5 dec, 1/2 rat} the same value", `${dec("0.5")} ${rat("1/2")}`, false, false],
  ["{1/3 rat, 2/6 rat} the same value", `${rat("1/3")} ${rat("2/6")}`, false, false],
  ["{0.5, 0.25} two decimals (GAP: wrongly inconsistent)", `${dec("0.5")} ${dec("0.25")}`, true, false],
  ["{1/3, 2/3} two rationals (GAP: wrongly inconsistent)", `${rat("1/3")} ${rat("2/3")}`, true, false],
  ["{0.3333333333333333 dec, 1/3 rat} W3C Rational-003 (GAP: wrongly inconsistent)", `${dec("0.3333333333333333")} ${rat("1/3")}`, true, false],
  ["{a} one string, minCardinality 2 (GAP: wrongly consistent)", `${str("a")}`, false, true],
  ["{1, 1} equal integers, minCardinality 2 (GAP: wrongly consistent)", `${int("1")} ${int("1")}`, false, true],
];

describe.skipIf(!wasmExists)("data cardinality over enumerated data ranges", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const [label, vals, correct, today] of cases) {
    it(`${label}: ${correct === today ? `${correct ? "consistent" : "inconsistent"} (correct)` : `kernel says ${today ? "consistent" : "inconsistent"}, correct is ${correct ? "consistent" : "inconsistent"}`}`, async () => {
      expect(await reasoner.checkConsistency(ontology(vals))).toBe(today);
    }, 60_000);
  }
});
