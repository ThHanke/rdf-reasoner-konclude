/**
 * Integration test: explainInconsistencyAxioms() — justifications grouped by axiom, declarations in `context`.
 * Requires dist/konclude.wasm; skipped when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

const PREFIXES = `
@prefix ex: <http://example.org/axg#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/axg> a owl:Ontology .
`;

function storeOf(ttl: string): Store {
  return new Store(new Parser().parse(PREFIXES + ttl));
}

describe.skipIf(!wasmExists)("explainInconsistencyAxioms() integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  it(
    "disjointness clash: declarations go to context, axioms are exact store instances",
    async () => {
      const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
ex:frank a ex:A, ex:B .
`);
      const js = await reasoner.explainInconsistencyAxioms(store, { maxJustifications: 1 });
      expect(js.length).toBeGreaterThanOrEqual(1);
      const j = js[0];
      const owlClass = "http://www.w3.org/2002/07/owl#Class";
      // no declaration among removable members
      for (const ax of j.axioms) {
        for (const q of ax.quads) {
          expect(q.object.value === owlClass && q.predicate.value.endsWith("#type")).toBe(false);
        }
      }
      // identity: every principal is an instance that is in the store
      for (const ax of j.axioms) expect(store.has(ax.principal)).toBe(true);
      // the disjointness axiom is among them
      expect(j.axioms.some(ax => ax.principal.predicate.value.endsWith("#disjointWith"))).toBe(true);
    },
    360000,
  );

  it(
    "restriction clash: the restriction axiom is one multi-triple unit",
    async () => {
      const store = storeOf(`
ex:p a owl:ObjectProperty . ex:C a owl:Class .
ex:C rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
ex:x a ex:C ; ex:p ex:y1, ex:y2 .
ex:y1 owl:differentFrom ex:y2 .
`);
      const js = await reasoner.explainInconsistencyAxioms(store, { maxJustifications: 1 });
      expect(js.length).toBeGreaterThanOrEqual(1);
      const restriction = js[0].axioms.find(ax => ax.principal.object.termType === "BlankNode");
      expect(restriction).toBeDefined();
      expect(restriction!.quads.length).toBeGreaterThanOrEqual(4);
      for (const q of restriction!.quads) expect(store.has(q)).toBe(true);
    },
    360000,
  );

  it("consistent ontology returns []", async () => {
    const store = storeOf(`ex:A a owl:Class . ex:B a owl:Class . ex:A rdfs:subClassOf ex:B .`);
    expect(await reasoner.explainInconsistencyAxioms(store)).toEqual([]);
  }, 120000);
});
