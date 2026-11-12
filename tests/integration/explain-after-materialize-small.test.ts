/**
 * explainEntailment() after materialize on small ontologies (not Fe-Si): a class-hierarchy chain and an equivalentClass
 * restriction. Justifications must be asserted axioms only, never inferred hierarchy edges; causal either returns a
 * verified justification or an empty list with `justificationUnavailable`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";
import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const INFERRED = "urn:vg:inferred";
const TTL = `
@prefix : <http://ex.org/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
:C a owl:Class . :D a owl:Class . :E a owl:Class . :F a owl:Class . :B a owl:Class . :p a owl:ObjectProperty .
:C rdfs:subClassOf :D . :D rdfs:subClassOf :E .
:F owl:equivalentClass [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :B ] .
:x a :C . :y a :B . :z :p :y .
`;
const key = (q: { subject: { value: string }; predicate: { value: string }; object: { value: string } }) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`;

describe.skipIf(!wasmExists)("explainEntailment after materialize (small ontologies)", () => {
  let reasoner: RdfReasoner;
  let store: Store;
  beforeAll(async () => {
    store = new Store(new Parser({ format: "text/turtle" }).parse(TTL));
    reasoner = new RdfReasoner({ excludeGraphs: [INFERRED] });
    await reasoner.ready;
    await reasoner.checkConsistency(store);
    await reasoner.materialize(store, { includeClassHierarchy: true, inferredGraph: INFERRED, returnDelta: true });
  }, 120_000);
  afterAll(() => reasoner?.terminate());

  it("exact: hierarchy chain expands to asserted axioms", async () => {
    const r = await reasoner.explainEntailment(store, "http://ex.org/x", "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "http://ex.org/E", { justificationMode: "exact", maxJustifications: 3 });
    expect(r.isEntailed).toBe(true);
    expect(r.justifications.length).toBe(1);
    const got = r.justifications[0].map(key).sort();
    expect(got).toEqual([
      "http://ex.org/C http://www.w3.org/2000/01/rdf-schema#subClassOf http://ex.org/D",
      "http://ex.org/D http://www.w3.org/2000/01/rdf-schema#subClassOf http://ex.org/E",
      "http://ex.org/x http://www.w3.org/1999/02/22-rdf-syntax-ns#type http://ex.org/C",
    ]);
  }, 120_000);

  it("fast: never returns the inferred edge C subClassOf E; empty must be flagged", async () => {
    const r = await reasoner.explainEntailment(store, "http://ex.org/C", "http://www.w3.org/2000/01/rdf-schema#subClassOf", "http://ex.org/E", { justificationMode: "fast" });
    expect(r.isEntailed).toBe(true);
    const asserted = new Set(store.getQuads(null, null, null, null).filter((q) => q.graph.value !== INFERRED).map(key));
    for (const j of r.justifications) for (const q of j) expect(asserted.has(key(q))).toBe(true);
    if (r.justifications.length === 0) expect(r.justificationUnavailable).toBe(true);
    expect(r.justifications.flat().map(key)).not.toContain("http://ex.org/C http://www.w3.org/2000/01/rdf-schema#subClassOf http://ex.org/E");
  }, 120_000);

  it("exact: restriction-defined class includes the equivalentClass axiom", async () => {
    const r = await reasoner.explainEntailment(store, "http://ex.org/z", "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "http://ex.org/F", { justificationMode: "exact", maxJustifications: 3 });
    expect(r.isEntailed).toBe(true);
    expect(r.justifications.length).toBeGreaterThan(0);
    const flat = r.justifications[0].map(key);
    expect(flat).toContain("http://ex.org/z http://ex.org/p http://ex.org/y");
    expect(flat).toContain("http://ex.org/y http://www.w3.org/1999/02/22-rdf-syntax-ns#type http://ex.org/B");
  }, 120_000);
});
