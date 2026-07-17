import { describe, expect, it } from "vitest";
import { DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import {
  splitAxiom,
  computeLaconicAsync,
  axiomKey,
  groupQuadsIntoAxioms,
} from "../../ts/laconicJustification.js";

const { namedNode, blankNode, quad, defaultGraph } = DataFactory;
const g = defaultGraph();
const mk = (s: string, p: string, o: string) =>
  quad(namedNode(s) as any, namedNode(p) as any, namedNode(o) as any, g) as Quad;
const mkb = (s: string, p: string, o: string) =>
  quad(
    s.startsWith("_:") ? blankNode(s) as any : namedNode(s) as any,
    namedNode(p) as any,
    o.startsWith("_:") ? blankNode(o) as any : namedNode(o) as any,
    g,
  ) as Quad;

const SC = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EQ = "http://www.w3.org/2002/07/owl#equivalentClass";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const INTER = "http://www.w3.org/2002/07/owl#intersectionOf";
const FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
const RESTR = "http://www.w3.org/2002/07/owl#Restriction";
const ON_PROP = "http://www.w3.org/2002/07/owl#onProperty";
const SVF = "http://www.w3.org/2002/07/owl#someValuesFrom";

describe("splitAxiom", () => {
  it("plain SubClassOf → singleton (unchanged)", () => {
    const axiom = [mk("http://ex/A", SC, "http://ex/B")];
    const parts = splitAxiom(axiom);
    expect(parts).toHaveLength(1);
    expect(parts[0][0].subject.value).toBe("http://ex/A");
    expect(parts[0][0].object.value).toBe("http://ex/B");
  });

  it("intersection RHS: A ⊑ B ⊓ C → { A ⊑ B, A ⊑ C }", () => {
    const axiom: Quad[] = [
      mkb("http://ex/A", SC, "_:inter"),
      mkb("_:inter", INTER, "_:list1"),
      mkb("_:list1", FIRST, "http://ex/B"),
      mkb("_:list1", REST, "_:list2"),
      mkb("_:list2", FIRST, "http://ex/C"),
      mkb("_:list2", REST, NIL),
    ];
    const parts = splitAxiom(axiom);
    expect(parts).toHaveLength(2);
    expect(parts[0][0].predicate.value).toBe(SC);
    expect(parts[0][0].object.value).toBe("http://ex/B");
    expect(parts[1][0].predicate.value).toBe(SC);
    expect(parts[1][0].object.value).toBe("http://ex/C");
  });

  it("EquivalentClass: A ≡ B → { A ⊑ B, B ⊑ A }", () => {
    const axiom = [mk("http://ex/A", EQ, "http://ex/B")];
    const parts = splitAxiom(axiom);
    expect(parts).toHaveLength(2);
    const subjects = parts.map(p => p[0].subject.value).sort();
    expect(subjects).toEqual(["http://ex/A", "http://ex/B"]);
    for (const p of parts) {
      expect(p[0].predicate.value).toBe(SC);
    }
  });

  it("unsplittable axiom type → singleton", () => {
    const axiom = [mk("http://ex/a", TYPE, "http://ex/Person")];
    const parts = splitAxiom(axiom);
    expect(parts).toHaveLength(1);
  });

  it("someValuesFrom intersection: A ⊑ ∃R.(B ⊓ C) → { A ⊑ ∃R.B, A ⊑ ∃R.C }", () => {
    const axiom: Quad[] = [
      mkb("http://ex/A", SC, "_:restr"),
      mkb("_:restr", TYPE, RESTR),
      mkb("_:restr", ON_PROP, "http://ex/R"),
      mkb("_:restr", SVF, "_:filler"),
      mkb("_:filler", INTER, "_:fl1"),
      mkb("_:fl1", FIRST, "http://ex/B"),
      mkb("_:fl1", REST, "_:fl2"),
      mkb("_:fl2", FIRST, "http://ex/C"),
      mkb("_:fl2", REST, NIL),
    ];
    const parts = splitAxiom(axiom);
    expect(parts).toHaveLength(2);
  });
});

describe("computeLaconicAsync", () => {
  it("contracts to minimal subset using oracle", async () => {
    const axA = [mk("http://ex/A", SC, "http://ex/B")];
    const axB = [mk("http://ex/B", SC, "http://ex/C")];
    const axC = [mk("http://ex/X", SC, "http://ex/Y")];

    const entails = async (parts: Quad[][]): Promise<boolean> => {
      const keys = new Set(parts.map(axiomKey));
      return keys.has(axiomKey(axA)) && keys.has(axiomKey(axB));
    };

    const result = await computeLaconicAsync([axA, axB, axC], entails);
    expect(result.laconic).toHaveLength(2);
    const laconicKeys = new Set(result.laconic.map(axiomKey));
    expect(laconicKeys.has(axiomKey(axA))).toBe(true);
    expect(laconicKeys.has(axiomKey(axB))).toBe(true);
    expect(laconicKeys.has(axiomKey(axC))).toBe(false);
  });

  it("falls back to original when oracle rejects split", async () => {
    const axiom = [mk("http://ex/A", SC, "http://ex/B")];
    const entails = async () => false;

    const result = await computeLaconicAsync([axiom], entails);
    expect(result.laconic).toHaveLength(1);
    expect(axiomKey(result.laconic[0])).toBe(axiomKey(axiom));
  });
});

describe("groupQuadsIntoAxioms", () => {
  it("groups by principal triple + blank-node closure", () => {
    const quads: Quad[] = [
      mk("http://ex/A", SC, "http://ex/B"),
      mk("http://ex/C", SC, "http://ex/D"),
    ];
    const { axioms } = groupQuadsIntoAxioms(quads);
    expect(axioms).toHaveLength(2);
  });

  it("skips quads with blank-node subjects (they belong to closures)", () => {
    const quads: Quad[] = [
      mkb("http://ex/A", SC, "_:b1"),
      mkb("_:b1", TYPE, RESTR),
    ];
    const { axioms } = groupQuadsIntoAxioms(quads);
    expect(axioms).toHaveLength(1);
    expect(axioms[0]).toHaveLength(2);
  });
});
