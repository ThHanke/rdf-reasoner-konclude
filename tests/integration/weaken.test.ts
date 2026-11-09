/**
 * Integration test: RdfReasoner.weaken() with the real kernel (contract item 5 of the repair plan: deletion is offered and so
 * is the weakening A subClassOf C with C above B, verified, and the weakened ontology still entails A subClassOf C).
 * Requires dist/konclude.wasm; skipped when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";
import type { Axiom } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PREFIXES = `
@prefix ex: <http://example.org/wk#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/wk> a owl:Ontology .
`;
const EX = "http://example.org/wk#";
const storeOf = (ttl: string) => new Store(new Parser().parse(PREFIXES + ttl));
const snapshot = (s: Store) => s.getQuads(null, null, null, null).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.graph.value}`).sort();
const apply = (s: Store, w: { remove: Quad[]; add: Quad[] }) => {
  const copy = new Store(s.getQuads(null, null, null, null));
  for (const q of w.remove) copy.removeQuad(q);
  for (const q of w.add) copy.addQuad(q);
  return copy;
};
const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

describe.skipIf(!wasmExists)("weaken() integration", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  it(
    "A subClassOf (B and E) with B disjoint E and an instance of A: weakenings are verified, deletion is last, and the weakening still entails A subClassOf C",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:E a owl:Class .
ex:B rdfs:subClassOf ex:C .
ex:B owl:disjointWith ex:E .
ex:A rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( ex:B ex:E ) ] .
ex:a1 a ex:A .
`);
      const before = snapshot(store);
      const rep = await reasoner.repair(store);
      const culprit: Axiom = rep.repairs.flatMap(r => r.remove).find(a => a.principal.predicate.value === SUBCLASS && a.principal.object.termType === "BlankNode")!;
      expect(culprit).toBeDefined();

      const r = await reasoner.weaken(store, culprit);
      expect(r.incomplete).toBe(false);
      expect(r.weakenings.at(-1)!.strategy).toBe("delete");
      const changes = r.weakenings.filter(w => w.change).map(w => `${w.strategy}:${w.change!.from.replace(EX, "")}>${w.change!.to?.replace(EX, "") ?? "-"}`).sort();
      expect(changes).toContain("generalize:B>C");
      expect(changes).toContain("dropConjunct:B>-");
      expect(changes).toContain("dropConjunct:E>-");
      for (const w of r.weakenings) expect(await reasoner.checkConsistency(apply(store, w))).toBe(true); // every one is a real repair

      const toC = r.weakenings.find(w => w.change?.from === `${EX}B` && w.change.to === `${EX}C`)!;
      const axiomAtoC = DataFactory.quad(DataFactory.namedNode(`${EX}A`), DataFactory.namedNode(SUBCLASS), DataFactory.namedNode(`${EX}C`));
      expect(await reasoner.isEntailed(apply(store, toC), axiomAtoC)).toBe(true);
      expect(await reasoner.isEntailed(apply(store, r.weakenings.at(-1)!), axiomAtoC)).toBe(false); // deletion does not entail it
      expect(snapshot(store)).toEqual(before); // read-only
    },
    360000,
  );

  it(
    "a class without instances: only replacements that keep the target class satisfiable are offered",
    async () => {
      // A subClassOf B, A subClassOf D, B disjoint D: A is unsatisfiable but the ontology is consistent without instances
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:D a owl:Class . ex:G a owl:Class .
ex:B rdfs:subClassOf ex:C . ex:C rdfs:subClassOf ex:G .
ex:B owl:disjointWith ex:D . ex:C owl:disjointWith ex:D .
ex:A rdfs:subClassOf ex:B . ex:A rdfs:subClassOf ex:D .
ex:a1 a ex:A .
`);
      const culpritQuad = store.getQuads(DataFactory.namedNode(`${EX}A`), DataFactory.namedNode(SUBCLASS), DataFactory.namedNode(`${EX}B`), null)[0];
      const culprit: Axiom = { principal: culpritQuad, quads: [culpritQuad] };
      const r = await reasoner.weaken(store, culprit);
      const generalizations = r.weakenings.filter(w => w.strategy === "generalize").map(w => w.change!.to!.replace(EX, ""));
      expect(generalizations).toEqual(["G"]); // C is disjoint from D, G is not
      expect(await reasoner.checkConsistency(apply(store, r.weakenings[0]))).toBe(true);
    },
    360000,
  );

  it(
    "reports why nothing is offered and rejects bad input",
    async () => {
      const store = storeOf(`ex:A a owl:Class . ex:B a owl:Class . ex:A rdfs:subClassOf ex:B .`);
      const ghost = DataFactory.quad(DataFactory.namedNode(`${EX}X`), DataFactory.namedNode(SUBCLASS), DataFactory.namedNode(`${EX}Y`));
      expect(await reasoner.weaken(store, { principal: ghost, quads: [ghost] })).toMatchObject({ weakenings: [], reason: "culprit-not-in-store" });
      const eq = DataFactory.quad(DataFactory.namedNode(`${EX}A`), DataFactory.namedNode("http://www.w3.org/2002/07/owl#equivalentClass"), DataFactory.namedNode(`${EX}B`));
      expect(await reasoner.weaken(store, { principal: eq, quads: [eq] })).toMatchObject({ weakenings: [], reason: "unsupported-axiom" });
      await expect(reasoner.weaken({} as unknown as Store, { principal: eq, quads: [eq] })).rejects.toBeInstanceOf(TypeError);
      await expect(reasoner.weaken(store, {} as unknown as Axiom)).rejects.toBeInstanceOf(TypeError);
    },
    360000,
  );
});
