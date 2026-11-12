/**
 * Integration test: explainEntailment() after the caller's normal reasoning run (the Ontosphere procedure).
 *
 * explain-entailment-hermit-fesi.test.ts explains on a fresh reasoner. An application reasons first and asks "why"
 * afterwards, on the same reasoner and the same store:
 *
 *   new RdfReasoner({ excludeGraphs: [inferred graph, explanation graph, shapes, provenance, workflows] })
 *   checkConsistency(store)
 *   materialize(store, { includeClassHierarchy: true, inferredGraph, returnDelta: true })
 *   explainEntailment(store, s, p, o, { justificationMode, maxJustifications, inferredGraph })
 *
 * Contract: the answer is the same as on a fresh reasoner, i.e. HermiT's two justifications (Fe-Si case), and no
 * justification contains a triple that exists only in the inferred graph.
 *
 * Measured on 0.9.4 (fresh process each, 8 cores): after materialize, `causal` returns an unrelated axiom
 * (PMD_0010100 subClassOf PMD_0090000) in about 100 ms, and `minimal` returns
 * [some_silicon type PMD_0020050, PMD_0020050 subClassOf PMD_0090000] in about 40 ms, where
 * `PMD_0020050 subClassOf PMD_0090000` is an inferred class-hierarchy edge that is not in the ontology.
 * Without the materialize, `minimal` returns exactly J1 and J2 (about 18 s).
 *
 * Requires the built WASM binary; skipped when it is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";
import type { Quad, Term } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(
  new URL("../../dist/konclude.wasm", import.meta.url).pathname,
);

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const PMD = "https://w3id.org/pmd/co/PMD_";
const OBO = "http://purl.obolibrary.org/obo/";
const SILICON = "http://www.example.org/#some_silicon";
const INFERRED = "urn:vg:inferred";
const SHAPES = "urn:vg:shapes";

const RESTRICTION_KINDS = [
  "someValuesFrom",
  "allValuesFrom",
  "hasValue",
  "hasSelf",
  "minCardinality",
  "maxCardinality",
  "cardinality",
  "minQualifiedCardinality",
  "maxQualifiedCardinality",
  "qualifiedCardinality",
  "onClass",
  "onDataRange",
];

/** Canonical, blank-node-free text of every axiom in a justification (restrictions and intersections inlined). */
function canonicalAxioms(justification: Quad[]): string[] {
  const bySubject = new Map<string, Quad[]>();
  for (const q of justification) {
    const key = `${q.subject.termType}:${q.subject.value}`;
    (bySubject.get(key) ?? bySubject.set(key, []).get(key)!).push(q);
  }
  const first = (t: Term, p: string): Term | undefined =>
    bySubject
      .get(`${t.termType}:${t.value}`)
      ?.find((q) => q.predicate.value === p)?.object;
  const render = (t: Term | undefined): string => {
    if (!t) return "?";
    if (t.termType !== "BlankNode") return t.value;
    const prop = first(t, OWL + "onProperty");
    if (prop) {
      const parts = RESTRICTION_KINDS.filter((k) => first(t, OWL + k)).map(
        (k) => `${k} ${render(first(t, OWL + k))}`,
      );
      return `(${prop.value} ${parts.join(" ")})`;
    }
    const list = first(t, OWL + "intersectionOf");
    if (list) {
      const items: string[] = [];
      for (
        let cur: Term | undefined = list;
        cur && cur.value !== RDF + "nil";
        cur = first(cur, RDF + "rest")
      ) {
        items.push(render(first(cur, RDF + "first")));
      }
      return `and(${items.sort().join(", ")})`;
    }
    return "_:blank";
  };
  return justification
    .filter(
      (q) =>
        q.subject.termType !== "BlankNode" &&
        q.predicate.value !== RDF + "first" &&
        q.predicate.value !== RDF + "rest",
    )
    .map((q) => `${q.subject.value} ${q.predicate.value} ${render(q.object)}`)
    .sort();
}

const SOME_SEMICONDUCTIVITY = `(${OBO}RO_0000091 someValuesFrom ${PMD}0090001)`;
const SILICON_TYPE = `${SILICON} ${RDF}type ${PMD}0020050`;
const SEMICONDUCTOR_DEFINITION = `${PMD}0090000 ${OWL}equivalentClass ${SOME_SEMICONDUCTIVITY}`;

const HERMIT_J1 = [
  SILICON_TYPE,
  `${PMD}0020050 ${RDFS}subClassOf ${SOME_SEMICONDUCTIVITY}`,
  SEMICONDUCTOR_DEFINITION,
].sort();

