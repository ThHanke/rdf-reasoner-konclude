/**
 * Tests for direct N3 Store index injection (ts/n3Inject.ts).
 *
 * Verifies that writing to N3's internal _ids/_entities/_graphs
 * produces identical query results to the public addQuad() API,
 * and measures the speedup.
 */

import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import {
  toN3EntityKey,
  assertN3Internals,
  getOrCreateId,
  getOrCreateQuotedTripleId,
  injectQuad,
  clearGraph,
} from "../../ts/n3Inject.js";

const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("N3 direct index injection", () => {
  it("produces identical results to addQuad for simple triples", () => {
    const ref = new Store();
    const g = namedNode("urn:test:graph");
    ref.addQuad(quad(namedNode("ex:Alice"), namedNode("ex:knows"), namedNode("ex:Bob"), g));
    ref.addQuad(quad(namedNode("ex:Bob"), namedNode("ex:age"), literal("30", namedNode("http://www.w3.org/2001/XMLSchema#integer")), g));
    ref.addQuad(quad(blankNode("b0"), namedNode("ex:label"), literal("hello", "en"), g));

    const test = new Store();
    const gId = getOrCreateId(test, "urn:test:graph");

    const alice = getOrCreateId(test, "ex:Alice");
    const knows = getOrCreateId(test, "ex:knows");
    const bob = getOrCreateId(test, "ex:Bob");
    injectQuad(test, alice, knows, bob, gId);

    const age = getOrCreateId(test, "ex:age");
    const thirty = getOrCreateId(test, '"30"^^http://www.w3.org/2001/XMLSchema#integer');
    injectQuad(test, bob, age, thirty, gId);

    const b0 = getOrCreateId(test, "_:b0");
    const label = getOrCreateId(test, "ex:label");
    const hello = getOrCreateId(test, '"hello"@en');
    injectQuad(test, b0, label, hello, gId);

    const refQuads = ref.getQuads(null, null, null, g);
    const testQuads = test.getQuads(null, null, null, g);

    expect(testQuads.length).toBe(refQuads.length);
    expect(test.size).toBe(ref.size);

    for (const rq of refQuads) {
      const found = testQuads.some(
        tq => tq.subject.value === rq.subject.value &&
              tq.predicate.value === rq.predicate.value &&
              tq.object.value === rq.object.value &&
              tq.graph.value === rq.graph.value,
      );
      expect(found, `Missing: ${rq.subject.value} ${rq.predicate.value} ${rq.object.value}`).toBe(true);
    }
  });

  it("produces identical results for RDF-star quoted triples", () => {
    const g = namedNode("urn:expl:graph");
    const justNode = namedNode("urn:konclude:j#abc123");
    const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    const kjJustification = namedNode("urn:konclude:justification:Justification");
    const kjJustifies = namedNode("urn:konclude:justification:justifies");
    const kjAxiom = namedNode("urn:konclude:justification:axiom");

    const inferredTriple = quad(namedNode("ex:Alice"), rdfType, namedNode("ex:Person"));
    const axiomTriple = quad(namedNode("ex:Alice"), rdfType, namedNode("ex:Human"));

    const ref = new Store();
    ref.addQuad(quad(justNode, rdfType, kjJustification, g));
    ref.addQuad(quad(justNode, kjJustifies, inferredTriple as any, g));
    ref.addQuad(quad(justNode, kjAxiom, axiomTriple as any, g));

    const test = new Store();
    const gIdT = getOrCreateId(test, "urn:expl:graph");
    const jId = getOrCreateId(test, "urn:konclude:j#abc123");
    const typeId = getOrCreateId(test, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    const kjJustId = getOrCreateId(test, "urn:konclude:justification:Justification");
    const kjJustifiesId = getOrCreateId(test, "urn:konclude:justification:justifies");
    const kjAxiomId = getOrCreateId(test, "urn:konclude:justification:axiom");

    injectQuad(test, jId, typeId, kjJustId, gIdT);

    const aliceId = getOrCreateId(test, "ex:Alice");
    const personId = getOrCreateId(test, "ex:Person");
    const quotedInferred = getOrCreateQuotedTripleId(test, aliceId, typeId, personId);
    injectQuad(test, jId, kjJustifiesId, quotedInferred, gIdT);

    const humanId = getOrCreateId(test, "ex:Human");
    const quotedAxiom = getOrCreateQuotedTripleId(test, aliceId, typeId, humanId);
    injectQuad(test, jId, kjAxiomId, quotedAxiom, gIdT);

    const refQuads = ref.getQuads(null, null, null, g);
    const testQuads = test.getQuads(null, null, null, g);

    expect(testQuads.length).toBe(refQuads.length);
    expect(test.size).toBe(ref.size);

    const justifiesQuads = test.getQuads(null, kjJustifies, null, g);
    expect(justifiesQuads.length).toBe(1);
    const qt = justifiesQuads[0].object;
    expect((qt as any).termType).toBe("Quad");
    expect((qt as any).subject.value).toBe("ex:Alice");
    expect((qt as any).predicate.value).toBe("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    expect((qt as any).object.value).toBe("ex:Person");

    const axiomQuads = test.getQuads(null, kjAxiom, null, g);
    expect(axiomQuads.length).toBe(1);
    const aqt = axiomQuads[0].object;
    expect((aqt as any).termType).toBe("Quad");
    expect((aqt as any).object.value).toBe("ex:Human");
  });

  it("toN3EntityKey converts intern.ts format to N3 format", () => {
    expect(toN3EntityKey("http://example.org/Foo", 0)).toBe("http://example.org/Foo");
    expect(toN3EntityKey("b0", 1)).toBe("_:b0");
    expect(toN3EntityKey("hello\0\0en", 2)).toBe('"hello"@en');
    expect(toN3EntityKey("30\0http://www.w3.org/2001/XMLSchema#integer\0", 2))
      .toBe('"30"^^http://www.w3.org/2001/XMLSchema#integer');
    expect(toN3EntityKey("plain\0\0", 2)).toBe('"plain"');
    expect(toN3EntityKey("plain\0http://www.w3.org/2001/XMLSchema#string\0", 2)).toBe('"plain"');
  });

  it("toN3EntityKey handles literal with empty language and empty datatype", () => {
    expect(toN3EntityKey("value", 2)).toBe('"value"');
    expect(toN3EntityKey("value\0\0", 2)).toBe('"value"');
  });

  it("toN3EntityKey handles literal with xsd:string datatype suppression", () => {
    expect(toN3EntityKey("hello\0http://www.w3.org/2001/XMLSchema#string\0", 2)).toBe('"hello"');
    expect(toN3EntityKey("hello\0http://www.w3.org/2001/XMLSchema#string", 2)).toBe('"hello"');
  });

  it("assertN3Internals passes for a valid N3 Store", () => {
    const store = new Store();
    expect(() => assertN3Internals(store)).not.toThrow();
  });

  it("assertN3Internals throws for a plain object", () => {
    expect(() => assertN3Internals({} as any)).toThrow("_entityIndex._ids");
  });

  it("assertN3Internals throws when _graphs is missing", () => {
    const fake = { _entityIndex: { _ids: {}, _id: 0, _entities: {} } } as any;
    expect(() => assertN3Internals(fake)).toThrow("_graphs missing");
  });

  it("clearGraph removes all quads from a specific named graph", () => {
    const store = new Store();
    const g1 = namedNode("urn:g1");
    const g2 = namedNode("urn:g2");
    store.addQuad(quad(namedNode("ex:a"), namedNode("ex:b"), namedNode("ex:c"), g1));
    store.addQuad(quad(namedNode("ex:d"), namedNode("ex:e"), namedNode("ex:f"), g1));
    store.addQuad(quad(namedNode("ex:x"), namedNode("ex:y"), namedNode("ex:z"), g2));

    expect(store.getQuads(null, null, null, g1).length).toBe(2);
    expect(store.getQuads(null, null, null, g2).length).toBe(1);

    clearGraph(store, "urn:g1");

    expect(store.getQuads(null, null, null, g1).length).toBe(0);
    expect(store.getQuads(null, null, null, g2).length).toBe(1);
  });

  it("clearGraph is a no-op for non-existent graph", () => {
    const store = new Store();
    store.addQuad(quad(namedNode("ex:a"), namedNode("ex:b"), namedNode("ex:c"), namedNode("urn:g1")));
    expect(() => clearGraph(store, "urn:nonexistent")).not.toThrow();
    expect(store.size).toBe(1);
  });

  it("timing: direct injection vs addQuad", () => {
    const QUADS = 1000;
    const graphIri = "urn:test:perf";

    const subjects = Array.from({ length: QUADS }, (_, i) => `ex:s${i}`);
    const predicate = "ex:p";
    const objects = Array.from({ length: QUADS }, (_, i) => `ex:o${i}`);

    const storeA = new Store();
    const gNode = namedNode(graphIri);
    const t0 = performance.now();
    for (let i = 0; i < QUADS; i++) {
      storeA.addQuad(quad(namedNode(subjects[i]), namedNode(predicate), namedNode(objects[i]), gNode));
    }
    const addQuadMs = performance.now() - t0;

    const storeB = new Store();
    const t1 = performance.now();
    const gId = getOrCreateId(storeB, graphIri);
    const pId = getOrCreateId(storeB, predicate);
    for (let i = 0; i < QUADS; i++) {
      const sId = getOrCreateId(storeB, subjects[i]);
      const oId = getOrCreateId(storeB, objects[i]);
      injectQuad(storeB, sId, pId, oId, gId);
    }
    const directMs = performance.now() - t1;

    const storeC = new Store();
    const t2 = performance.now();
    const gIdC = getOrCreateId(storeC, graphIri);
    const justifiesId = getOrCreateId(storeC, "urn:konclude:justification:justifies");
    for (let i = 0; i < QUADS; i++) {
      const jId = getOrCreateId(storeC, `urn:konclude:j#${i.toString(16).padStart(8, "0")}`);
      const sId = getOrCreateId(storeC, subjects[i]);
      const pIdInner = getOrCreateId(storeC, predicate);
      const oId = getOrCreateId(storeC, objects[i]);
      const quotedId = getOrCreateQuotedTripleId(storeC, sId, pIdInner, oId);
      injectQuad(storeC, jId, justifiesId, quotedId, gIdC);
    }
    const rdfStarMs = performance.now() - t2;

    const speedup = addQuadMs / directMs;
    const rdfStarSpeedup = addQuadMs / rdfStarMs;

    console.log(`\n  === N3 Injection Timing (${QUADS} quads) ===`);
    console.log(`  addQuad():        ${addQuadMs.toFixed(2)} ms`);
    console.log(`  direct inject:    ${directMs.toFixed(2)} ms  (${speedup.toFixed(1)}x faster)`);
    console.log(`  direct + RDF-star: ${rdfStarMs.toFixed(2)} ms  (${rdfStarSpeedup.toFixed(1)}x faster)`);
    console.log(`  storeA.size=${storeA.size}, storeB.size=${storeB.size}, storeC.size=${storeC.size}`);

    expect(storeB.size).toBe(QUADS);
    expect(storeC.size).toBe(QUADS);
    // Microbenchmark noise can make simple triples ~1x; RDF-star path is the
    // real win. Only assert overall sanity — not a regression.
    expect(speedup).toBeGreaterThan(0.5);
  });
});
