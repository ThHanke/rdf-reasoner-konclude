/**
 * Regression: inferred triples on blank-node individuals must keep the asserted label
 * (Konclude's internal "_::label" name used to leak out as BlankNode ":label").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

describe.skipIf(!wasmExists)("inferred blank-node labels", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(() => reasoner.terminate());

  it("inferred types attach to the asserted blank node, no stray colon", async () => {
    const store = new Store(
      new Parser().parse(`
@prefix ex: <http://e/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://e/o> a owl:Ontology . ex:A a owl:Class . ex:B a owl:Class . ex:A rdfs:subClassOf ex:B .
_:b1 a ex:A .`),
    );
    const asserted = store.getQuads(null, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "http://e/A", null)[0].subject;
    await reasoner.materialize(store);
    const types = store.getQuads(asserted, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", null, null).map(q => q.object.value);
    expect(types).toContain("http://e/B");
    const blanks = store.getQuads(null, null, null, null).filter(q => q.subject.termType === "BlankNode");
    expect(blanks.every(q => q.subject.equals(asserted))).toBe(true);
  }, 120000);
});
