/**
 * Self-invalidating reasoner contract (plan 2026-10-10-001, Units 2-5).
 *
 * C++ decides by itself whether the content handed in differs from the loaded state:
 *  - unchanged content (any Store instance, quad order, duplicates) => no Konclude work
 *  - changed content => cached results invalidated, rebuild on the next reasoning call
 *  - change + change back before any reasoning call => no rebuild
 * One Worker for the whole file (a Worker per test exhausts the Emscripten pthread pool).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const { namedNode, quad } = DataFactory;
const ig = namedNode(INFERRED_GRAPH_IRI);

interface Stats { generation: number; rebuilds: number; triples: number }

const key = (q: Quad) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
const inferredOf = (s: Store) => s.getQuads(null, null, null, ig).map(key).sort();

describe.skipIf(!wasmExists)("self-invalidating reasoner", () => {
  let r: RdfReasoner;
  const stats = () => (r as any)._call("syncStats", []) as Promise<Stats>;

  const mini = () => loadFixture("mini-family.nt");
  const lubm = () => loadFixture("lubm.nt");

  beforeAll(async () => {
    r = new RdfReasoner();
    await r.ready;
  }, 120000);

  afterAll(() => r?.terminate());

  it("materialize twice on the same store: second call does no Konclude work", async () => {
    const store = new Store(mini());
    await r.materialize(store);
    const first = inferredOf(store);
    expect(first.length).toBeGreaterThan(0);
    const s1 = await stats();
    await r.materialize(store);
    const s2 = await stats();
    expect(s2.rebuilds).toBe(s1.rebuilds);
    expect(s2.generation).toBe(s1.generation);
    expect(inferredOf(store)).toEqual(first);
  });

  it("fresh Store with identical content (shuffled, duplicates) gets the result without a rebuild", async () => {
    const quads = mini();
    const a = new Store(quads);
    await r.materialize(a);
    const s1 = await stats();
    const shuffled = [...quads].reverse().concat(quads.slice(0, 5));
    const b = new Store(shuffled);
    await r.materialize(b);
    const s2 = await stats();
    expect(s2.rebuilds).toBe(s1.rebuilds);
    expect(s2.generation).toBe(s1.generation);
    expect(inferredOf(b)).toEqual(inferredOf(a));
  });

  it("inferred-graph quads in the store never count as content", async () => {
    const store = new Store(mini());
    await r.materialize(store);
    const s1 = await stats();
    expect(inferredOf(store).length).toBeGreaterThan(0);
    await r.classify(store); // store now carries inferred quads from materialize
    await r.materialize(store);
    const s2 = await stats();
    expect(s2.generation).toBe(s1.generation);
  });

  it("add quad invalidates; remove quad invalidates; result tracks the content", async () => {
    const quads = mini();
    const store = new Store(quads);
    await r.materialize(store);
    const base = inferredOf(store);
    const s1 = await stats();

    const extra = quad(namedNode("http://example.org/new-person"), namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), namedNode("http://www.w3.org/2002/07/owl#Thing"));
    store.addQuad(extra);
    await r.materialize(store);
    const s2 = await stats();
    expect(s2.generation).toBe(s1.generation + 1);
    expect(s2.rebuilds).toBe(s1.rebuilds + 1);

    store.removeQuad(extra);
    await r.materialize(store);
    const s3 = await stats();
    expect(s3.generation).toBe(s2.generation + 1);
    expect(inferredOf(store)).toEqual(base);
  });

  it("add + remove back before the next reasoning call: no rebuild", async () => {
    const store = new Store(mini());
    await r.materialize(store);
    const before = inferredOf(store);
    const s1 = await stats();
    // Content changes, is synced (via classify of another view), then returns to the original.
    const other = new Store(mini());
    other.addQuad(quad(namedNode("http://example.org/x"), namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf"), namedNode("http://example.org/y")));
    await (r as any)._sync(other);
    await r.materialize(store);
    const s2 = await stats();
    // The ontology was never rebuilt for `other` (no reasoning call ran), and the original content is back.
    expect(s2.rebuilds).toBe(s1.rebuilds);
    expect(inferredOf(store)).toEqual(before);
  });

  it("alternating calls across ontologies and operations complete (former 7th/8th-call hang positions)", async () => {
    const mk = () => new Store(mini());
    const ref = new Store(mini());
    await r.materialize(ref);
    const expected = inferredOf(ref);
    for (let i = 0; i < 4; i++) {
      const l = new Store(lubm());
      await r.classify(l);
      expect(inferredOf(l).length).toBeGreaterThan(0);
      const m = mk();
      await r.materialize(m);
      expect(inferredOf(m)).toEqual(expected);
      expect(await r.checkConsistency(m)).toBe(true);
      await r.classifyProperties(m);
    }
    await r.materialize(new Store());
    const again = mk();
    await r.materialize(again);
    expect(inferredOf(again)).toEqual(expected);
  }, 180000);

  it("whatIf, then the original store again, returns to the original result", async () => {
    const store = new Store(mini());
    await r.materialize(store);
    const base = inferredOf(store);
    for (let i = 0; i < 3; i++) {
      await r.whatIf(store, [quad(namedNode(`http://example.org/h${i}`), namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), namedNode("http://www.w3.org/2002/07/owl#Thing"))]);
    }
    const fresh = new Store(mini());
    await r.materialize(fresh);
    expect(inferredOf(fresh)).toEqual(base);
  }, 120000);
});
