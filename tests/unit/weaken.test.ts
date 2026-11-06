import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import { computeWeakenings, parseCulprit, subClassAxiomQuads } from "../../ts/weaken.js";
import type { AssessOracle } from "../../ts/assessEdit.js";
import type { Axiom } from "../../ts/types.js";

const { namedNode: n, quad } = DataFactory;
const EX = "http://ex.org/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const c = (name: string) => n(`${EX}${name}`);
const subClassOf = n(`${RDFS}subClassOf`), disjointWith = n(`${OWL}disjointWith`), type = n(`${RDF}type`);
const G = n("urn:g");
const sub = (x: string, y: string) => quad(c(x), subClassOf, c(y));
const disj = (x: string, y: string) => quad(c(x), disjointWith, c(y));
const inst = (i: string, t: string) => quad(c(i), type, c(t));
const iri = (name: string) => `${EX}${name}`;
const shape = (subject: string) => ({ subject: iri(subject), graph: n("") as never });

/** The culprit axiom `x subClassOf (conjuncts...)` as an Axiom (principal first). */
const culpritOf = (x: string, conjuncts: string[]): Axiom => {
  const quads = subClassAxiomQuads({ subject: iri(x), graph: DataFactory.defaultGraph() }, conjuncts.map(iri));
  return { principal: quads[0], quads };
};

/** Fake reasoner: subclass closure (named edges and intersection members), asserted disjointness inherited downwards. */
function fakeOracle(opts?: { abortAfter?: number; noHierarchy?: boolean }): AssessOracle {
  let calls = 0;
  const aborted = () => opts?.abortAfter !== undefined && ++calls > opts.abortAfter;
  const edges = (qs: Quad[]) => {
    const bySubject = new Map<string, Quad[]>();
    for (const q of qs) bySubject.set(q.subject.value, [...(bySubject.get(q.subject.value) ?? []), q]);
    const up = new Map<string, Set<string>>();
    const add = (x: string, y: string) => (up.get(x) ?? up.set(x, new Set()).get(x)!).add(y);
    for (const q of qs) {
      if (q.predicate.value !== subClassOf.value || q.subject.termType !== "NamedNode") continue;
      if (q.object.termType === "NamedNode") add(q.subject.value, q.object.value);
      else {
        let cell = (bySubject.get(q.object.value) ?? []).find(t => t.predicate.value === `${OWL}intersectionOf`)?.object.value;
        while (cell && cell !== `${RDF}nil`) {
          const cq = bySubject.get(cell) ?? [];
          const first = cq.find(t => t.predicate.value === `${RDF}first`);
          if (first) add(q.subject.value, first.object.value);
          cell = cq.find(t => t.predicate.value === `${RDF}rest`)?.object.value;
        }
      }
    }
    const closure = (x: string): Set<string> => {
      const out = new Set([x]);
      const stack = [x];
      while (stack.length) for (const s of up.get(stack.pop()!) ?? []) if (!out.has(s)) { out.add(s); stack.push(s); }
      return out;
    };
    return { up, closure };
  };
  const disjointPairs = (qs: Quad[]) => qs.filter(q => q.predicate.value === disjointWith.value).map(q => [q.subject.value, q.object.value] as const);
  const clashIn = (types: Set<string>, pairs: ReadonlyArray<readonly [string, string]>) => pairs.some(([p, q]) => types.has(p) && types.has(q));
  return {
    async inconsistent(qs) {
      if (aborted()) return "aborted";
      const { closure } = edges(qs);
      const pairs = disjointPairs(qs);
      return qs.filter(q => q.predicate.value === type.value && q.object.value.startsWith(EX)).some(q => clashIn(closure(q.object.value), pairs));
    },
    async unsatisfiable(qs) {
      if (aborted()) return "aborted";
      const { up, closure } = edges(qs);
      const pairs = disjointPairs(qs);
      return new Set([...up.keys()].filter(x => clashIn(closure(x), pairs)));
    },
    async subClassPairs(qs) {
      if (aborted()) return "aborted";
      if (opts?.noHierarchy) return [];
      const { up, closure } = edges(qs);
      return [...up.keys()].flatMap(x => [...closure(x)].filter(y => y !== x).map(y => [x, y] as [string, string]));
    },
  };
}

