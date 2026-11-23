/**
 * Integration test: RdfReasoner.isEntailedGraph, conclusions that are small RDF graphs (W3C OWL 2 entailment test shapes).
 *  - existential conclusions with blank nodes are decided by a refutation probe (s : not (exists p . D) inconsistent);
 *  - annotation conclusions are a lookup that follows sameAs / equivalent classes / equivalent properties; absence gives null;
 *  - anything the planner cannot handle soundly gives null, never true.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const store = (ttl: string) => new Store(new Parser().parse(PRE + ttl));
const concl = (ttl: string) => new Parser().parse(PRE + ttl);

describe.skipIf(!wasmExists)("isEntailedGraph", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  describe("existential conclusions", () => {
    const premise = `:p a owl:ObjectProperty . :fred a owl:NamedIndividual ; :p :bob . :bob a owl:NamedIndividual .`;
    it("a p _:x is entailed when a has some p-successor (W3C somevaluesfrom2bnode)", async () => {
      expect(await reasoner.isEntailedGraph(store(premise), concl(`:fred :p _:x .`))).toBe(true);
    }, 60_000);
    it("is not entailed for an individual without a successor", async () => {
      expect(await reasoner.isEntailedGraph(store(premise + ` :lone a owl:NamedIndividual .`), concl(`:lone :p _:x .`))).toBe(false);
    }, 60_000);
    it("a typed blank node needs the type: entailed through a class axiom, not otherwise", async () => {
      const t = `:C a owl:Class . :bob a :C .`;
      expect(await reasoner.isEntailedGraph(store(premise + t), concl(`:fred :p _:x . _:x a :C .`))).toBe(true);
      expect(await reasoner.isEntailedGraph(store(premise + ` :D a owl:Class .`), concl(`:fred :p _:x . _:x a :D .`))).toBe(false);
    }, 90_000);
    it("a chain of anonymous successors (W3C someValuesFrom-003 shape)", async () => {
      const prem = `:parent a owl:ObjectProperty . :fred a owl:NamedIndividual ; :parent :a1 . :a1 :parent :a2 . :a2 a owl:NamedIndividual . :a1 a owl:NamedIndividual .`;
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:fred :parent _:x1 . _:x1 :parent _:x2 .`))).toBe(true);
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:a2 :parent _:x1 . _:x1 :parent _:x2 .`))).toBe(false);
    }, 90_000);
    it("an inconsistent ontology gives null, not a vacuous true", async () => {
      const bad = `:A a owl:Class . :B a owl:Class ; owl:disjointWith :A . :x a :A, :B . :p a owl:ObjectProperty .`;
      expect(await reasoner.isEntailedGraph(store(bad), concl(`:x :p _:y .`))).toBeNull();
    }, 60_000);
  });

  describe("annotation conclusions", () => {
    it("found for the entity itself, and for the same / an equivalent class / an equivalent property entity", async () => {
      const prem = `:ap a owl:AnnotationProperty . :c1 a owl:Class ; :ap "description of c1" . :c2 a owl:Class ; owl:equivalentClass :c1 .
        :i1 a owl:NamedIndividual ; rdfs:comment "an individual" . :i2 a owl:NamedIndividual ; owl:sameAs :i1 .`;
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:c1 :ap "description of c1" .`))).toBe(true);
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:c2 :ap "description of c1" .`))).toBe(true); // via equivalentClass
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:i2 rdfs:comment "an individual" .`))).toBe(true); // via sameAs
    }, 90_000);
    it("an annotation that is not in the store is null, never false", async () => {
      const prem = `:ap a owl:AnnotationProperty . :c1 a owl:Class ; :ap "x" .`;
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:c1 :ap "y" .`))).toBeNull();
    }, 60_000);
  });

  describe("mixed and unsupported shapes", () => {
    it("named triples are decided by isEntailed inside the same conjunction", async () => {
      const prem = `:A a owl:Class ; rdfs:subClassOf :B . :B a owl:Class . :p a owl:ObjectProperty . :fred :p :bob . :bob a owl:NamedIndividual .`;
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:A rdfs:subClassOf :B . :fred :p _:x .`))).toBe(true);
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:B rdfs:subClassOf :A . :fred :p _:x .`))).toBe(false);
    }, 90_000);
    it("shared blank nodes (a join), cycles and free-standing blank nodes give null", async () => {
      const prem = `:p a owl:ObjectProperty . :a :p :b . :b :p :a .`;
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:a :p _:x . :b :p _:x .`))).toBeNull();
      expect(await reasoner.isEntailedGraph(store(prem), concl(`:a :p _:x . _:x :p _:x .`))).toBeNull();
      expect(await reasoner.isEntailedGraph(store(prem), concl(`_:y a owl:Thing .`))).toBeNull();
    }, 60_000);
  });
});
