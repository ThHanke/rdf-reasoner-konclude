/**
 * Integration test: RdfReasoner.repair() on small ontologies (real WASM).
 * Contract items from plan 2026-11-05-003: repair covers every justification, each repair is verified, independent
 * clashes need one removal each, overlapping clashes collapse to the shared axiom, read-only, consistent => none.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

const PREFIXES = `
@prefix ex: <http://example.org/rep#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/rep> a owl:Ontology .
`;

const storeOf = (ttl: string) => new Store(new Parser().parse(PREFIXES + ttl));
const snapshot = (s: Store) => s.getQuads(null, null, null, null).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.graph.value}`).sort();
const without = (s: Store, quads: Quad[]) => {
  const copy = new Store(s.getQuads(null, null, null, null));
  for (const q of quads) copy.removeQuad(q);
  return copy;
};

describe.skipIf(!wasmExists)("repair() integration", () => {
  let reasoner: RdfReasoner;
  beforeAll(() => {
    reasoner = new RdfReasoner();
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  it("consistent store: consistent true, no repairs", async () => {
    const r = await reasoner.repair(storeOf(`ex:A a owl:Class . ex:B a owl:Class . ex:A rdfs:subClassOf ex:B .`));
    expect(r).toMatchObject({ consistent: true, repairs: [], justifications: [], incomplete: false });
  }, 120000);

  it("independent clashes: every repair removes one axiom per clash; each single axiom is not enough; read-only", async () => {
    const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class . ex:P a owl:Class . ex:Q a owl:Class .
ex:A owl:disjointWith ex:B . ex:frank a ex:A, ex:B .
ex:P owl:disjointWith ex:Q . ex:gina a ex:P, ex:Q .
`);
    const before = snapshot(store);
    const r = await reasoner.repair(store, { maxJustifications: 5 });
    expect(snapshot(store)).toEqual(before); // read-only
    expect(r.consistent).toBe(false);
    expect(r.incomplete).toBe(false);
    expect(r.repairs.length).toBeGreaterThanOrEqual(1);
    for (const rep of r.repairs) {
      expect(rep.remove).toHaveLength(2);
      expect(rep.verifiedConsistent).toBe(true);
      expect(rep.minimal).toBe(true);
      // applying the repair restores consistency
      expect(await reasoner.checkConsistency(without(store, rep.remove.flatMap(a => a.quads)))).toBe(true);
      // removing only one of its axioms does not
      expect(await reasoner.checkConsistency(without(store, rep.remove[0].quads))).toBe(false);
      // declarations are never removable members
      for (const a of rep.remove) expect(a.principal.object.value.endsWith("#Class")).toBe(false);
    }
  }, 360000);

  it("overlapping clashes collapse to the shared axiom", async () => {
    const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
ex:frank a ex:A, ex:B . ex:gina a ex:A, ex:B .
`);
    const r = await reasoner.repair(store, { maxJustifications: 5 });
    expect(r.repairs.length).toBeGreaterThanOrEqual(1);
    const first = r.repairs[0];
    expect(first.remove).toHaveLength(1);
    expect(first.remove[0].principal.predicate.value).toMatch(/disjointWith$/);
    expect(first).toMatchObject({ verifiedConsistent: true, minimal: true });
    expect(first.covers.length).toBe(r.justifications.length);
  }, 360000);

  it("cost function steers the first repair", async () => {
    const store = storeOf(`
ex:A a owl:Class . ex:B a owl:Class .
ex:A owl:disjointWith ex:B .
ex:frank a ex:A, ex:B .
`);
    const preferAssertions = await reasoner.repair(store, { cost: a => (a.principal.predicate.value.endsWith("#type") ? 0 : 10) });
    expect(preferAssertions.repairs[0].remove[0].principal.predicate.value).toMatch(/#type$/);
    const preferSchema = await reasoner.repair(store, { cost: a => (a.principal.predicate.value.endsWith("disjointWith") ? 0 : 10) });
    expect(preferSchema.repairs[0].remove[0].principal.predicate.value).toMatch(/disjointWith$/);
  }, 360000);

  it("rejects non-store input with TypeError", async () => {
    await expect(reasoner.repair({} as unknown as Store)).rejects.toBeInstanceOf(TypeError);
  });

  it("the reasoner stays usable after repair (next normal call reloads)", async () => {
    const store = storeOf(`ex:A a owl:Class . ex:B a owl:Class . ex:A rdfs:subClassOf ex:B .`);
    await reasoner.repair(storeOf(`ex:A a owl:Class . ex:B a owl:Class . ex:A owl:disjointWith ex:B . ex:x a ex:A, ex:B .`));
    expect(await reasoner.checkConsistency(store)).toBe(true);
  }, 360000);
});
