/**
 * Integration test: materialize() derives the facts a SHACL check on the Fe-Si record depends on.
 *
 * Case: `tests/fixtures/fesi-hermit-case.trig`. After reasoning, exactly one SHACL violation is correct (some_silicon has
 * no quality). Two things must be in the materialized output for that:
 *   - the inferred type `some_silicon rdf:type PMD_0090000` (semiconductor), and
 *   - the inverse links: the data asserts `mass_proportion_X PMD_0000077 fraction_X`; PMDco declares
 *     `OBI_0001927 owl:inverseOf PMD_0000077`, so `fraction_X OBI_0001927 mass_proportion_X` must be derived.
 * An export path that keeps only class inferences (as a ROBOT/HermiT file export does) drops the second kind and leaves
 * two false violations.
 *
 * The inferred and shapes graphs of the stored case are excluded so the output is a fresh derivation.
 * Requires the built WASM binary; skipped when it is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store, DataFactory } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(
  new URL("../../dist/konclude.wasm", import.meta.url).pathname,
);

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const EX = "http://www.example.org/#";
const PMD = "https://w3id.org/pmd/co/PMD_";
const OBO = "http://purl.obolibrary.org/obo/";
const OUT = "urn:test:fresh-inferred";

describe.skipIf(!wasmExists)(
  "Fe-Si case: inferred type and inverse links",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      store = new Store(
        new Parser({ format: "application/trig" }).parse(
          readFileSync(
            new URL("../fixtures/fesi-hermit-case.trig", import.meta.url)
              .pathname,
            "utf8",
          ),
        ),
      );
      reasoner = new RdfReasoner({
        excludeGraphs: ["urn:vg:inferred", "urn:vg:shapes"],
      });
      await reasoner.materialize(store, { inferredGraph: OUT });
    }, 120_000);

    afterAll(() => {
      reasoner?.terminate();
    });

    const inferred = (s: string, p: string, o: string): boolean =>
      store.getQuads(
        DataFactory.namedNode(s),
        DataFactory.namedNode(p),
        DataFactory.namedNode(o),
        DataFactory.namedNode(OUT),
      ).length > 0;

    it("derives some_silicon rdf:type semiconductor", () => {
      expect(inferred(EX + "some_silicon", RDF_TYPE, PMD + "0090000")).toBe(
        true,
      );
    });

    it.each(["iron", "silicon"])(
      "derives the inverse link fraction_%s OBI_0001927 mass_proportion_%s",
      (e) => {
        // asserted: mass_proportion_e PMD_0000077 fraction_e (specified by value); inverse property OBI_0001927
        expect(
          inferred(
            EX + `fraction_${e}`,
            OBO + "OBI_0001927",
            EX + `mass_proportion_${e}`,
          ),
        ).toBe(true);
      },
    );
  },
);
