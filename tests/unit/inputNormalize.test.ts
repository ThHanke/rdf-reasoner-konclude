import { describe, expect, it } from "vitest";
import { Parser, Store } from "n3";
import { normalizeQuads, mapBackIri, BOTTOM_DP_PROXY } from "../../ts/inputNormalize.js";
import { encodeStoreToBuffers } from "../../ts/n3Inject.js";
import { encodeToBuffers } from "../../ts/intern.js";

const PRE = `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix ex: <http://ex.org/> .`;
const parse = (s: string) => new Parser().parse(PRE + s);
const has = (qs: ReturnType<typeof normalizeQuads>, s: string, p: string, o: string) =>
  qs.some((q) => q.subject.value === s && q.predicate.value === p && q.object.value === o);
const T = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", DT = "http://www.w3.org/2000/01/rdf-schema#Datatype";

describe("inputNormalize", () => {
  it("rewrites an OWL 1 style named-class intersectionOf to an equivalent class expression", () => {
    const out = normalizeQuads(parse(`ex:C owl:intersectionOf ( ex:A ex:B ) .`));
    const eq = out.find((q) => q.subject.value === "http://ex.org/C" && q.predicate.value.endsWith("#equivalentClass"))!;
    expect(eq.object.termType).toBe("BlankNode");
    expect(out.some((q) => q.subject.equals(eq.object) && q.predicate.value.endsWith("#intersectionOf"))).toBe(true);
    expect(out.some((q) => q.subject.value === "http://ex.org/C" && q.predicate.value.endsWith("#intersectionOf"))).toBe(false);
  });

  it("leaves skolemized anonymous class expressions (Ontosphere blank nodes) alone", () => {
    const qs = parse(`<urn:vg:bnode:x1> owl:intersectionOf ( ex:A ex:B ) .`);
    expect(normalizeQuads(qs)).toHaveLength(qs.length);
  });

  it("rewrites a negative data property assertion to a : not (P hasValue v) and drops the NPA node", () => {
    const out = normalizeQuads(parse(`ex:Meg ex:hasAge 5 . [ a owl:NegativePropertyAssertion ; owl:sourceIndividual ex:Meg ;
      owl:assertionProperty ex:hasAge ; owl:targetValue 5 ] .`));
    expect(out.some((q) => q.object.value === "http://www.w3.org/2002/07/owl#NegativePropertyAssertion")).toBe(false);
    const r = out.find((q) => q.predicate.value.endsWith("#hasValue"))!;
    expect(r.object.value).toBe("5");
    const c = out.find((q) => q.predicate.value.endsWith("#complementOf") && q.object.equals(r.subject))!;
    expect(out.some((q) => q.subject.value === "http://ex.org/Meg" && q.predicate.value === T && q.object.equals(c.subject))).toBe(true);
  });

  it("rewrites a negative object property assertion with owl:targetIndividual the same way", () => {
    const out = normalizeQuads(parse(`[ a owl:NegativePropertyAssertion ; owl:sourceIndividual ex:a ; owl:assertionProperty ex:r ; owl:targetIndividual ex:b ] .`));
    expect(out.find((q) => q.predicate.value.endsWith("#hasValue"))!.object.value).toBe("http://ex.org/b");
  });

  it("replaces owl:bottomDataProperty by an empty data property and maps the name back", () => {
    const out = normalizeQuads(parse(`ex:i a [ a owl:Restriction ; owl:onProperty owl:bottomDataProperty ; owl:someValuesFrom rdfs:Literal ] .`));
    expect(out.some((q) => [q.subject, q.predicate, q.object].some((t) => t.value === "http://www.w3.org/2002/07/owl#bottomDataProperty"))).toBe(false);
    expect(has(out, BOTTOM_DP_PROXY, "http://www.w3.org/2000/01/rdf-schema#range", out.find((q) => q.predicate.value.endsWith("#datatypeComplementOf"))!.subject.value)).toBe(true);
    expect(has(out, "http://www.w3.org/2000/01/rdf-schema#Literal", T, DT)).toBe(true);
    expect(mapBackIri(BOTTOM_DP_PROXY)).toBe("http://www.w3.org/2002/07/owl#bottomDataProperty");
  });

  it("leaves input without these constructs unchanged", () => {
    const qs = parse(`ex:a a ex:C . ex:C rdfs:subClassOf ex:D .`);
    expect(normalizeQuads(qs)).toHaveLength(qs.length);
  });

  it("store path and quad path encode the same triples, with and without a rewrite", () => {
    const plain = parse(`ex:p a owl:DatatypeProperty ; rdfs:range xsd:integer . ex:a ex:p 3 .`);
    expect(encodeStoreToBuffers(new Store(plain)).tripleBuffer.byteLength).toBe(encodeToBuffers(plain).tripleBuffer.byteLength);
    expect(encodeStoreToBuffers(new Store(plain)).tripleBuffer.byteLength / 12).toBe(plain.length); // nothing added
    const npa = parse(`[ a owl:NegativePropertyAssertion ; owl:sourceIndividual ex:a ; owl:assertionProperty ex:p ; owl:targetValue 3 ] .`);
    expect(encodeStoreToBuffers(new Store(npa)).tripleBuffer.byteLength).toBe(encodeToBuffers(npa).tripleBuffer.byteLength); // both rewrite
  });

  it("adds a per-literal axiom for each pair of disjoint data properties", () => {
    const out = normalizeQuads(parse(`ex:p a owl:DatatypeProperty ; owl:propertyDisjointWith ex:q . ex:q a owl:DatatypeProperty .
      ex:a ex:p "x" ; ex:q "x", "y" .`));
    // two literals, one pair: two axioms owl:Thing ⊑ ¬(∃p.{v} ⊓ ∃q.{v})
    expect(out.filter((q) => q.subject.value === "http://www.w3.org/2002/07/owl#Thing" && q.predicate.value.endsWith("#subClassOf"))).toHaveLength(2);
    expect(out.filter((q) => q.predicate.value.endsWith("#hasValue")).map((q) => q.object.value).sort()).toEqual(["x", "x", "y", "y"]);
  });

  it("handles owl:AllDisjointProperties and ignores disjoint object properties", () => {
    const all = normalizeQuads(parse(`ex:p a owl:DatatypeProperty . ex:q a owl:DatatypeProperty . ex:r a owl:DatatypeProperty .
      [ a owl:AllDisjointProperties ; owl:members ( ex:p ex:q ex:r ) ] . ex:a ex:p 1 .`));
    expect(all.filter((q) => q.predicate.value.endsWith("#subClassOf"))).toHaveLength(3); // pairs pq, pr, qr × one literal
    const obj = normalizeQuads(parse(`ex:p a owl:ObjectProperty ; owl:propertyDisjointWith ex:q . ex:q a owl:ObjectProperty . ex:a ex:p ex:b .`));
    expect(obj.some((q) => q.predicate.value.endsWith("#subClassOf"))).toBe(false);
  });

  it("makes named individuals that share the key values owl:sameAs (HasKey)", () => {
    const out = normalizeQuads(parse(`ex:Person owl:hasKey ( ex:ssn ) . ex:p1 a ex:Person ; ex:ssn "1" . ex:p2 a ex:Person ; ex:ssn "1" .
      ex:p3 a ex:Person ; ex:ssn "2" . ex:p4 ex:ssn "1" .`));
    const same = out.filter((q) => q.predicate.value.endsWith("#sameAs")).map((q) => `${q.subject.value}=${q.object.value}`);
    expect(same).toEqual(["http://ex.org/p1=http://ex.org/p2"]); // p4 is not a Person, p3 has another value
  });

  it("HasKey on owl:Thing applies to all named individuals, needs every key property, and follows asserted subclasses", () => {
    const thing = normalizeQuads(parse(`owl:Thing owl:hasKey ( ex:ssn ) . ex:a ex:ssn "1" . ex:b ex:ssn "1" .`));
    expect(thing.filter((q) => q.predicate.value.endsWith("#sameAs"))).toHaveLength(1);
    const two = normalizeQuads(parse(`ex:C owl:hasKey ( ex:k1 ex:k2 ) . ex:a a ex:C ; ex:k1 "1" ; ex:k2 "a" . ex:b a ex:C ; ex:k1 "1" ; ex:k2 "b" .`));
    expect(two.some((q) => q.predicate.value.endsWith("#sameAs"))).toBe(false);
    const sub = normalizeQuads(parse(`ex:C owl:hasKey ( ex:k ) . ex:D rdfs:subClassOf ex:C . ex:a a ex:D ; ex:k "1" . ex:b a ex:C ; ex:k "1" .`));
    expect(sub.filter((q) => q.predicate.value.endsWith("#sameAs"))).toHaveLength(1);
  });
});
