/**
 * Integration test: explainEntailment() reproduces HermiT's explanation of an inferred type.
 *
 * Case: `tests/fixtures/fesi-hermit-case.trig` (a PMDco-based ontology as Ontosphere stores it: data, inferred, shapes and
 * ontology named graphs). The entailment `some_silicon rdf:type semiconductor` has exactly two minimal justifications in
 * HermiT (`docs/experiments/hermit_explanation_FeSi_3b98aad.md`), three axioms each:
 *   J1  some_silicon : portion of silicon,  portion of silicon SubClassOf (has disposition some semiconductivity),
 *       semiconductor EquivalentTo (has disposition some semiconductivity)
 *   J2  some_silicon : portion of silicon,  portion of silicon EquivalentTo (portion of pure chemical element and
 *       (has disposition some semiconductivity) and (has part only silicon atom)),
 *       semiconductor EquivalentTo (has disposition some semiconductivity)
 *
 * Contract covered here: the caller names the graph that holds inferred triples (`inferredGraph`); that graph is not part
 * of the ontology. Without it the inferred triple counts as an axiom and "explains itself".
 *
 * Requires the built WASM binary; skipped when it is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe.skipIf(!wasmExists)("explainEntailment vs HermiT (FeSi case)", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(() => {
    store = new Store(
      new Parser({ format: "application/trig" }).parse(
        readFileSync(
          new URL("../fixtures/fesi-hermit-case.trig", import.meta.url)
            .pathname,
          "utf8",
        ),
      ),
    );
    reasoner = new RdfReasoner({ excludeGraphs: [SHAPES] });
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it("returns exactly HermiT's two minimal justifications", async () => {
    const res = await reasoner.explainEntailment(
      store,
      SILICON,
      RDF + "type",
      PMD + "0090000",
      {
        justificationMode: "minimal",
        maxJustifications: 5,
        inferredGraph: INFERRED,
      },
    );
    expect(res.isEntailed).toBe(true);
    const found = res.justifications
      .map(canonicalAxioms)
      .map((a) => a.join("\n"))
      .sort();
    expect(found).toEqual([HERMIT_J1.join("\n"), HERMIT_J2.join("\n")].sort());
  }, 180_000);

  it("without `inferredGraph` the inferred triple is treated as an axiom and explains itself", async () => {
    const res = await reasoner.explainEntailment(
      store,
      SILICON,
      RDF + "type",
      PMD + "0090000",
      {
        justificationMode: "minimal",
        maxJustifications: 5,
      },
    );
    expect(res.isEntailed).toBe(true);
    expect(res.justifications).toHaveLength(1);
    expect(canonicalAxioms(res.justifications[0])).toEqual([
      `${SILICON} ${RDF}type ${PMD}0090000`,
    ]);
  }, 180_000);
});
