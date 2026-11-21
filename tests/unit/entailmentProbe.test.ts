import { describe, expect, it } from "vitest";
import {
  buildEntailmentProbe,
  classifyAxiom,
  tripleKey,
} from "../../ts/entailmentProbe.js";

const RDFS_SUBCLASSOF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_EQUIVALENT_PROPERTY = "http://www.w3.org/2002/07/owl#equivalentProperty";
const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";
const OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";

describe("classifyAxiom", () => {
  it("subClassOf with class object → subClassOf", () => {
    expect(classifyAxiom(RDFS_SUBCLASSOF, true)).toBe("subClassOf");
  });

  it("rdf:type with class object → type", () => {
    expect(classifyAxiom(RDF_TYPE, true)).toBe("type");
  });

  it("literal object with class predicate → dataProperty", () => {
    expect(classifyAxiom(RDFS_SUBCLASSOF, false)).toBe("dataProperty");
  });

  it("unknown predicate → unsupported", () => {
    expect(classifyAxiom("http://example.org/foo", true)).toBe("unsupported");
  });

  it("owl:sameAs → sameAs (regardless of objectIsClassLike)", () => {
    expect(classifyAxiom(OWL_SAME_AS, true)).toBe("sameAs");
    expect(classifyAxiom(OWL_SAME_AS, false)).toBe("sameAs");
  });

  it("owl:equivalentProperty → equivalentProperty", () => {
    expect(classifyAxiom(OWL_EQUIVALENT_PROPERTY, true)).toBe("equivalentProperty");
    expect(classifyAxiom(OWL_EQUIVALENT_PROPERTY, false)).toBe("equivalentProperty");
  });

  it("owl:disjointWith with class object → disjointWith", () => {
    expect(classifyAxiom(OWL_DISJOINT_WITH, true)).toBe("disjointWith");
  });

  it("owl:disjointWith with non-class object → dataProperty", () => {
    expect(classifyAxiom(OWL_DISJOINT_WITH, false)).toBe("dataProperty");
  });

  it("owl:equivalentClass with class object → equivalentClass", () => {
    expect(classifyAxiom(OWL_EQUIVALENT_CLASS, true)).toBe("equivalentClass");
  });

  it("unknown predicate with non-class object → dataProperty", () => {
    expect(classifyAxiom("http://example.org/foo", false)).toBe("dataProperty");
  });
});

describe("buildEntailmentProbe", () => {
  it("subClassOf probe generates complement class + witness", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/A",
      RDFS_SUBCLASSOF,
      "http://ex.org/B",
      true,
    );
    expect(plan.kind).toBe("subClassOf");
    expect(plan.probeQuads).toHaveLength(4);
    expect(plan.probeKeys.size).toBe(4);
    const preds = plan.probeQuads.map((q) => q.predicate.value);
    expect(preds).toContain(RDF_TYPE);
    expect(preds).toContain("http://www.w3.org/2002/07/owl#complementOf");
    // Probe fix (0.9.5): no global axiom A subClassOf not-B, only a fresh named witness typed A and not-B,
    // so individuals of the record cannot take part in the contradiction.
    expect(preds).not.toContain(RDFS_SUBCLASSOF);
    const witnessTypes = plan.probeQuads.filter((q) => q.subject.value.startsWith("urn:vg:witness:") && q.predicate.value === RDF_TYPE);
    expect(witnessTypes.map((q) => q.object.value)).toContain("http://ex.org/A");
    expect(witnessTypes).toHaveLength(2);
  });

  it("rdf:type probe generates complement class assertion", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/alice",
      RDF_TYPE,
      "http://ex.org/Person",
      true,
    );
    expect(plan.kind).toBe("type");
    expect(plan.probeQuads).toHaveLength(3);
    expect(plan.probeKeys.size).toBe(3);
  });

  it("unsupported predicate returns empty probeQuads", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/a",
      "http://ex.org/unknown",
      "http://ex.org/b",
      true,
    );
    expect(plan.kind).toBe("unsupported");
    expect(plan.probeQuads).toHaveLength(0);
    expect(plan.reason).toBeDefined();
  });

  it("literal object returns dataProperty", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/a",
      RDFS_SUBCLASSOF,
      "http://ex.org/b",
      false,
    );
    expect(plan.kind).toBe("dataProperty");
  });

  it("probeKeys match generated quad term values", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/A",
      RDFS_SUBCLASSOF,
      "http://ex.org/B",
      true,
      "test1",
    );
    for (const q of plan.probeQuads) {
      const key = tripleKey(q.subject.value, q.predicate.value, q.object.value);
      expect(plan.probeKeys.has(key)).toBe(true);
    }
  });
});