const run = (base: Quad[], culprit: Axiom, oracle = fakeOracle()) => computeWeakenings({ base, culprit, oracle, deadline: Infinity });
const names = (r: Awaited<ReturnType<typeof run>>) => r.weakenings.map(w => `${w.strategy}${w.change ? `:${w.change.from.slice(EX.length)}>${w.change.to?.slice(EX.length) ?? "-"}` : ""}`);

describe("parseCulprit", () => {
  it("reads a named subclass axiom and an intersection of named classes", () => {
    expect(parseCulprit(culpritOf("A", ["B"]))).toMatchObject({ subject: iri("A"), conjuncts: [iri("B")] });
    expect(parseCulprit(culpritOf("A", ["B", "E", "F"]))?.conjuncts).toEqual([iri("B"), iri("E"), iri("F")]);
  });

  it("rejects other shapes", () => {
    const eq: Axiom = { principal: quad(c("A"), n(`${OWL}equivalentClass`), c("B")), quads: [quad(c("A"), n(`${OWL}equivalentClass`), c("B"))] };
    expect(parseCulprit(eq)).toBeNull();
    const blankSubject = culpritOf("A", ["B"]);
    expect(parseCulprit({ principal: quad(DataFactory.blankNode("x"), subClassOf, c("B")), quads: blankSubject.quads })).toBeNull();
  });

  it("rejects an axiom whose blank node is not a plain intersection of named classes", () => {
    const quads = culpritOf("A", ["B", "E"]).quads;
    const extra = [...quads, quad(DataFactory.blankNode("z"), type, c("Q"))];
    expect(parseCulprit({ principal: extra[0], quads: extra })).toBeNull();
  });
});

