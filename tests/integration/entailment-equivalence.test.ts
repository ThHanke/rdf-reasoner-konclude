/**
 * Integration test: entailments through owl:sameAs, owl:equivalentClass and owl:equivalentProperty.
 *  - sameAs: symmetric, transitive, and everything asserted about one individual holds for the other (types, object and data
 *    property assertions), through isEntailed and in the materialized graph.
 *  - equivalentClass: both subclass directions, instances carry over, symmetric, transitive, derived from mutual subclass axioms.
 *  - equivalentProperty: symmetric, transitive, assertions carry over.
 * Negative controls: nothing is entailed between unrelated entities. One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n`;
const store = (ttl: string) => new Store(new Parser().parse(PRE + ttl));
const { namedNode, literal, quad } = DataFactory;
const E = (l: string) => namedNode("http://ex.org/" + l);
const OWL = "http://www.w3.org/2002/07/owl#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const t = (s: string, p: string, o: string) => quad(E(s), namedNode(p), E(o));

describe.skipIf(!wasmExists)("entailments through sameAs and equivalence", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  describe("owl:sameAs", () => {
    const ttl = `:C a owl:Class . :r a owl:ObjectProperty . :d a owl:DatatypeProperty .
      :a a owl:NamedIndividual, :C ; :r :o ; :d "v" . :b a owl:NamedIndividual . :c a owl:NamedIndividual . :z a owl:NamedIndividual .
      :a owl:sameAs :b . :b owl:sameAs :c .`;
    it("is symmetric and transitive", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("b", OWL + "sameAs", "a"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("a", OWL + "sameAs", "c"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("a", OWL + "sameAs", "z"))).toBe(false);
    }, 60_000);
    it("the same entity has the same types", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("b", RDF_TYPE, "C"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("c", RDF_TYPE, "C"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("z", RDF_TYPE, "C"))).toBe(false);
    }, 60_000);
    it("the same entity has the same object property assertions", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("b", "http://ex.org/r", "o"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("z", "http://ex.org/r", "o"))).toBe(false);
    }, 60_000);
    it("the same entity has the same data property assertions", async () => {
      expect(await reasoner.isEntailed(store(ttl), quad(E("b"), E("d"), literal("v")))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), quad(E("z"), E("d"), literal("v")))).toBe(false);
    }, 60_000);
    it("materialize writes the carried-over type", async () => {
      const s = store(ttl);
      await reasoner.materialize(s);
      const inferred = s.getQuads(E("b"), namedNode(RDF_TYPE), E("C"), namedNode(INFERRED_GRAPH_IRI));
      expect(inferred.length + s.getQuads(E("b"), namedNode(RDF_TYPE), E("C"), null).length).toBeGreaterThan(0);
    }, 60_000);
  });

  describe("owl:equivalentClass", () => {
    const ttl = `:A a owl:Class ; owl:equivalentClass :B . :B a owl:Class . :C a owl:Class . :D a owl:Class ; rdfs:subClassOf :C . :C rdfs:subClassOf :D .
      :E a owl:Class ; owl:equivalentClass :A . :F a owl:Class . :x a owl:NamedIndividual, :A .`;
    it("both subclass directions, symmetric, transitive", async () => {
      const s = () => store(ttl);
      expect(await reasoner.isEntailed(s(), t("A", RDFS + "subClassOf", "B"))).toBe(true);
      expect(await reasoner.isEntailed(s(), t("B", RDFS + "subClassOf", "A"))).toBe(true);
      expect(await reasoner.isEntailed(s(), t("B", OWL + "equivalentClass", "A"))).toBe(true);
      expect(await reasoner.isEntailed(s(), t("B", OWL + "equivalentClass", "E"))).toBe(true);
      expect(await reasoner.isEntailed(s(), t("A", OWL + "equivalentClass", "F"))).toBe(false);
    }, 90_000);
    it("equivalence from mutual subclass axioms", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("C", OWL + "equivalentClass", "D"))).toBe(true);
    }, 60_000);
    it("instances of one class are instances of the equivalent class", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("x", RDF_TYPE, "B"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("x", RDF_TYPE, "F"))).toBe(false);
    }, 60_000);
  });

  describe("owl:equivalentProperty", () => {
    const ttl = `:p a owl:ObjectProperty ; owl:equivalentProperty :q . :q a owl:ObjectProperty . :s a owl:ObjectProperty ; owl:equivalentProperty :p .
      :u a owl:ObjectProperty . :a a owl:NamedIndividual ; :p :b . :b a owl:NamedIndividual .`;
    it("symmetric and transitive", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("q", OWL + "equivalentProperty", "p"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("q", OWL + "equivalentProperty", "s"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("p", OWL + "equivalentProperty", "u"))).toBe(false);
    }, 90_000);
    it("assertions carry over to the equivalent property", async () => {
      expect(await reasoner.isEntailed(store(ttl), t("a", "http://ex.org/q", "b"))).toBe(true);
      expect(await reasoner.isEntailed(store(ttl), t("a", "http://ex.org/u", "b"))).toBe(false);
    }, 60_000);
  });

  describe("transitive closure of the hierarchies (the classifiers write only the direct hierarchy)", () => {
    const classes = `:A a owl:Class ; rdfs:subClassOf :B . :B a owl:Class ; rdfs:subClassOf :C . :C a owl:Class . :X a owl:Class .
      :U a owl:Class ; rdfs:subClassOf :C, [ a owl:Class ; owl:complementOf :C ] .`;
    it("A ⊑ B ⊑ C entails A ⊑ C, A ⊑ A, A ⊑ Thing; not C ⊑ A, not A ⊑ X; an unsatisfiable class is below every class", async () => {
      expect(await reasoner.isEntailed(store(classes), t("A", RDFS + "subClassOf", "C"))).toBe(true);
      expect(await reasoner.isEntailed(store(classes), t("A", RDFS + "subClassOf", "A"))).toBe(true);
      expect(await reasoner.isEntailed(store(classes), quad(E("A"), namedNode(RDFS + "subClassOf"), namedNode(OWL + "Thing")))).toBe(true);
      expect(await reasoner.isEntailed(store(classes), t("C", RDFS + "subClassOf", "A"))).toBe(false);
      expect(await reasoner.isEntailed(store(classes), t("A", RDFS + "subClassOf", "X"))).toBe(false);
      expect(await reasoner.isEntailed(store(classes), t("U", RDFS + "subClassOf", "X"))).toBe(true);
    }, 90_000);
    it("p ⊑ q ⊑ t entails p ⊑ t and p ⊑ p; not t ⊑ p", async () => {
      const props = `:p a owl:ObjectProperty ; rdfs:subPropertyOf :q . :q a owl:ObjectProperty ; rdfs:subPropertyOf :t . :t a owl:ObjectProperty . :w a owl:ObjectProperty .`;
      expect(await reasoner.isEntailed(store(props), t("p", RDFS + "subPropertyOf", "t"))).toBe(true);
      expect(await reasoner.isEntailed(store(props), t("p", RDFS + "subPropertyOf", "p"))).toBe(true);
      expect(await reasoner.isEntailed(store(props), t("t", RDFS + "subPropertyOf", "p"))).toBe(false);
      expect(await reasoner.isEntailed(store(props), t("p", RDFS + "subPropertyOf", "w"))).toBe(false);
    }, 90_000);
    it("equivalent classes entail subClassOf in both directions", async () => {
      const eq = `:A a owl:Class ; owl:equivalentClass :B . :B a owl:Class .`;
      expect(await reasoner.isEntailed(store(eq), t("A", RDFS + "subClassOf", "B"))).toBe(true);
      expect(await reasoner.isEntailed(store(eq), t("B", RDFS + "subClassOf", "A"))).toBe(true);
    }, 60_000);
    it("sameAs is reflexive for an individual", async () => {
      expect(await reasoner.isEntailed(store(`:a a owl:NamedIndividual .`), t("a", OWL + "sameAs", "a"))).toBe(true);
    }, 60_000);
  });

  describe("property subsumption beyond the classifier's hierarchy (W3C WebOnt-equivalentProperty-004)", () => {
    const base = `:p a owl:ObjectProperty, owl:FunctionalProperty ; rdfs:domain :d . :q a owl:ObjectProperty, owl:FunctionalProperty ; rdfs:domain :d .
      :v a owl:NamedIndividual .`;
    const d = `:d a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty :p ; owl:hasValue :v ], [ a owl:Restriction ; owl:onProperty :q ; owl:hasValue :v ] .`;
    it("p and q are equivalent through domain, functionality and hasValue axioms: entailed in both directions", async () => {
      expect(await reasoner.isEntailed(store(base + d), t("p", OWL + "equivalentProperty", "q"))).toBe(true);
      expect(await reasoner.isEntailed(store(base + d), t("p", RDFS + "subPropertyOf", "q"))).toBe(true);
      expect(await reasoner.isEntailed(store(base + d), t("q", RDFS + "subPropertyOf", "p"))).toBe(true);
    }, 90_000);
    it("without the hasValue definition of d the properties are not equivalent", async () => {
      expect(await reasoner.isEntailed(store(base + `:d a owl:Class .`), t("p", OWL + "equivalentProperty", "q"))).toBe(false);
    }, 60_000);
  });
});
