/**
 * Integration test: input rewrites (ts/inputNormalize.ts) must be deterministic and apply on every API path.
 *
 * The sync contract (docs/solutions/architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md) hashes the
 * encoded triples; blank-node labels and fresh names count as content. If a rewrite invented a new fresh name per call,
 * every verb would bump the content generation and rebuild the ontology. Here one store with every rewrite construct is
 * sent through consistency, classify and materialize (same content, copied store) and the generation must not move.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

const TTL = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
:A a owl:Class . :B a owl:Class . :C a owl:Class ; owl:intersectionOf ( :A :B ) .
:r a owl:ObjectProperty . :d1 a owl:DatatypeProperty . :d2 a owl:DatatypeProperty . :d3 a owl:DatatypeProperty ; rdfs:subPropertyOf owl:bottomDataProperty .
:d1 owl:propertyDisjointWith :d2 .
:Person a owl:Class ; owl:hasKey ( :idNo ) . :idNo a owl:DatatypeProperty .
:x a owl:NamedIndividual, :A, :B, :Person ; :idNo "1" ; :d1 "a" . :y a owl:NamedIndividual, :Person ; :d2 "b" .
[ a owl:NegativePropertyAssertion ; owl:sourceIndividual :x ; owl:assertionProperty :r ; owl:targetIndividual :y ] .`;

const fresh = () => new Store(new Parser().parse(TTL));
const copy = (s: Store) => new Store(s.getQuads(null, null, null, null));

describe.skipIf(!wasmExists)("input rewrites are deterministic across verbs", () => {
  let reasoner: RdfReasoner;
  const gen = () => (reasoner as unknown as { _lastGen: number })._lastGen;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("the construct-heavy ontology is consistent and C = A ⊓ B holds for x", async () => {
    const s = fresh();
    expect(await reasoner.checkConsistency(s)).toBe(true);
    await reasoner.materialize(s);
    const types = s.getQuads("http://ex.org/x", "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", null, null).map((q) => q.object.value);
    expect(types).toContain("http://ex.org/C"); // OWL 1 intersectionOf on a named class became an equivalence
  }, 90_000);

  it("same content through consistency, classify and materialize does not change the content generation", async () => {
    const s = fresh();
    await reasoner.checkConsistency(s);
    const g1 = gen();
    await reasoner.checkConsistency(copy(s));
    expect(gen()).toBe(g1);
    await reasoner.classify(copy(s));
    expect(gen()).toBe(g1);
    await reasoner.materialize(copy(s));
    expect(gen()).toBe(g1);
    await reasoner.checkConsistency(copy(s));
    expect(gen()).toBe(g1);
  }, 120_000);

  it("changing one asserted value does change the generation (the digest is not blind)", async () => {
    const s = fresh();
    await reasoner.checkConsistency(s);
    const g1 = gen();
    const s2 = copy(s);
    s2.addQuads(new Parser().parse(`<http://ex.org/y> <http://ex.org/idNo> "2" .`));
    await reasoner.checkConsistency(s2);
    expect(gen()).not.toBe(g1);
  }, 60_000);

  it("the negative assertion rewrite is active: adding r(x,y) makes the ontology inconsistent", async () => {
    const s = fresh();
    s.addQuads(new Parser().parse(`<http://ex.org/x> <http://ex.org/r> <http://ex.org/y> .`));
    expect(await reasoner.checkConsistency(s)).toBe(false);
  }, 60_000);
});
