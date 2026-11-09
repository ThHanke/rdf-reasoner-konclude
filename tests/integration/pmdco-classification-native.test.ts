/**
 * Integration test: PMDco classification against upstream Konclude's own output.
 *
 * `tests/fixtures/pmdco-native-class.owl.xml` is the OWL/XML classification of the same ontology written by the
 * unmodified upstream binary (1 570 named direct SubClassOf edges besides owl:Thing). Regression: from 0.8.0 on the
 * KPSet classifier ended with thousands of untested possible subsumptions (the buffered possible-subsumption init
 * messages were flushed after the items to test had been collected), so PMD_0020243 ⊑ PMD_0023003 and
 * PMD_0080022 ⊑ PMD_0023003 were lost.
 *
 * Requires the built WASM binary; skipped when it is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Store } from "n3";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
const PMD = "https://w3id.org/pmd/co/PMD_";

function nativeEdges(): Set<string> {
  const xml = readFileSync(new URL("../fixtures/pmdco-native-class.owl.xml", import.meta.url).pathname, "utf8");
  const edges = new Set<string>();
  const re = /<SubClassOf>\s*<Class IRI="([^"]+)"\s*\/>\s*<Class IRI="([^"]+)"\s*\/>\s*<\/SubClassOf>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2] !== OWL_THING) edges.add(`${m[1]} ${m[2]}`);
  }
  return edges;
}

describe.skipIf(!wasmExists)("PMDco classification vs upstream Konclude", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    store = new Store(loadFixture("pmdco.nt"));
    await reasoner.classify(store);
  }, 120_000);

  afterAll(() => {
    reasoner?.terminate();
  });

  const edgesIn = (graph: ReturnType<Store["getQuads"]>) =>
    new Set(
      graph
        .filter((q) => q.predicate.value === SUB && q.subject.termType === "NamedNode" && q.object.termType === "NamedNode" && q.object.value !== OWL_THING)
        .map((q) => `${q.subject.value} ${q.object.value}`),
    );

  it("every upstream direct edge is in the asserted or inferred hierarchy (completeness)", () => {
    const have = edgesIn(store.getQuads(null, null, null, null));
    const missing = [...nativeEdges()].filter((e) => !have.has(e));
    expect(missing).toEqual([]);
  });

  it("PMD_0020243 and PMD_0080022 are direct subclasses of PMD_0023003", () => {
    const inferred = edgesIn(store.getQuads(null, null, null, { termType: "NamedNode", value: INFERRED_GRAPH_IRI } as never));
    expect(inferred.has(`${PMD}0020243 ${PMD}0023003`)).toBe(true);
    expect(inferred.has(`${PMD}0080022 ${PMD}0023003`)).toBe(true);
  });

  it("every inferred edge is an upstream direct edge (precision)", () => {
    const native = nativeEdges();
    const inferred = edgesIn(store.getQuads(null, null, null, { termType: "NamedNode", value: INFERRED_GRAPH_IRI } as never));
    const extra = [...inferred].filter((e) => !native.has(e));
    expect(extra).toEqual([]);
  });
});
