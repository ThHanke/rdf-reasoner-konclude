/**
 * Integration test (B3 of the repair plan): `failOnInconsistent` makes the reasoning methods reject with
 * InconsistentOntologyError instead of returning an empty result without any signal. Default behaviour is unchanged.
 * Requires dist/konclude.wasm; skipped when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner, InconsistentOntologyError, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PREFIXES = `
@prefix ex: <http://example.org/is#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/is> a owl:Ontology .
`;
const EX = "http://example.org/is#";
const { namedNode: n, quad } = DataFactory;
const storeOf = (ttl: string) => new Store(new Parser().parse(PREFIXES + ttl));
const consistentTtl = `ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class . ex:C rdfs:subClassOf ex:A . ex:A owl:disjointWith ex:B . ex:ind a ex:C .`;
const inconsistentTtl = `${consistentTtl} ex:bad a ex:A , ex:B .`;
const subClassOf = (a: string, b: string) => quad(n(`${EX}${a}`), n("http://www.w3.org/2000/01/rdf-schema#subClassOf"), n(`${EX}${b}`));
const inferred = (s: Store) => s.getQuads(null, null, null, n(INFERRED_GRAPH_IRI));

describe.skipIf(!wasmExists)("failOnInconsistent (B3)", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  it("InconsistentOntologyError is an exported Error subclass", () => {
    const e = new InconsistentOntologyError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InconsistentOntologyError");
  });

  it(
    "without the option nothing changes: an inconsistent store gives empty results and no error",
    async () => {
      const store = storeOf(inconsistentTtl);
      await expect(reasoner.classify(store)).resolves.toBeUndefined();
      expect(inferred(store)).toHaveLength(0);
      expect(await reasoner.getUnsatisfiableClasses(store)).toEqual([]);
    },
    360000,
  );

  it(
    "classify, materialize, classifyProperties, getUnsatisfiableClasses, isSatisfiable and isEntailed reject on an inconsistent store",
    async () => {
      const bad = storeOf(inconsistentTtl);
      const opts = { failOnInconsistent: true };
      await expect(reasoner.classify(bad, opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.materialize(bad, opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.classifyProperties(bad, opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.getUnsatisfiableClasses(bad, opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.isSatisfiable(bad, `${EX}A`, opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.isEntailed(bad, subClassOf("C", "A"), opts)).rejects.toBeInstanceOf(InconsistentOntologyError);
      expect(inferred(bad)).toHaveLength(0); // nothing was written before the rejection
    },
    360000,
  );

  it(
    "a consistent store with the option gives the same results as without it",
    async () => {
      const a = storeOf(consistentTtl);
      const b = storeOf(consistentTtl);
      await reasoner.classify(a);
      await reasoner.classify(b, { failOnInconsistent: true });
      expect(inferred(b).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort()).toEqual(
        inferred(a).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort(),
      );
      expect(inferred(b).length).toBeGreaterThan(0);
      const c = storeOf(consistentTtl);
      await expect(reasoner.materialize(c, { failOnInconsistent: true })).resolves.toBeUndefined();
      expect(await reasoner.getUnsatisfiableClasses(c, { failOnInconsistent: true })).toEqual([]);
      expect(await reasoner.isSatisfiable(c, `${EX}A`, { failOnInconsistent: true })).toBe(true);
      expect(await reasoner.isEntailed(c, subClassOf("C", "A"), { failOnInconsistent: true })).toBe(true);
    },
    360000,
  );

  it(
    "whatIf checks the hypothetical ontology: an addition that makes the store inconsistent rejects, without the option it does not",
    async () => {
      const store = storeOf(consistentTtl);
      const makesInconsistent = [quad(n(`${EX}ind`), n("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), n(`${EX}B`))];
      await expect(reasoner.whatIf(store, makesInconsistent, { failOnInconsistent: true })).rejects.toBeInstanceOf(InconsistentOntologyError);
      await expect(reasoner.whatIf(store, makesInconsistent)).resolves.toBeDefined(); // unchanged: no signal
      const harmless = [quad(n(`${EX}other`), n("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), n(`${EX}C`))];
      await expect(reasoner.whatIf(store, harmless, { failOnInconsistent: true })).resolves.toBeDefined();
    },
    360000,
  );

  it(
    "the reasoner stays usable after a rejection",
    async () => {
      const bad = storeOf(inconsistentTtl);
      await expect(reasoner.classify(bad, { failOnInconsistent: true })).rejects.toBeInstanceOf(InconsistentOntologyError);
      const good = storeOf(consistentTtl);
      await reasoner.classify(good, { failOnInconsistent: true });
      expect(inferred(good).length).toBeGreaterThan(0);
      expect(await reasoner.checkConsistency(bad)).toBe(false);
    },
    360000,
  );
});
