/**
 * Integration test: datatype value-space fixes (kernel patch 002).
 *  - Empty float/double facet intervals are inconsistent: CDatatypeCompareValueSpaceMap::getNextPossibleDataValue had an
 *    inverted test at the last map point and reported a value above the maximum. A one-value interval stays consistent.
 *  - A negated literal inside an OR branch is applied: excludeValue compared the wrong direction against the maximum
 *    (+infinity initially), so the exclusion was dropped (W3C Minus_Infinity_is_not_in_owl_real shape).
 * Fixtures: tests/fixtures/pr18/ (float-/double-/dsvs-*). One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const load = (f: string) => new Store(new Parser({ format: "N-Triples" }).parse(readFileSync(new URL(`../fixtures/pr18/${f}`, import.meta.url), "utf8")));

const cases: [string, string, boolean][] = [
  ["float-empty-interval.nt", "float interval (1.0, nextafter(1.0)) is empty", false],
  ["double-empty-interval.nt", "double interval (1.0, nextafter(1.0)) is empty", false],
  ["float-one-value-interval.nt", "float interval (1.0, nextafter(nextafter(1.0))) holds one value", true],
  ["dsvs-a1.nt", "{0 integer, 1.5 float}, negated 0 unsignedInt, forall real", false],
  ["dsvs-a3.nt", "{0 integer, 0 unsignedInt}, negated 0 integer", false],
  ["dsvs-a5.nt", "{0, 1}, negated 0: 1 is still allowed", true],
];

describe.skipIf(!wasmExists)("datatype value spaces", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const [file, label, consistent] of cases) {
    it(`${label}: ${consistent ? "consistent" : "inconsistent"}`, async () => {
      expect(await reasoner.checkConsistency(load(file))).toBe(consistent);
    }, 60_000);
  }
});
