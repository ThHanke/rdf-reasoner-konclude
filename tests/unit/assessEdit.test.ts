import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import { assertedDisjointPairs, computeAssessment, probeQuads, PROBE_NS, MAX_PAIRS, type AssessOracle } from "../../ts/assessEdit.js";

const { namedNode: n, blankNode: b, quad, literal } = DataFactory;
const EX = "http://ex.org/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const c = (name: string) => n(`${EX}${name}`);
const disjointWith = n(`${OWL}disjointWith`), subClassOf = n(`${RDFS}subClassOf`), type = n(`${RDF}type`);
const iri = (name: string) => `${EX}${name}`;

/** Fake reasoner: inconsistent iff an individual has two types that are entailed disjoint; disjointness is entailed
 *  from asserted owl:disjointWith through the transitive subclass closure of the quad set. */
function fakeOracle(opts?: { abortAfter?: number }): AssessOracle {
  let calls = 0;
  const supers = (qs: Quad[]) => {
    const direct = new Map<string, Set<string>>();
    for (const q of qs) if (q.predicate.value === subClassOf.value) (direct.get(q.subject.value) ?? direct.set(q.subject.value, new Set()).get(q.subject.value)!).add(q.object.value);
    const closure = (x: string): Set<string> => {
      const out = new Set([x]);
      const stack = [x];
      while (stack.length) for (const s of direct.get(stack.pop()!) ?? []) if (!out.has(s)) { out.add(s); stack.push(s); }
      return out;
    };
    return closure;
  };
  const disjoint = (qs: Quad[]) => {
    const closure = supers(qs);
    const asserted = qs.filter(q => q.predicate.value === disjointWith.value);
    return (x: string, y: string) => asserted.some(d => (closure(x).has(d.subject.value) && closure(y).has(d.object.value)) || (closure(x).has(d.object.value) && closure(y).has(d.subject.value)));
  };
  const tick = () => (opts?.abortAfter !== undefined && ++calls > opts.abortAfter ? "aborted" : null);
  return {
    async inconsistent(qs) {
      if (tick()) return "aborted";
      const isDisjoint = disjoint(qs);
      const typesOf = new Map<string, string[]>();
      for (const q of qs) if (q.predicate.value === type.value && q.object.value.startsWith(EX)) (typesOf.get(q.subject.value) ?? typesOf.set(q.subject.value, []).get(q.subject.value)!).push(q.object.value);
      return [...typesOf.values()].some(ts => ts.some((x, i) => ts.slice(i + 1).some(y => isDisjoint(x, y))));
    },
    async unsatisfiable(qs) {
      if (tick()) return "aborted";
      const isDisjoint = disjoint(qs);
      const out = new Set<string>();
      for (const q of qs.filter(x => x.subject.value.startsWith(PROBE_NS) && x.predicate.value === subClassOf.value)) {
        const probe = q.subject.value;
        const ends = qs.filter(x => x.subject.value === probe && x.predicate.value === subClassOf.value).map(x => x.object.value);
        if (ends.length === 2 && isDisjoint(ends[0], ends[1])) out.add(probe);
      }
      return out;
    },
    async subClassPairs(qs) {
      if (tick()) return "aborted";
      const closure = supers(qs);
      const names = new Set(qs.filter(q => q.predicate.value === subClassOf.value).map(q => q.subject.value));
      return [...names].flatMap(x => [...closure(x)].filter(y => y !== x).map(y => [x, y] as [string, string]));
    },
  };
}

const AB = [c("A"), c("B")] as const;
const clash = () => [quad(AB[0], disjointWith, AB[1]), quad(c("ind"), type, AB[0]), quad(c("ind"), type, AB[1])];
const run = (base: Quad[], edit: Parameters<typeof computeAssessment>[0]["edit"], opts?: Parameters<typeof computeAssessment>[0]["opts"], oracle = fakeOracle()) =>
  computeAssessment({ base, edit, opts, oracle });

describe("assertedDisjointPairs", () => {
  it("reads owl:disjointWith, ordered a < b and deduplicated", () => {
    const pairs = assertedDisjointPairs([quad(c("B"), disjointWith, c("A")), quad(c("A"), disjointWith, c("B"))]);
    expect(pairs).toEqual([{ a: iri("A"), b: iri("B") }]);
  });

  it("expands AllDisjointClasses and disjointUnionOf member lists pairwise", () => {
    const h = b("h"), l1 = b("l1"), l2 = b("l2"), l3 = b("l3");
    const first = n(`${RDF}first`), rest = n(`${RDF}rest`), nil = n(`${RDF}nil`);
    const adc = [quad(h, type, n(`${OWL}AllDisjointClasses`)), quad(h, n(`${OWL}members`), l1), quad(l1, first, c("X")), quad(l1, rest, l2), quad(l2, first, c("Y")), quad(l2, rest, l3), quad(l3, first, c("Z")), quad(l3, rest, nil)];
    expect(assertedDisjointPairs(adc)).toHaveLength(3);
    const k1 = b("k1"), k2 = b("k2");
    const du = [quad(c("U"), n(`${OWL}disjointUnionOf`), k1), quad(k1, first, c("P")), quad(k1, rest, k2), quad(k2, first, c("Q")), quad(k2, rest, nil)];
    expect(assertedDisjointPairs(du)).toEqual([{ a: iri("P"), b: iri("Q") }]);
  });

  it("ignores non-class endpoints and members lists of other nodes", () => {
    const pairs = assertedDisjointPairs([quad(c("A"), disjointWith, b("anon")), quad(c("A"), disjointWith, literal("x")), quad(b("h"), n(`${OWL}members`), b("l"))]);
    expect(pairs).toEqual([]);
  });
});

