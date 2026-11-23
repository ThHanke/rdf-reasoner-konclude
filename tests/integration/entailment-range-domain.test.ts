/**
 * Integration test: isEntailed for rdfs:range and rdfs:domain (datatype and class hierarchy conclusions).
 * `p range byte` entails `p range short` (W3C WebOnt-I5.8-006/-008/-009 shape); the negative direction must not be entailed.
 * Probe: O plus `x : exists P. not D` (range) or `x : exists P. Top, x : not C` (domain) is inconsistent.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const store = (ttl: string) => new Store(new Parser().parse(PRE + ttl));
const { namedNode, quad } = DataFactory;
const RANGE = "http://www.w3.org/2000/01/rdf-schema#range";
const DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const ax = (p: string, pred: string, o: string) => quad(namedNode(p), namedNode(pred), namedNode(o));

describe.skipIf(!wasmExists)("isEntailed: rdfs:range and rdfs:domain", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  describe("data property ranges follow the datatype hierarchy", () => {
    const s = () => store(`:p a owl:DatatypeProperty ; rdfs:range xsd:byte .`);
    for (const [dt, want] of [["short", true], ["int", true], ["integer", true], ["byte", true], ["unsignedByte", false], ["string", false], ["nonNegativeInteger", false]] as const) {
      it(`p range byte ${want ? "entails" : "does not entail"} p range xsd:${dt}`, async () => {
        expect(await reasoner.isEntailed(s(), ax("http://ex.org/p", RANGE, XSD + dt))).toBe(want);
      }, 60_000);
    }
    it("p range nonNegativeInteger entails integer but not the reverse", async () => {
      const a = store(`:p a owl:DatatypeProperty ; rdfs:range xsd:nonNegativeInteger .`);
      expect(await reasoner.isEntailed(a, ax("http://ex.org/p", RANGE, XSD + "integer"))).toBe(true);
      const b = store(`:p a owl:DatatypeProperty ; rdfs:range xsd:integer .`);
      expect(await reasoner.isEntailed(b, ax("http://ex.org/p", RANGE, XSD + "nonNegativeInteger"))).toBe(false);
    }, 60_000);
  });

  describe("object property ranges and domains follow the class hierarchy and the property hierarchy", () => {
    const base = `:A a owl:Class . :B a owl:Class ; rdfs:subClassOf :A . :p a owl:ObjectProperty . :q a owl:ObjectProperty ; rdfs:subPropertyOf :p .\n`;
    it("p range B, B ⊑ A entails p range A, not the reverse", async () => {
      expect(await reasoner.isEntailed(store(base + `:p rdfs:range :B .`), ax("http://ex.org/p", RANGE, "http://ex.org/A"))).toBe(true);
      expect(await reasoner.isEntailed(store(base + `:p rdfs:range :A .`), ax("http://ex.org/p", RANGE, "http://ex.org/B"))).toBe(false);
    }, 60_000);
    it("p domain B, B ⊑ A entails p domain A, not the reverse", async () => {
      expect(await reasoner.isEntailed(store(base + `:p rdfs:domain :B .`), ax("http://ex.org/p", DOMAIN, "http://ex.org/A"))).toBe(true);
      expect(await reasoner.isEntailed(store(base + `:p rdfs:domain :A .`), ax("http://ex.org/p", DOMAIN, "http://ex.org/B"))).toBe(false);
    }, 60_000);
    it("the range and domain of p carry over to a sub-property q", async () => {
      const s = store(base + `:p rdfs:range :B ; rdfs:domain :B .`);
      expect(await reasoner.isEntailed(s, ax("http://ex.org/q", RANGE, "http://ex.org/B"))).toBe(true);
      expect(await reasoner.isEntailed(s, ax("http://ex.org/q", DOMAIN, "http://ex.org/B"))).toBe(true);
    }, 60_000);
  });

  describe("limits", () => {
    it("an undeclared property is not decided (null)", async () => {
      const s = store(`:A a owl:Class . :u rdfs:range :A .`);
      expect(await reasoner.isEntailed(s, ax("http://ex.org/u", RANGE, "http://ex.org/A"))).toBeNull();
    }, 60_000);
    it("an inconsistent ontology gives null, not a vacuous true", async () => {
      const s = store(`:A a owl:Class . :B a owl:Class ; owl:disjointWith :A . :p a owl:ObjectProperty ; rdfs:range :A .
        :x a :A, :B .`);
      expect(await reasoner.isEntailed(s, ax("http://ex.org/p", RANGE, "http://ex.org/B"))).toBeNull();
    }, 60_000);
    it("a batch mixes range, domain and other axioms", async () => {
      const s = store(`:A a owl:Class . :B a owl:Class ; rdfs:subClassOf :A . :p a owl:ObjectProperty ; rdfs:range :B ; rdfs:domain :B .`);
      const r = await reasoner.isEntailed(s, [
        ax("http://ex.org/p", RANGE, "http://ex.org/A"),
        ax("http://ex.org/p", DOMAIN, "http://ex.org/A"),
        quad(namedNode("http://ex.org/B"), namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf"), namedNode("http://ex.org/A")),
      ]);
      expect(r).toEqual([true, true, true]);
    }, 60_000);
  });
});
