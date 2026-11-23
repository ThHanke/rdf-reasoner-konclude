/**
 * Integration test: data values follow rdfs:subPropertyOf / owl:equivalentProperty for data properties
 * (src/KoncludeReasoner.cpp, buildInferredTripleBuffer: p(a,v), p ⊑ q ⊢ q(a,v)).
 *
 * Soundness first: only q(a,v) for the super-properties of p. Nothing flows to sub-properties or siblings, the
 * literal keeps its datatype, owl:topDataProperty is never written, and a negative assertion on the super-property
 * makes the ontology inconsistent instead of silently coexisting with the derived value.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
const store = (ttl: string) => new Store(new Parser().parse(PRE + ttl));
const inferred = (s: Store, pred: string) =>
  s.getQuads(null, DataFactory.namedNode(pred), null, DataFactory.namedNode(INFERRED_GRAPH_IRI));
const lit = (q: { object: { value: string; datatype?: { value: string } } }) => `${q.object.value}^^${q.object.datatype?.value}`;
const XSD = "http://www.w3.org/2001/XMLSchema#";

describe.skipIf(!wasmExists)("data property values through the property hierarchy", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("hasAge ⊑ hasNumber: Alice hasNumber 30 is written, with its datatype", async () => {
    const s = store(`:hasAge a owl:DatatypeProperty ; rdfs:subPropertyOf :hasNumber . :hasNumber a owl:DatatypeProperty .
      :Alice a owl:NamedIndividual ; :hasAge "30"^^xsd:integer .`);
    await reasoner.materialize(s);
    const q = inferred(s, "http://ex.org/hasNumber");
    expect(q.map(lit)).toEqual([`30^^${XSD}integer`]);
    expect(q[0]!.subject.value).toBe("http://ex.org/Alice");
  }, 60_000);

  it("owl:topDataProperty values are never written", async () => {
    const s = store(`:hasAge a owl:DatatypeProperty . :Alice a owl:NamedIndividual ; :hasAge "30"^^xsd:integer .`);
    await reasoner.materialize(s);
    expect(inferred(s, "http://www.w3.org/2002/07/owl#topDataProperty")).toHaveLength(0);
  }, 60_000);

  it("a three-level hierarchy yields exactly one value on each super-property", async () => {
    const s = store(`:p1 a owl:DatatypeProperty ; rdfs:subPropertyOf :p2 . :p2 a owl:DatatypeProperty ; rdfs:subPropertyOf :p3 .
      :p3 a owl:DatatypeProperty . :a a owl:NamedIndividual ; :p1 "3.5"^^xsd:decimal .`);
    await reasoner.materialize(s);
    expect(inferred(s, "http://ex.org/p2").map(lit)).toEqual([`3.5^^${XSD}decimal`]);
    expect(inferred(s, "http://ex.org/p3").map(lit)).toEqual([`3.5^^${XSD}decimal`]);
  }, 60_000);

  it("equivalent data properties carry the value both ways", async () => {
    const s = store(`:p a owl:DatatypeProperty ; owl:equivalentProperty :q . :q a owl:DatatypeProperty .
      :a a owl:NamedIndividual ; :p "x"^^xsd:string . :b a owl:NamedIndividual ; :q "y"^^xsd:string .`);
    await reasoner.materialize(s);
    expect(inferred(s, "http://ex.org/q").map((x) => x.subject.value + "=" + x.object.value)).toContain("http://ex.org/a=x");
    expect(inferred(s, "http://ex.org/p").map((x) => x.subject.value + "=" + x.object.value)).toContain("http://ex.org/b=y");
  }, 60_000);

  it("nothing flows downwards or sideways: super to sub, and sibling properties stay untouched", async () => {
    const s = store(`:hasAge a owl:DatatypeProperty ; rdfs:subPropertyOf :hasNumber . :hasHeight a owl:DatatypeProperty ; rdfs:subPropertyOf :hasNumber .
      :hasNumber a owl:DatatypeProperty .
      :Alice a owl:NamedIndividual ; :hasAge "30"^^xsd:integer . :Bob a owl:NamedIndividual ; :hasNumber "7"^^xsd:integer .`);
    await reasoner.materialize(s);
    expect(inferred(s, "http://ex.org/hasHeight")).toHaveLength(0); // sibling
    expect(inferred(s, "http://ex.org/hasAge")).toHaveLength(0); // sub-property of Bob's hasNumber
    expect(inferred(s, "http://ex.org/hasNumber").map((x) => x.subject.value)).toEqual(["http://ex.org/Alice"]);
  }, 60_000);

  it("the PMDco pattern OBI_0001937 ⊑ OBI_0002135 is confirmed by an independent entailment probe", async () => {
    // fraction_iron OBI_0001937 96.7 (PMDco 3.0.0 + Fe-Si record): the kit's 2 extra triples against main
    const O = "http://purl.obolibrary.org/obo/";
    const s = store(`<${O}OBI_0001937> a owl:DatatypeProperty ; rdfs:subPropertyOf <${O}OBI_0002135> . <${O}OBI_0002135> a owl:DatatypeProperty .
      <${O}fraction_iron> a owl:NamedIndividual ; <${O}OBI_0001937> "96.7"^^xsd:decimal .`);
    await reasoner.materialize(s);
    const synthesized = inferred(s, `${O}OBI_0002135`);
    expect(synthesized.map(lit)).toEqual([`96.7^^${XSD}decimal`]);
    // the kernel's refutation probe does not use the synthesis path
    const axiom = DataFactory.quad(
      DataFactory.namedNode(`${O}fraction_iron`),
      DataFactory.namedNode(`${O}OBI_0002135`),
      DataFactory.literal("96.7", DataFactory.namedNode(`${XSD}decimal`)),
    );
    const probeStore = store(`<${O}OBI_0001937> a owl:DatatypeProperty ; rdfs:subPropertyOf <${O}OBI_0002135> . <${O}OBI_0002135> a owl:DatatypeProperty .
      <${O}fraction_iron> a owl:NamedIndividual ; <${O}OBI_0001937> "96.7"^^xsd:decimal .`);
    expect(await reasoner.isEntailed(probeStore, axiom)).toBe(true);
  }, 90_000);

  it("a negative assertion on the super-property contradicts the sub-property value", async () => {
    const s = store(`:hasAge a owl:DatatypeProperty ; rdfs:subPropertyOf :hasNumber . :hasNumber a owl:DatatypeProperty .
      :Alice a owl:NamedIndividual ; :hasAge "30"^^xsd:integer .
      [ a owl:NegativePropertyAssertion ; owl:sourceIndividual :Alice ; owl:assertionProperty :hasNumber ; owl:targetValue "30"^^xsd:integer ] .`);
    expect(await reasoner.checkConsistency(s)).toBe(false);
  }, 60_000);
});