describe("computeWeakenings", () => {
  // A subClassOf (B and E), B disjointWith E, instance a:A; B below C, E below F
  const intersectionBase = () => {
    const culprit = culpritOf("A", ["B", "E"]);
    return { culprit, base: [...culprit.quads, disj("B", "E"), sub("B", "C"), sub("E", "F"), inst("a", "A")] };
  };

  it("offers generalizations, dropped conjuncts and the deletion, in that order, all verified", async () => {
    const { culprit, base } = intersectionBase();
    const r = await run(base, culprit);
    expect(r.incomplete).toBe(false);
    expect(names(r)).toEqual(["generalize:B>C", "generalize:E>F", "dropConjunct:B>-", "dropConjunct:E>-", "delete"]);
    expect(r.weakenings.every(w => w.verifiedConsistent === true)).toBe(true);
    expect(r.weakenings.every(w => w.remove === culprit.quads)).toBe(true);
    expect(r.weakenings.at(-1)!.add).toEqual([]);
  });

  it("a generalization keeps the other conjuncts in place: A subClassOf (C and E)", async () => {
    const { culprit, base } = intersectionBase();
    const g = (await run(base, culprit)).weakenings[0];
    const members = g.add.filter(q => q.predicate.value === `${RDF}first`).map(q => q.object.value);
    expect(members).toEqual([iri("C"), iri("E")]);
  });

  it("a dropped conjunct of two leaves a plain subclass axiom", async () => {
    const { culprit, base } = intersectionBase();
    const drop = (await run(base, culprit)).weakenings.find(w => w.change?.from === iri("B") && w.change.to === null)!;
    expect(drop.add).toHaveLength(1);
    expect(drop.add[0].object.value).toBe(iri("E"));
  });

  it("returns only the most specific working superclass: everything above it is pruned", async () => {
    // A subClassOf B; A subClassOf D; B disjoint D; B below C below G, C not disjoint D
    const culprit = culpritOf("A", ["B"]);
    const base = [...culprit.quads, sub("A", "D"), disj("B", "D"), sub("B", "C"), sub("C", "G"), inst("a", "A")];
    expect(names(await run(base, culprit))).toEqual(["generalize:B>C", "delete"]);
  });

  it("walks upward past a failing superclass to the next working one", async () => {
    // as above but C is disjoint from D as well: C fails, G works
    const culprit = culpritOf("A", ["B"]);
    const base = [...culprit.quads, sub("A", "D"), disj("B", "D"), disj("C", "D"), sub("B", "C"), sub("C", "G"), inst("a", "A")];
    expect(names(await run(base, culprit))).toEqual(["generalize:B>G", "delete"]);
  });

  it("a class without instances: consistency alone would pass, the target class must stay satisfiable", async () => {
    // no individual: the ontology is consistent with or without the culprit, but A is unsatisfiable with it
    const culprit = culpritOf("A", ["B"]);
    const base = [...culprit.quads, sub("A", "D"), disj("B", "D"), sub("B", "C"), disj("C", "D"), sub("C", "G")];
    expect(names(await run(base, culprit))).toEqual(["generalize:B>G", "delete"]);
  });

  it("skips a superclass that is already entailed without the culprit", async () => {
    // A subClassOf C is asserted elsewhere, so replacing B by C adds nothing the deletion does not
    const culprit = culpritOf("A", ["B"]);
    const base = [...culprit.quads, sub("A", "C"), sub("B", "C")];
    expect(names(await run(base, culprit))).toEqual(["delete"]);
  });

  it("without a hierarchy only the deletion is offered", async () => {
    const { culprit, base } = intersectionBase();
    const r = await run(base, culprit, fakeOracle({ noHierarchy: true }));
    expect(names(r).filter(x => x.startsWith("generalize"))).toEqual([]);
    expect(names(r).at(-1)).toBe("delete");
  });

  it("culprit not in the store", async () => {
    const { culprit } = intersectionBase();
    const r = await run([sub("X", "Y")], culprit);
    expect(r).toMatchObject({ weakenings: [], reason: "culprit-not-in-store", incomplete: false });
  });

  it("removing the culprit alone does not restore consistency", async () => {
    const { culprit, base } = intersectionBase();
    // another, unrelated clash: BE is below the disjoint B and E and has an instance
    const r = await run([...base, sub("BE", "B"), sub("BE", "E"), inst("b", "BE")], culprit);
    expect(r).toMatchObject({ weakenings: [], reason: "removal-does-not-restore-consistency" });
  });

  it("an unsupported culprit shape returns an empty list", async () => {
    const eq: Axiom = { principal: quad(c("A"), n(`${OWL}equivalentClass`), c("B")), quads: [quad(c("A"), n(`${OWL}equivalentClass`), c("B"))] };
    const r = await run([eq.principal], eq);
    expect(r).toMatchObject({ weakenings: [], reason: "unsupported-axiom" });
  });

  it("a deadline at the very start returns nothing, incomplete", async () => {
    const { culprit, base } = intersectionBase();
    const r = await run(base, culprit, fakeOracle({ abortAfter: 0 }));
    expect(r).toMatchObject({ weakenings: [], incomplete: true, reason: "deadline" });
  });

  it("a deadline during the search keeps what was verified and the deletion", async () => {
    const { culprit, base } = intersectionBase();
    const r = await run(base, culprit, fakeOracle({ abortAfter: 5 }));
    expect(r).toMatchObject({ incomplete: true, reason: "deadline" });
    expect(names(r).at(-1)).toBe("delete");
  });

  it("owl:Thing is never offered as a replacement", async () => {
    const culprit = culpritOf("A", ["B"]);
    const base = [...culprit.quads, quad(c("B"), subClassOf, n(`${OWL}Thing`)), inst("a", "A")];
    expect(names(await run(base, culprit))).toEqual(["delete"]);
  });

  it("subClassAxiomQuads builds a well-formed intersection in the given graph", () => {
    const quads = subClassAxiomQuads({ subject: iri("A"), graph: G }, [iri("B"), iri("C"), iri("D")]);
    expect(quads.every(q => q.graph.equals(G))).toBe(true);
    expect(quads.filter(q => q.predicate.value === `${RDF}first`)).toHaveLength(3);
    expect(quads.filter(q => q.object.value === `${RDF}nil`)).toHaveLength(1);
    expect(shape("A").subject).toBe(iri("A"));
  });
});
