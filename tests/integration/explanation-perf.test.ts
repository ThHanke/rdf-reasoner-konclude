/**
 * Performance benchmark: explanation serialization overhead.
 *
 * Measures the cost of `explanations: true` vs default.
 * Target: less than 30% added time (advisory, not a hard gate).
 *
 * Requires the built WASM binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";

import {
  RdfReasoner,
  EXPLANATION_GRAPH_IRI,
  KJ_JUSTIFIES,
} from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const { namedNode } = DataFactory;
const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const RUNS = 3;

async function median(fn: () => Promise<void>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

describe.skipIf(!wasmExists)("Explanation performance benchmark", () => {
  it("classify: explanation overhead < 30%", async () => {
    const quads = loadFixture("roberts-family.nt");
    const r = new RdfReasoner();
    await r.ready;
    try {
      const baseTime = await median(async () => {
        const store = new Store(quads);
        await r.classify(store);
      });

      const explTime = await median(async () => {
        const store = new Store(quads);
        await r.classify(store, { explanations: true });
      });

      const overhead = ((explTime - baseTime) / baseTime) * 100;
      const explGraph = namedNode(EXPLANATION_GRAPH_IRI);

      const store = new Store(quads);
      await r.classify(store, { explanations: true });
      const justifyCount = store.getQuads(null, namedNode(KJ_JUSTIFIES), null, explGraph).length;
      const totalExplQuads = store.getQuads(null, null, null, explGraph).length;

      console.log(`  classify baseline: ${baseTime.toFixed(1)}ms`);
      console.log(`  classify + explanations: ${explTime.toFixed(1)}ms`);
      console.log(`  overhead: ${overhead.toFixed(1)}%`);
      console.log(`  justifications: ${justifyCount}, total expl quads: ${totalExplQuads}`);

      expect(overhead).toBeLessThan(30);
    } finally {
      r.terminate();
    }
  }, 120000);

  it("materialize: explanation overhead < 500%", async () => {
    const quads = loadFixture("roberts-family.nt");
    const r = new RdfReasoner();
    await r.ready;
    try {
      const baseTime = await median(async () => {
        const store = new Store(quads);
        await r.materialize(store);
      });

      const explTime = await median(async () => {
        const store = new Store(quads);
        await r.materialize(store, { explanations: true });
      });

      const overhead = ((explTime - baseTime) / baseTime) * 100;

      console.log(`  materialize baseline: ${baseTime.toFixed(1)}ms`);
      console.log(`  materialize + explanations: ${explTime.toFixed(1)}ms`);
      console.log(`  overhead: ${overhead.toFixed(1)}%`);

      // Direct N3 index injection eliminates Quad allocation + serializeExplanations.
      // 500% is a regression guard (was 1600% before injection path).
      expect(overhead).toBeLessThan(500);
    } finally {
      r.terminate();
    }
  }, 120000);
});
