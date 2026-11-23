import { describe, expect, it } from "vitest";
import { Parser } from "n3";
import { planConclusion, existsProbeQuads } from "../../ts/entailmentGraph.js";

const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
const parse = (s: string) => new Parser().parse(PRE + s);
const noAnn = () => false;

describe("planConclusion", () => {
  it("a named triple is a plain statement, an annotation triple an annotation statement", () => {
    const p = planConclusion(parse(`:a :p :b . :c rdfs:comment "hello" .`), noAnn);
    expect(p).toMatchObject({ ok: true });
    if (p.ok) expect(p.statements.map((s) => s.kind)).toEqual(["quad", "annotation"]);
  });

  it("an annotation property declared in the conclusion is recognised", () => {
    const p = planConclusion(parse(`:ap a owl:AnnotationProperty . :a :ap "v" .`), noAnn);
    if (p.ok) expect(p.statements.map((s) => s.kind)).toContain("annotation");
    else throw new Error(p.reason);
  });

  it("s p _:x with an untyped blank node is exists p . Thing (W3C somevaluesfrom2bnode)", () => {
    const p = planConclusion(parse(`:a :p _:x .`), noAnn);
    expect(p).toEqual({ ok: true, statements: [{ kind: "exists", subject: "http://ex.org/a", property: "http://ex.org/p", expr: { k: "thing" } }] });
  });

  it("a chain fred parent _:x1 . _:x1 parent _:x2 becomes nested exists (W3C someValuesFrom-003)", () => {
    const p = planConclusion(parse(`:fred :parent _:x1 . _:x1 :parent _:x2 . _:x2 a owl:Thing .`), noAnn);
    expect(p).toMatchObject({ ok: true });
    if (p.ok) expect(p.statements[0]).toMatchObject({ kind: "exists", expr: { k: "some", property: "http://ex.org/parent", expr: { k: "thing" } } });
  });

  it("types and a named property value of the blank node are intersected", () => {
    const p = planConclusion(parse(`:a :p _:x . _:x a :C . _:x :q :b .`), noAnn);
    expect(p).toMatchObject({ ok: true });
    if (p.ok && p.statements[0]!.kind === "exists") expect(p.statements[0].expr).toMatchObject({ k: "and" });
  });

  it("gives up on joins, cycles, free-standing blank nodes and anonymous types", () => {
    expect(planConclusion(parse(`:a :p _:x . :b :p _:x .`), noAnn)).toMatchObject({ ok: false });
    expect(planConclusion(parse(`:a :p _:x . _:x :p _:x .`), noAnn)).toMatchObject({ ok: false });
    expect(planConclusion(parse(`_:y a :C .`), noAnn)).toMatchObject({ ok: false });
    expect(planConclusion(parse(`:a a [ a owl:Restriction ] .`), noAnn)).toMatchObject({ ok: false });
    expect(planConclusion([], noAnn)).toMatchObject({ ok: false });
  });
});

describe("existsProbeQuads", () => {
  it("builds s : not (exists p . D) with deterministic blank node labels", () => {
    const p = planConclusion(parse(`:a :p _:x . _:x a :C .`), noAnn);
    if (!p.ok || p.statements[0]!.kind !== "exists") throw new Error("plan");
    const a = existsProbeQuads(p.statements[0], "g1");
    const b = existsProbeQuads(p.statements[0], "g1");
    expect(a.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`)).toEqual(b.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`));
    expect(a.some((q) => q.predicate.value.endsWith("complementOf"))).toBe(true);
    expect(a.some((q) => q.predicate.value.endsWith("someValuesFrom"))).toBe(true);
    expect(a.every((q) => q.subject.termType === "BlankNode" || q.subject.value === "http://ex.org/a")).toBe(true);
  });
});