describe("property assertion probes (nominals)", () => {
  const OWL = "http://www.w3.org/2002/07/owl#";
  const R = "http://ex.org/R";

  it("classifyAxiom: declared object / data property → assertion kinds; undeclared stays as before", () => {
    expect(classifyAxiom(R, true, "object")).toBe("objectPropertyAssertion");
    expect(classifyAxiom(R, false, "data")).toBe("dataPropertyAssertion");
    expect(classifyAxiom(R, true)).toBe("unsupported");
    expect(classifyAxiom(R, false)).toBe("dataProperty");
    // schema predicates keep their kinds even when a property type is passed
    expect(classifyAxiom(RDF_TYPE, true, "object")).toBe("type");
    expect(classifyAxiom(OWL_SAME_AS, true, "object")).toBe("sameAs");
  });

  it("object property R(a,b): a rdf:type not (R value b)", () => {
    const plan = buildEntailmentProbe("http://ex.org/a", R, "http://ex.org/b", true, "op1", { propertyType: "object" });
    expect(plan.kind).toBe("objectPropertyAssertion");
    expect(plan.probeQuads).toHaveLength(6);
    const by = (p: string) => plan.probeQuads.filter((q) => q.predicate.value === p);
    const assertion = by(RDF_TYPE).find((q) => q.subject.value === "http://ex.org/a")!;
    expect(assertion.object.termType).toBe("BlankNode");
    const comp = by(`${OWL}complementOf`)[0];
    expect(comp.subject.value).toBe(assertion.object.value);
    const restriction = comp.object.value;
    expect(by(`${OWL}onProperty`)[0]).toMatchObject({ subject: { value: restriction }, object: { value: R } });
    const hv = by(`${OWL}hasValue`)[0];
    expect(hv.subject.value).toBe(restriction);
    expect(hv.object.termType).toBe("NamedNode");
    expect(hv.object.value).toBe("http://ex.org/b");
    expect(by(RDF_TYPE).map((q) => q.object.value)).toEqual(expect.arrayContaining([`${OWL}Class`, `${OWL}Restriction`]));
    // no global axiom: the probe only types the subject individual
    expect(plan.probeQuads.filter((q) => q.subject.termType === "NamedNode")).toHaveLength(1);
  });

  it("data property P(a,v): the literal keeps its datatype or language", () => {
    const XSD_INT = "http://www.w3.org/2001/XMLSchema#integer";
    const typed = buildEntailmentProbe("http://ex.org/a", R, "42", false, "dp1", { propertyType: "data", objectDatatype: XSD_INT });
    expect(typed.kind).toBe("dataPropertyAssertion");
    const lit = typed.probeQuads.find((q) => q.predicate.value === `${OWL}hasValue`)!.object as any;
    expect(lit.termType).toBe("Literal");
    expect(lit.value).toBe("42");
    expect(lit.datatype.value).toBe(XSD_INT);
    const lang = buildEntailmentProbe("http://ex.org/a", R, "Eisen", false, "dp2", { propertyType: "data", objectLanguage: "de" });
    expect((lang.probeQuads.find((q) => q.predicate.value === `${OWL}hasValue`)!.object as any).language).toBe("de");
    const plain = buildEntailmentProbe("http://ex.org/a", R, "x", false, "dp3", { propertyType: "data" });
    expect((plain.probeQuads.find((q) => q.predicate.value === `${OWL}hasValue`)!.object as any).datatype.value)
      .toBe("http://www.w3.org/2001/XMLSchema#string");
  });

  it("probe keys cover every probe quad and differ per probe id", () => {
    const p1 = buildEntailmentProbe("http://ex.org/a", R, "http://ex.org/b", true, "k1", { propertyType: "object" });
    const p2 = buildEntailmentProbe("http://ex.org/a", R, "http://ex.org/b", true, "k2", { propertyType: "object" });
    for (const q of p1.probeQuads) expect(p1.probeKeys.has(tripleKey(q.subject.value, q.predicate.value, q.object.value))).toBe(true);
    expect(p1.probeKeys.size).toBe(6);
    expect([...p1.probeKeys].some((k) => p2.probeKeys.has(k))).toBe(false);
  });

  it("without a property type an IRI-object assertion stays unsupported (no probe)", () => {
    const plan = buildEntailmentProbe("http://ex.org/a", R, "http://ex.org/b", true, "u1");
    expect(plan.kind).toBe("unsupported");
    expect(plan.probeQuads).toHaveLength(0);
  });
});
