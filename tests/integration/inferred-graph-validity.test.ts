/**
 * The inferred graph lives inside the caller's Store, so the caller can edit it between calls. Every call must
 * leave it holding exactly what the reasoner derives from the current content: a cache hit is only valid while
 * the graph still holds what was last written, and an edit to any non-excluded graph changes the content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";
import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const { namedNode: nn, quad } = DataFactory;
const T = nn("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const SUB = nn("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const OWL_CLASS = nn("http://www.w3.org/2002/07/owl#Class");
const OWL_NI = nn("http://www.w3.org/2002/07/owl#NamedIndividual");
const ex = (s: string) => nn(`http://x/${s}`);
const SKOLEM = nn("urn:vg:bnode:n1");
const OTHER_GRAPH = "urn:test:inferred-other";

function base(): Store {
  const s = new Store();
  for (const c of ["A", "B"]) s.addQuad(quad(ex(c), T, OWL_CLASS));
  s.addQuad(quad(SKOLEM, T, OWL_NI));
  s.addQuad(quad(SKOLEM, T, ex("A")));
  s.addQuad(quad(ex("A"), SUB, ex("B")));
  return s;
}
const inferred = (s: Store, graph = INFERRED_GRAPH_IRI): string[] =>
  s.getQuads(null, null, null, nn(graph)).map((q) => `${q.subject.value} ${q.predicate.value.split(/[#/]/).pop()} ${q.object.value}`).sort();
const DERIVED = "urn:vg:bnode:n1 type http://x/B";

describe.skipIf(!wasmExists)("inferred graph validity", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });
  afterAll(() => reasoner?.terminate());

  it("is cleaned and refilled when the content changes (skolem individual)", async () => {
    const s = base();
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([DERIVED]);
    s.removeQuad(quad(ex("A"), SUB, ex("B")));
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([]);
    s.addQuad(quad(ex("A"), SUB, ex("B")));
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([DERIVED]);
  });

  it("repeating a call on unchanged content leaves the graph as it is", async () => {
    const s = base();
    await reasoner.materialize(s);
    const first = inferred(s);
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual(first);
  });

  it("removes quads a caller added to the inferred graph, although the content is unchanged", async () => {
    const s = base();
    await reasoner.materialize(s);
    s.addQuad(quad(ex("junk"), T, ex("B"), nn(INFERRED_GRAPH_IRI)));
    const result = await reasoner.materialize(s, { returnDelta: true });
    expect(inferred(s)).toEqual([DERIVED]);
    expect(result.delta.removed.map((q) => q.subject.value)).toContain("http://x/junk");
  });

  it("restores quads a caller deleted from the inferred graph, although the content is unchanged", async () => {
    const s = base();
    await reasoner.materialize(s);
    s.removeQuads(s.getQuads(null, null, null, nn(INFERRED_GRAPH_IRI)));
    expect(inferred(s)).toEqual([]);
    const result = await reasoner.materialize(s, { returnDelta: true });
    expect(inferred(s)).toEqual([DERIVED]);
    expect(result.delta.added.map((q) => q.subject.value)).toContain("urn:vg:bnode:n1");
  });

  it("swapping one inferred quad for another of the same count is detected", async () => {
    const s = base();
    await reasoner.materialize(s);
    s.removeQuads(s.getQuads(null, null, null, nn(INFERRED_GRAPH_IRI)));
    s.addQuad(quad(ex("junk"), T, ex("B"), nn(INFERRED_GRAPH_IRI)));
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([DERIVED]);
  });

  it("fills the graph named by inferredGraph even when the default graph was filled for the same content", async () => {
    const s = base();
    await reasoner.materialize(s);
    await reasoner.materialize(s, { inferredGraph: OTHER_GRAPH });
    expect(inferred(s, OTHER_GRAPH)).toEqual([DERIVED]);
    expect(inferred(s)).toEqual([DERIVED]);
  });

  it("an edit in another non-excluded named graph changes the result", async () => {
    const s = base();
    s.addQuad(quad(ex("A"), SUB, ex("B"), nn("urn:test:extra")));
    await reasoner.materialize(s);
    s.removeQuad(quad(ex("A"), SUB, ex("B")));
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([DERIVED]); // still derived through the copy in urn:test:extra
    s.removeQuad(quad(ex("A"), SUB, ex("B"), nn("urn:test:extra")));
    await reasoner.materialize(s);
    expect(inferred(s)).toEqual([]);
  });
});