const HERMIT_J2 = [
  SILICON_TYPE,
  `${PMD}0020050 ${OWL}equivalentClass and(${[`${PMD}0020140`, SOME_SEMICONDUCTIVITY, `(${OBO}BFO_0000051 allValuesFrom ${OBO}CHEBI_27573)`].sort().join(", ")})`,
  SEMICONDUCTOR_DEFINITION,
].sort();


/** Exactly the graphs Ontosphere passes as `excludeGraphs`. */
const APP_EXCLUDED_GRAPHS = [INFERRED, "urn:konclude:explanations", SHAPES, "urn:vg:provenance", "urn:vg:workflows"];

/** Triples that exist only in the inferred graph: they are conclusions, never part of a justification. */
function inferredOnly(store: Store): Set<string> {
  const key = (q: Quad) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
  const asserted = new Set<string>();
  const inferred = new Set<string>();
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.subject.termType === "BlankNode" || q.object.termType === "BlankNode") continue;
    (q.graph.value === INFERRED ? inferred : asserted).add(key(q));
  }
  return new Set([...inferred].filter((k) => !asserted.has(k)));
}

describe.skipIf(!wasmExists)("explainEntailment after checkConsistency + materialize (FeSi case, Ontosphere procedure)", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeEach(async () => {
    store = new Store(
      new Parser({ format: "application/trig" }).parse(
        readFileSync(new URL("../fixtures/fesi-hermit-case.trig", import.meta.url).pathname, "utf8"),
      ),
    );
    reasoner = new RdfReasoner({ excludeGraphs: APP_EXCLUDED_GRAPHS });
    await reasoner.ready;
    // the application's reasoning run
    await reasoner.checkConsistency(store);
    await reasoner.materialize(store, { includeClassHierarchy: true, inferredGraph: INFERRED, returnDelta: true });
  }, 180_000);

  afterEach(() => reasoner?.terminate());

  it("exact: returns exactly HermiT's two justifications, as on a fresh reasoner", async () => {
    const res = await reasoner.explainEntailment(store, SILICON, RDF + "type", PMD + "0090000", {
      justificationMode: "exact",
      maxJustifications: 5,
      inferredGraph: INFERRED,
    });
    expect(res.isEntailed).toBe(true);
    const found = res.justifications.map(canonicalAxioms).map((a) => a.join("\n")).sort();
    expect(found).toEqual([HERMIT_J1.join("\n"), HERMIT_J2.join("\n")].sort());
  }, 180_000);

  it("exact: no justification contains a triple that exists only in the inferred graph", async () => {
    const res = await reasoner.explainEntailment(store, SILICON, RDF + "type", PMD + "0090000", {
      justificationMode: "exact",
      maxJustifications: 5,
      inferredGraph: INFERRED,
    });
    const onlyInferred = inferredOnly(store);
    const leaked = res.justifications.flat().map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).filter((k) => onlyInferred.has(k));
    expect(leaked).toEqual([]);
  }, 180_000);

  it("fast: any justification it returns contains no inferred-only triple and is one of HermiT's", async () => {
    const res = await reasoner.explainEntailment(store, SILICON, RDF + "type", PMD + "0090000", {
      justificationMode: "fast",
      inferredGraph: INFERRED,
    });
    expect(res.isEntailed).toBe(true);
    const onlyInferred = inferredOnly(store);
    const leaked = res.justifications.flat().map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).filter((k) => onlyInferred.has(k));
    expect(leaked).toEqual([]);
    // an empty list is acceptable for causal only if the caller can tell that no justification was produced;
    // a non-empty list must be one of HermiT's justifications
    for (const j of res.justifications) {
      expect([HERMIT_J1.join("\n"), HERMIT_J2.join("\n")]).toContain(canonicalAxioms(j).join("\n"));
    }
  }, 180_000);

  it("second call on the same state, and a call without the inferredGraph option, give the same answer", async () => {
    const run = (opts: object) => reasoner.explainEntailment(store, SILICON, RDF + "type", PMD + "0090000", { justificationMode: "exact", maxJustifications: 5, ...opts });
    const norm = (r: Awaited<ReturnType<typeof run>>) => r.justifications.map(canonicalAxioms).map((a) => a.join("\n")).sort();
    const expected = [HERMIT_J1.join("\n"), HERMIT_J2.join("\n")].sort();
    // the instance remembers the inferred graph of its materialize call: no option needed
    expect(norm(await run({}))).toEqual(expected);
    // second call right after the first, with the option
    expect(norm(await run({ inferredGraph: INFERRED }))).toEqual(expected);
  }, 180_000);
});
