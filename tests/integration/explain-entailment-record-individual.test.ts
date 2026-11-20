/**
 * Regression (0.9.6): the subClassOf probe used a global axiom A ⊑ ¬B, so an individual asserted as both A and B
 * clashed by itself: a non-entailed A ⊑ B was reported entailed, and record assertions ended up in justifications.
 * The probe now asserts a fresh witness in A and ¬B instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";
import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const TTL = `
@prefix : <http://ex.org/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:A a owl:Class . :B a owl:Class . :M a owl:Class . :N a owl:Class . :C a owl:Class .
:A rdfs:subClassOf :M . :M rdfs:subClassOf :B .
:r a :A , :B , :C .
`;
const key = (q: { subject: { value: string }; predicate: { value: string }; object: { value: string } }) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

describe.skipIf(!wasmExists)("explainEntailment with an individual that is both A and B", () => {
  let reasoner: RdfReasoner;
  let store: Store;
  beforeAll(async () => {
    store = new Store(new Parser({ format: "text/turtle" }).parse(TTL));
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 120_000);
  afterAll(() => reasoner?.terminate());

  it("A ⊑ C is not entailed although the record individual is both A and C", async () => {
    const r = await reasoner.explainEntailment(store, "http://ex.org/A", SUB, "http://ex.org/C", { justificationMode: "exact" });
    expect(r.isEntailed).toBe(false);
    expect(r.justifications).toEqual([]);
  }, 120_000);

  it("A ⊑ B justification holds only the two axioms, no record assertion", async () => {
    const r = await reasoner.explainEntailment(store, "http://ex.org/A", SUB, "http://ex.org/B", { justificationMode: "exact", maxJustifications: 3 });
    expect(r.isEntailed).toBe(true);
    expect(r.justifications.length).toBe(1);
    expect(r.justifications[0].map(key).sort()).toEqual([`http://ex.org/A ${SUB} http://ex.org/M`, `http://ex.org/M ${SUB} http://ex.org/B`]);
  }, 120_000);
});
