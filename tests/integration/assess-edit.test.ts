/**
 * Integration test: RdfReasoner.assessEdit() with the real kernel (the repair-cost half of the repair plan).
 * Requires dist/konclude.wasm; skipped when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PREFIXES = `
@prefix ex: <http://example.org/ae#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/ae> a owl:Ontology .
`;
const EX = "http://example.org/ae#";
const storeOf = (ttl: string) => new Store(new Parser().parse(PREFIXES + ttl));
const snapshot = (s: Store) => s.getQuads(null, null, null, null).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.graph.value}`).sort();
const pair = (a: string, b: string) => ({ a: `${EX}${a}`, b: `${EX}${b}` });
const find = (s: Store, subj: string, pred: string, obj: string) => s.getQuads(DataFactory.namedNode(subj.startsWith("http") ? subj : EX + subj), DataFactory.namedNode(pred), DataFactory.namedNode(obj.startsWith("http") ? obj : EX + obj), null);
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

describe.skipIf(!wasmExists)("assessEdit() integration", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  it(
    "repair then assess: dropping the disjointness axiom restores consistency and costs the pair; dropping an assertion costs nothing",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
ex:frank a ex:A, ex:B .
`);
      const before = snapshot(store);
      const rep = await reasoner.repair(store);
      expect(rep.repairs.length).toBeGreaterThanOrEqual(3);
      const dropsAxiom = rep.repairs.find(r => r.remove[0].principal.predicate.value.endsWith("disjointWith"))!;
      const dropsAssertion = rep.repairs.find(r => r.remove[0].principal.predicate.value.endsWith("#type"))!;

      const cost = await reasoner.assessEdit(store, { remove: dropsAxiom.remove.flatMap(a => a.quads) });
      expect(cost).toMatchObject({ consistent: true, incomplete: false, unmatchedRemovals: [] });
      expect(cost.lostDisjointPairs).toEqual([pair("A", "B")]);

      const free = await reasoner.assessEdit(store, { remove: dropsAssertion.remove.flatMap(a => a.quads) });
      expect(free.consistent).toBe(true);
      expect(free.lostDisjointPairs).toEqual([]);
      expect(snapshot(store)).toEqual(before); // read-only
    },
    360000,
  );

  it(
    "a pair that stays disjoint through a second axiom is not lost",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
[ a owl:AllDisjointClasses ; owl:members ( ex:A ex:B ) ] .
`);
      const disjointWith = find(store, "A", `${OWL}disjointWith`, "B");
      expect(disjointWith).toHaveLength(1);
      const r = await reasoner.assessEdit(store, { remove: disjointWith });
      expect(r.consistent).toBe(true);
      expect(r.pairsChecked).toEqual([pair("A", "B")]);
      expect(r.lostDisjointPairs).toEqual([]);
    },
    360000,
  );

  it(
    "deriveFromHierarchy: removing a subclass link loses the disjointness of that subclass, not of the asserted pair",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:D a owl:Class .
ex:A owl:disjointWith ex:B .
ex:C rdfs:subClassOf ex:A . ex:D rdfs:subClassOf ex:B .
`);
      const link = find(store, "C", SUBCLASS, "A");
      const r = await reasoner.assessEdit(store, { remove: link }, { deriveFromHierarchy: true });
      expect(r.consistent).toBe(true);
      const lost = r.lostDisjointPairs!.map(p => `${p.a.slice(EX.length)}-${p.b.slice(EX.length)}`).sort();
      expect(lost).toEqual(["B-C", "C-D"]);
      // the plain asserted pair alone is not affected
      const plain = await reasoner.assessEdit(store, { remove: link });
      expect(plain.lostDisjointPairs).toEqual([]);
    },
    360000,
  );

  it(
    "reports unmatched removals and an edit that leaves the ontology inconsistent",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
ex:frank a ex:A, ex:B .
`);
      const ghost = DataFactory.quad(DataFactory.namedNode(`${EX}ghost`), DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${EX}A`));
      const r = await reasoner.assessEdit(store, { remove: [ghost] });
      expect(r.unmatchedRemovals).toEqual([ghost]);
      expect(r).toMatchObject({ consistent: false, lostDisjointPairs: null, reason: "edited-inconsistent" });
      expect(r.pairsChecked).toEqual([pair("A", "B")]);
    },
    360000,
  );

  it("rejects non-store input with TypeError and stays usable", async () => {
    await expect(reasoner.assessEdit({} as unknown as Store, {})).rejects.toBeInstanceOf(TypeError);
    expect(await reasoner.checkConsistency(storeOf(`ex:A a owl:Class .`))).toBe(true);
  }, 120000);
});
