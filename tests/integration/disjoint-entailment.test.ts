/**
 * Integration test (A1 of the repair plan): isEntailed / explainEntailment for owl:disjointWith. The kernel does not emit
 * disjointness (asserted or derived) in its output, it only uses the axioms inside reasoning (clashes), so the question is
 * decided with probe classes (a subclass of both is unsatisfiable exactly when the two are disjoint).
 * Requires dist/konclude.wasm; skipped when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PREFIXES = `
@prefix ex: <http://example.org/de#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/de> a owl:Ontology .
`;
const EX = "http://example.org/de#";
const OWL = "http://www.w3.org/2002/07/owl#";
const storeOf = (ttl: string) => new Store(new Parser().parse(PREFIXES + ttl));
const { namedNode: n, quad, blankNode } = DataFactory;
const disjoint = (a: string, b: string) => quad(n(`${EX}${a}`), n(`${OWL}disjointWith`), n(`${EX}${b}`));

describe.skipIf(!wasmExists)("isEntailed / explainEntailment for owl:disjointWith", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  const hierarchy = `
ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:D a owl:Class . ex:E a owl:Class .
ex:A owl:disjointWith ex:B .
ex:C rdfs:subClassOf ex:A . ex:D rdfs:subClassOf ex:B .
`;

  it(
    "asserted, derived and non-disjoint pairs, single and as one batch",
    async () => {
      const store = storeOf(hierarchy);
      expect(await reasoner.isEntailed(store, disjoint("A", "B"))).toBe(true); // asserted
      expect(await reasoner.isEntailed(store, disjoint("B", "A"))).toBe(true); // symmetric
      expect(await reasoner.isEntailed(store, disjoint("C", "D"))).toBe(true); // derived through both subclass links
      expect(await reasoner.isEntailed(store, disjoint("C", "B"))).toBe(true);
      expect(await reasoner.isEntailed(store, disjoint("C", "A"))).toBe(false); // a class is not disjoint from its superclass
      expect(await reasoner.isEntailed(store, disjoint("E", "A"))).toBe(false); // unrelated

      const batch = await reasoner.isEntailed(store, [
        disjoint("C", "D"),
        quad(n(`${EX}C`), n("http://www.w3.org/2000/01/rdf-schema#subClassOf"), n(`${EX}A`)), // another predicate in the same batch
        disjoint("E", "A"),
        quad(n(`${EX}C`), n(`${OWL}sameAs`), n(`${EX}D`)), // unsupported
        quad(blankNode("x"), n(`${OWL}disjointWith`), n(`${EX}A`)), // not a named class
      ]);
      expect(batch).toEqual([true, true, false, null, null]);
    },
    360000,
  );

  it(
    "a pair with an unsatisfiable endpoint holds vacuously; explainEntailment says so",
    async () => {
      const store = storeOf(`${hierarchy} ex:U a owl:Class . ex:U rdfs:subClassOf ex:A , ex:B .`);
      expect(await reasoner.isEntailed(store, disjoint("U", "E"))).toBe(true);
      const r = await reasoner.explainEntailment(store, `${EX}U`, `${OWL}disjointWith`, `${EX}E`);
      expect(r).toMatchObject({ isEntailed: true, vacuous: true });
    },
    360000,
  );

  it(
    "explainEntailment: derived disjointness is entailed (no justification computed), non-disjoint is not, asserted keeps its justification",
    async () => {
      const store = storeOf(hierarchy);
      const derived = await reasoner.explainEntailment(store, `${EX}C`, `${OWL}disjointWith`, `${EX}D`);
      expect(derived.isEntailed).toBe(true);
      expect(derived.justifications).toEqual([]);
      expect((await reasoner.explainEntailment(store, `${EX}C`, `${OWL}disjointWith`, `${EX}A`)).isEntailed).toBe(false);
      const asserted = await reasoner.explainEntailment(store, `${EX}A`, `${OWL}disjointWith`, `${EX}B`);
      expect(asserted.isEntailed).toBe(true);
      expect(asserted.justifications).toHaveLength(1);
    },
    360000,
  );

  it(
    "an inconsistent ontology gives null (unknown), not a vacuous true or a wrong false",
    async () => {
      const store = storeOf(`${hierarchy} ex:i a ex:A , ex:B .`);
      expect(await reasoner.isEntailed(store, disjoint("C", "D"))).toBeNull();
      expect(await reasoner.isEntailed(store, [disjoint("C", "D"), disjoint("E", "A")])).toEqual([null, null]);
      const r = await reasoner.explainEntailment(store, `${EX}C`, `${OWL}disjointWith`, `${EX}D`);
      expect(r).toMatchObject({ isEntailed: null, ontologyInconsistent: true });
    },
    360000,
  );

  it(
    "leaves the reasoner usable and the store untouched",
    async () => {
      const store = storeOf(hierarchy);
      const before = store.size;
      await reasoner.isEntailed(store, disjoint("C", "D"));
      expect(store.size).toBe(before);
      expect(await reasoner.checkConsistency(store)).toBe(true);
    },
    360000,
  );
});
