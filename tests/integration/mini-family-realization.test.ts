/**
 * Integration test: mini-family ontology role realization
 *
 * Uses a hand-crafted 12-individual SROIQ ontology with the same property
 * hierarchy features as Roberts (symmetric + transitive top property,
 * property chains, inverses, functional properties) but small enough to
 * manually verify all expected role assertions.
 *
 * Golden fixtures captured from a verified-deterministic run:
 *   - mini-family-golden-tbox.nt  (3 TBox triples)
 *   - mini-family-golden-abox.nt  (24 type assertions)
 *   - mini-family-golden-roles.nt (534 role assertions)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";
import { assertExactMatch } from "../helpers/compare-native.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const NS = "http://example.org/family#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

describe.skipIf(!wasmExists)("Mini-family role realization (12 individuals)", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const store = new Store(loadFixture("mini-family.nt"));
    await reasoner.materialize(store, { includeClassHierarchy: true });
    inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
  }, 30000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("materialize() returns inferred quads", () => {
    expect(inferred.length).toBeGreaterThan(0);
  });

  it("TBox matches golden fixture", () => {
    assertExactMatch(inferred, "mini-family-golden-tbox.nt", [SUBCLASS_OF]);
  });

  it("ABox type assertions match golden fixture", () => {
    assertExactMatch(inferred, "mini-family-golden-abox.nt", [RDF_TYPE]);
  });

  it("role assertions match golden fixture (534 expected)", () => {
    const rolePredicates = [
      NS + "isRelationOf",
      NS + "isBloodRelationOf",
      NS + "isInLawOf",
      NS + "isSpouseOf",
      NS + "hasParent",
      NS + "isParentOf",
      NS + "hasFather",
      NS + "isFatherOf",
      NS + "hasMother",
      NS + "isMotherOf",
      NS + "hasChild",
      NS + "isChildOf",
      NS + "hasAncestor",
      NS + "isAncestorOf",
      NS + "hasForeFather",
      NS + "isForefatherOf",
      NS + "hasForeMother",
      NS + "isForemotherOf",
      NS + "isSiblingOf",
      NS + "directSiblingOf",
      NS + "brotherOf",
      NS + "hasBrother",
      NS + "sisterOf",
      NS + "hasSister",
      NS + "hasWife",
      NS + "isWifeOf",
      NS + "hasHusband",
      NS + "isHusbandOf",
      NS + "isFirstCousinOf",
      NS + "isParentInLawOf",
    ];
    assertExactMatch(inferred, "mini-family-golden-roles.nt", rolePredicates);
  });

  it("isFirstCousinOf chain inferred correctly (12 directed pairs)", () => {
    const cousins = inferred.filter(
      (q) => q.predicate.value === NS + "isFirstCousinOf",
    );
    expect(cousins.length).toBe(12);

    const bobKids = new Set([NS + "eve", NS + "frank", NS + "ivy"]);
    const tomKids = new Set([NS + "gina", NS + "hank"]);
    for (const q of cousins) {
      const s = q.subject.value;
      const o = q.object.value;
      const valid =
        (bobKids.has(s) && tomKids.has(o)) ||
        (tomKids.has(s) && bobKids.has(o));
      expect(valid, `unexpected cousin pair: ${s} - ${o}`).toBe(true);
    }
  });

  it("isParentInLawOf chain inferred correctly (4 pairs)", () => {
    const pil = inferred.filter(
      (q) => q.predicate.value === NS + "isParentInLawOf",
    );
    expect(pil.length).toBe(4);
    const expected = new Set([
      `${NS}john|${NS}alice`,
      `${NS}john|${NS}jane`,
      `${NS}mary|${NS}alice`,
      `${NS}mary|${NS}jane`,
    ]);
    for (const q of pil) {
      expect(
        expected.has(`${q.subject.value}|${q.object.value}`),
        `unexpected parent-in-law: ${q.subject.value} → ${q.object.value}`,
      ).toBe(true);
    }
  });

  it("role count is stable across sequential calls (deterministic)", async () => {
    const reasoner2 = new RdfReasoner();
    await reasoner2.ready;
    try {
      const store2 = new Store(loadFixture("mini-family.nt"));
      await reasoner2.materialize(store2, { includeClassHierarchy: true });
      const inferred2 = store2.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
      const roleCount1 = inferred.filter(
        (q) =>
          q.predicate.value !== RDF_TYPE &&
          q.predicate.value !== SUBCLASS_OF &&
          q.predicate.value !== "http://www.w3.org/2002/07/owl#equivalentClass",
      ).length;
      const roleCount2 = inferred2.filter(
        (q) =>
          q.predicate.value !== RDF_TYPE &&
          q.predicate.value !== SUBCLASS_OF &&
          q.predicate.value !== "http://www.w3.org/2002/07/owl#equivalentClass",
      ).length;
      expect(roleCount2).toBe(roleCount1);
    } finally {
      reasoner2.terminate();
    }
  }, 30000);
});
