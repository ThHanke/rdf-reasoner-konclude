import { describe, expect, it } from "vitest";
import { buildEntailmentProbe, classifyAxiom, tripleKey } from "../../ts/entailmentProbe.js";

const RDFS_SUBCLASSOF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

describe("classifyAxiom", () => {
  it("subClassOf with class object → subClassOf", () => {
    expect(classifyAxiom(RDFS_SUBCLASSOF, true)).toBe("subClassOf");
  });

  it("rdf:type with class object → type", () => {
    expect(classifyAxiom(RDF_TYPE, true)).toBe("type");
  });

  it("literal object → unsupported", () => {
    expect(classifyAxiom(RDFS_SUBCLASSOF, false)).toBe("unsupported");
  });

  it("unknown predicate → unsupported", () => {
    expect(classifyAxiom("http://example.org/foo", true)).toBe("unsupported");
  });
});

describe("buildEntailmentProbe", () => {
  it("subClassOf probe generates complement class + witness", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/A", RDFS_SUBCLASSOF, "http://ex.org/B", true,
    );
    expect(plan.kind).toBe("subClassOf");
    expect(plan.probeQuads).toHaveLength(4);
    expect(plan.probeKeys.size).toBe(4);
    const preds = plan.probeQuads.map(q => q.predicate.value);
    expect(preds).toContain(RDF_TYPE);
    expect(preds).toContain("http://www.w3.org/2002/07/owl#complementOf");
    expect(preds).toContain(RDFS_SUBCLASSOF);
  });

  it("rdf:type probe generates complement class assertion", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/alice", RDF_TYPE, "http://ex.org/Person", true,
    );
    expect(plan.kind).toBe("type");
    expect(plan.probeQuads).toHaveLength(3);
    expect(plan.probeKeys.size).toBe(3);
  });

  it("unsupported predicate returns empty probeQuads", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/a", "http://ex.org/unknown", "http://ex.org/b", true,
    );
    expect(plan.kind).toBe("unsupported");
    expect(plan.probeQuads).toHaveLength(0);
    expect(plan.reason).toBeDefined();
  });

  it("literal object returns unsupported", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/a", RDFS_SUBCLASSOF, "http://ex.org/b", false,
    );
    expect(plan.kind).toBe("unsupported");
  });

  it("probeKeys match generated quad term values", () => {
    const plan = buildEntailmentProbe(
      "http://ex.org/A", RDFS_SUBCLASSOF, "http://ex.org/B", true, "test1",
    );
    for (const q of plan.probeQuads) {
      const key = tripleKey(q.subject.value, q.predicate.value, q.object.value);
      expect(plan.probeKeys.has(key)).toBe(true);
    }
  });
});