describe("computeAssessment", () => {
  it("removing the disjointness axiom of an inconsistent store restores consistency and loses the pair", async () => {
    const base = clash();
    const r = await run(base, { remove: [base[0]] });
    expect(r).toMatchObject({ consistent: true, incomplete: false, unmatchedRemovals: [] });
    expect(r.lostDisjointPairs).toEqual([{ a: iri("A"), b: iri("B") }]);
    expect(r.pairsChecked).toHaveLength(1);
  });

  it("removing a type assertion instead keeps the disjointness: consistent, nothing lost", async () => {
    const base = clash();
    const r = await run(base, { remove: [base[1]] });
    expect(r.consistent).toBe(true);
    expect(r.lostDisjointPairs).toEqual([]);
  });

  it("an edit that does not restore consistency reports null and the pairs it would have tested", async () => {
    const base = [...clash(), quad(c("ind2"), type, AB[0]), quad(c("ind2"), type, AB[1])];
    const r = await run(base, { remove: [base[1]] });
    expect(r).toMatchObject({ consistent: false, lostDisjointPairs: null, reason: "edited-inconsistent", incomplete: false });
    expect(r.pairsChecked).toHaveLength(1);
  });

  it("reports removals that matched no quad and leaves the result unchanged for them", async () => {
    const base = clash();
    const ghost = quad(c("ghost"), type, c("A"));
    const r = await run(base, { remove: [ghost] });
    expect(r.unmatchedRemovals).toEqual([ghost]);
    expect(r.consistent).toBe(false);
  });

  it("removal is by exact identity including the graph", async () => {
    const base = clash();
    const otherGraph = quad(base[0].subject, base[0].predicate, base[0].object, n("urn:other"));
    const r = await run(base, { remove: [otherGraph] });
    expect(r.unmatchedRemovals).toEqual([otherGraph]);
    expect(r.consistent).toBe(false);
  });

  it("additions are applied", async () => {
    const base = [quad(AB[0], disjointWith, AB[1]), quad(c("ind"), type, AB[0])];
    const r = await run(base, { add: [quad(c("ind"), type, AB[1])] });
    expect(r.consistent).toBe(false);
  });

  it("deriveFromHierarchy protects the pairs of descendants; removing a subclass axiom loses only those", async () => {
    const base = [quad(c("A"), disjointWith, c("B")), quad(c("C"), subClassOf, c("A")), quad(c("D"), subClassOf, c("B"))];
    const r = await run(base, { remove: [base[1]] }, { deriveFromHierarchy: true });
    expect(r.consistent).toBe(true);
    const names = r.pairsChecked.map(p => `${p.a.slice(EX.length)}-${p.b.slice(EX.length)}`).sort();
    expect(names).toEqual(["A-B", "A-D", "B-C", "C-D"]);
    expect(r.lostDisjointPairs!.map(p => `${p.a.slice(EX.length)}-${p.b.slice(EX.length)}`).sort()).toEqual(["B-C", "C-D"]);
  });

  it("deriveFromHierarchy is ignored when the unedited store is inconsistent", async () => {
    const base = [...clash(), quad(c("C"), subClassOf, c("A"))];
    const r = await run(base, { remove: [base[1]] }, { deriveFromHierarchy: true });
    expect(r.pairsChecked).toEqual([{ a: iri("A"), b: iri("B") }]);
  });

  it("an explicit pairs option replaces the asserted pairs", async () => {
    const base = clash();
    const r = await run(base, { remove: [base[1]] }, { pairs: [{ a: iri("B"), b: iri("A") }, { a: iri("A"), b: iri("Z") }] });
    expect(r.pairsChecked).toHaveLength(2);
    expect(r.pairsChecked[0].a < r.pairsChecked[0].b).toBe(true);
    expect(r.lostDisjointPairs).toEqual([{ a: iri("A"), b: iri("Z") }]);
  });

  it("no pairs to protect: nothing is lost and no probe batch is needed", async () => {
    const r = await run([quad(c("A"), subClassOf, c("B"))], { remove: [] });
    expect(r).toMatchObject({ consistent: true, lostDisjointPairs: [] });
  });

  it("returns incomplete with reason deadline instead of throwing", async () => {
    const base = clash();
    const r = await run(base, { remove: [base[0]] }, undefined, fakeOracle({ abortAfter: 0 }));
    expect(r).toMatchObject({ incomplete: true, reason: "deadline" });
  });

  it("more pairs than the cap: incomplete with reason pair-cap", async () => {
    const many = Array.from({ length: MAX_PAIRS + 1 }, (_, i) => ({ a: iri(`P${i}`), b: iri(`Q${i}`) }));
    const r = await run([], {}, { pairs: many });
    expect(r).toMatchObject({ incomplete: true, reason: "pair-cap" });
  });

  it("probe quads: one fresh class per pair, subclass of both endpoints", () => {
    const qs = probeQuads([{ a: iri("A"), b: iri("B") }]);
    expect(qs).toHaveLength(3);
    expect(qs.every(q => q.subject.value === `${PROBE_NS}0`)).toBe(true);
  });
});
