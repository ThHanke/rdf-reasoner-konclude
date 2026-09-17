// @vitest-environment node
//
// Regression test: librdf world/model/storage must not accumulate across calls.
//
// Root cause: each loadTripleBuffer() created a librdf_world + librdf_model that
// was kept alive until the 2-generation-old ontology was deleted in reset()
// (needed so KPSet pthreads finish against a live ontology). At steady state
// that held 3 live librdf worlds — ~60-70 MB each for roberts-family — growing
// RSS by that amount on every successive reasoning call with no plateau.
//
// Fix: free the librdf objects immediately after mapTriples() returns. Konclude's
// internal structures own all parsed data at that point; the librdf heap is no
// longer needed.
//
// What this test pins: RSS after the Nth call must not exceed RSS after the
// first call by more than a bounded amount (independent of N). Without the fix
// it grows O(N) — ~3× 60 MB = 180 MB per call for roberts-family-sized input.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Store, Parser } from "n3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../fixtures/roberts-family.nt");
const INFERRED = "urn:konclude:inferred";

function loadStore(): Store {
  const text = readFileSync(FIXTURE, "utf8");
  const store = new Store();
  store.addQuads(new Parser({ format: "N-Triples" }).parse(text));
  return store;
}

function rssMB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

describe("librdf memory: RSS does not grow with each reasoning call", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    if (!wasmExists) return;
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  it(
    "RSS growth from call 1 to call 5 is bounded (< 60 MB), not O(N)",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built — skipping RSS regression test");
        return;
      }

      const N = 5;
      const rss: number[] = [];

      for (let i = 0; i < N; i++) {
        // Fresh Store each iteration: cache miss → full WASM reasoning run.
        const store = loadStore();
        await reasoner.materialize(store, {
          includeClassHierarchy: true,
          inferredGraph: INFERRED,
        });
        // Let GC settle before measuring.
        await new Promise((r) => setTimeout(r, 200));
        rss.push(rssMB());
      }

      const growthMB = rss[N - 1] - rss[0];
      const perCallMB = growthMB / (N - 1);

      console.info(
        "[memory] RSS after each call: " +
          rss.map((r) => r.toFixed(0) + " MB").join(", ")
      );
      console.info(
        `[memory] Growth call 1→${N}: ${growthMB.toFixed(1)} MB  (${perCallMB.toFixed(1)} MB/call)`
      );

      // Without the fix each call accumulates ~3 librdf worlds.
      // For roberts-family that is ~30-60 MB per call → 120-240 MB over 4 extra calls.
      // With the fix RSS should plateau; allow 60 MB for GC lag and V8 overhead.
      expect(
        growthMB,
        `RSS grew ${growthMB.toFixed(0)} MB across ${N - 1} additional calls ` +
          `(${perCallMB.toFixed(0)} MB/call) — librdf early-free fix may not be effective`
      ).toBeLessThan(60);
    },
    120_000
  );
});
