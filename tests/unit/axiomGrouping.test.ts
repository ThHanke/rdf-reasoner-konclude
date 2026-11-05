import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import { groupJustification } from "../../ts/axiomGrouping.js";

const { namedNode: n, blankNode: b, quad, literal, defaultGraph } = DataFactory;
const EX = "http://ex.org/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const A = n(`${EX}A`), B = n(`${EX}B`), C = n(`${EX}C`), P = n(`${EX}p`);
const type = n(`${RDF}type`), subClassOf = n(`${RDFS}subClassOf`);
const INFERRED = "urn:konclude:inferred";
const ignore = new Set([INFERRED]);

function storeOf(...qs: ReturnType<typeof quad>[]): Store {
  const s = new Store();
  s.addQuads(qs);
  return s;
}

describe("groupJustification", () => {
  it("moves declarations to context and never into axioms", () => {
    const decl = quad(A, type, n(`${OWL}Class`));
    const ax = quad(A, subClassOf, B);
    const s = storeOf(decl, ax);
    const r = groupJustification([decl, ax], s, ignore);
    expect(r.context).toEqual([decl]);
    expect(r.axioms).toHaveLength(1);
    expect(r.axioms[0].principal).toBe(ax);
    expect(r.axioms[0].quads).toEqual([ax]);
  });

  it("keeps ABox class assertions as axioms (only owl declarations are context)", () => {
    const a = quad(n(`${EX}x`), type, A);
    const r = groupJustification([a], storeOf(a), ignore);
    expect(r.axioms.map(x => x.principal)).toEqual([a]);
    expect(r.context).toEqual([]);
  });

  it("groups a restriction axiom into one unit of 4 triples from the store, even if the justification holds only the principal", () => {
    const r1 = b("r1");
    const principal = quad(A, subClassOf, r1);
    const rest = [
      quad(r1, type, n(`${OWL}Restriction`)),
      quad(r1, n(`${OWL}onProperty`), P),
      quad(r1, n(`${OWL}maxCardinality`), literal("1", n("http://www.w3.org/2001/XMLSchema#nonNegativeInteger"))),
    ];
    const s = storeOf(principal, ...rest);
    const res = groupJustification([principal], s, ignore);
    expect(res.axioms).toHaveLength(1);
    expect(res.axioms[0].principal).toBe(principal);
    expect(res.axioms[0].quads).toHaveLength(4);
  });

  it("does not double-count blank-subject triples that are also in the justification", () => {
    const r1 = b("r1");
    const principal = quad(A, subClassOf, r1);
    const t1 = quad(r1, type, n(`${OWL}Restriction`));
    const t2 = quad(r1, n(`${OWL}onProperty`), P);
    const s = storeOf(principal, t1, t2);
    const res = groupJustification([principal, t1, t2], s, ignore);
    expect(res.axioms).toHaveLength(1);
    expect(res.axioms[0].quads).toHaveLength(3);
  });

  it("follows RDF list cells of an intersection", () => {
    const i = b("i"), l1 = b("l1"), l2 = b("l2");
    const nil = n(`${RDF}nil`), first = n(`${RDF}first`), restP = n(`${RDF}rest`);
    const principal = quad(C, n(`${OWL}equivalentClass`), i);
    const qs = [
      principal,
      quad(i, type, n(`${OWL}Class`)),
      quad(i, n(`${OWL}intersectionOf`), l1),
      quad(l1, first, A), quad(l1, restP, l2),
      quad(l2, first, B), quad(l2, restP, nil),
    ];
    const res = groupJustification([principal], storeOf(...qs), ignore);
    expect(res.axioms).toHaveLength(1);
    expect(res.axioms[0].quads).toHaveLength(7);
  });

  it("includes every graph copy of a triple and excludes ignored graphs", () => {
    const g1 = quad(A, subClassOf, B, n("urn:g1"));
    const g2 = quad(A, subClassOf, B, n("urn:g2"));
    const inf = quad(A, subClassOf, B, n(INFERRED));
    const s = storeOf(g1, g2, inf);
    const res = groupJustification([g1, g2], s, ignore);
    expect(res.axioms).toHaveLength(1);
    expect(res.axioms[0].principal).toBe(g1);
    const graphs = res.axioms[0].quads.map(q => q.graph.value).sort();
    expect(graphs).toEqual(["urn:g1", "urn:g2"]);
  });

  it("falls back to singletons when a blank node is shared between two roots", () => {
    const shared = b("s");
    const x = quad(A, subClassOf, shared);
    const y = quad(B, subClassOf, shared);
    const t = quad(shared, type, n(`${OWL}Restriction`));
    const s = storeOf(x, y, t);
    const res = groupJustification([x, y, t], s, ignore);
    expect(res.axioms).toHaveLength(3);
    expect(res.axioms.every(a => a.quads.length === 1)).toBe(true);
  });

  it("keeps an orphan blank-subject triple as its own axiom", () => {
    const orphan = quad(b("o"), type, A);
    const res = groupJustification([orphan], storeOf(orphan), ignore);
    expect(res.axioms).toHaveLength(1);
    expect(res.axioms[0].principal).toBe(orphan);
  });

  it("handles the default graph", () => {
    const ax = quad(A, subClassOf, B, defaultGraph());
    const res = groupJustification([ax], storeOf(ax), ignore);
    expect(res.axioms[0].quads).toHaveLength(1);
  });
});
