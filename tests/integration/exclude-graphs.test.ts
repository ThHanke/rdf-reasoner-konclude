/**
 * RdfReasonerOptions.excludeGraphs: caller graphs that are not ontology content (SHACL shapes, provenance,
 * workflow state) must not reach the reasoner, must not count as store content, and must not make an inferred
 * triple look already asserted. One reasoner serves the file; the same quad moved between graphs is the control.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";
import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const { namedNode: nn, quad } = DataFactory;
const RDF_TYPE = nn("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const SUBCLASS = nn("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const DISJOINT = nn("http://www.w3.org/2002/07/owl#disjointWith");
const OWL_CLASS = nn("http://www.w3.org/2002/07/owl#Class");
const OWL_NI = nn("http://www.w3.org/2002/07/owl#NamedIndividual");
const SHAPES = "urn:test:shapes";
const shapes = nn(SHAPES);
const ex = (s: string) => nn(`http://x/${s}`);

function base(): Store {
  const s = new Store();
  for (const c of ["A", "B", "D"]) s.addQuad(quad(ex(c), RDF_TYPE, OWL_CLASS));
  s.addQuad(quad(ex("i"), RDF_TYPE, OWL_NI));
  s.addQuad(quad(ex("i"), RDF_TYPE, ex("A")));
  return s;
}
const inferredHas = (s: Store, subj: string, cls: string) =>
  s.getQuads(null, null, null, nn(INFERRED_GRAPH_IRI)).some(
    (q) => q.subject.value === subj && q.predicate.value === RDF_TYPE.value && q.object.value === cls,
  );

describe.skipIf(!wasmExists)("excludeGraphs", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner({ excludeGraphs: [SHAPES] });
    await reasoner.ready;
  });
  afterAll(() => reasoner?.terminate());

  it("axioms in an excluded graph do not take part in materialize; the same axiom in the default graph does", async () => {
    const s = base();
    s.addQuad(quad(ex("A"), SUBCLASS, ex("B"), shapes));
    await reasoner.materialize(s);
    expect(inferredHas(s, "http://x/i", "http://x/B")).toBe(false);

    const control = base();
    control.addQuad(quad(ex("A"), SUBCLASS, ex("B")));
    await reasoner.materialize(control);
    expect(inferredHas(control, "http://x/i", "http://x/B")).toBe(true);
  });

  it("an excluded graph cannot make the ontology inconsistent", async () => {
    const s = base();
    s.addQuad(quad(ex("A"), DISJOINT, ex("D")));
    s.addQuad(quad(ex("i"), RDF_TYPE, ex("D"), shapes));
    expect(await reasoner.checkConsistency(s)).toBe(true);

    const control = base();
    control.addQuad(quad(ex("A"), DISJOINT, ex("D")));
    control.addQuad(quad(ex("i"), RDF_TYPE, ex("D")));
    expect(await reasoner.checkConsistency(control)).toBe(false);
  });

  it("editing an excluded graph is not a content change", async () => {
    const s = base();
    s.addQuad(quad(ex("A"), SUBCLASS, ex("B")));
    s.addQuad(quad(ex("i"), RDF_TYPE, ex("D"), shapes));
    await reasoner.checkConsistency(s);
    const gen = (reasoner as unknown as { _lastGen: number })._lastGen;
    s.addQuad(quad(ex("j"), RDF_TYPE, ex("B"), shapes));
    s.removeQuad(quad(ex("i"), RDF_TYPE, ex("D"), shapes));
    await reasoner.checkConsistency(s);
    expect((reasoner as unknown as { _lastGen: number })._lastGen).toBe(gen);
  });

  it("a triple that exists only in an excluded graph is still inferred into the inferred graph", async () => {
    const s = base();
    s.addQuad(quad(ex("A"), SUBCLASS, ex("B")));
    s.addQuad(quad(ex("i"), RDF_TYPE, ex("B"), shapes));
    await reasoner.materialize(s);
    expect(inferredHas(s, "http://x/i", "http://x/B")).toBe(true);
  });
});
