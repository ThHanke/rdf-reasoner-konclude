// @vitest-environment node
//
// Regression guard: RSS must not grow unbounded across reasoning calls.
// Uses mini-family (tiny fixture, ~1s per call) to run fast.
// The existing reset() keeps a bounded 2-generation ontology chain.
// This test catches regressions where reset() stops freeing old ontologies.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Store, Parser } from "n3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../fixtures/mini-family.nt");
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

describe("memory: RSS regression guard", () => {
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
    "RSS growth across 3 calls stays under 200 MB",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built");
        return;
      }

      const N = 3;
      const rss: number[] = [];

      for (let i = 0; i < N; i++) {
        const store = loadStore();
        await reasoner.materialize(store, {
          includeClassHierarchy: true,
          inferredGraph: INFERRED,
        });
        if (global.gc) global.gc();
        await new Promise((r) => setTimeout(r, 50));
        rss.push(rssMB());
      }

      const growth = rss[N - 1] - rss[0];

      console.info(
        `[memory] RSS: ${rss.map((r) => r.toFixed(0)).join(", ")} MB`,
      );
      console.info(
        `[memory] Growth call 1→${N}: ${growth.toFixed(1)} MB`,
      );

      // Bounded growth is expected: the 2-gen ontology chain keeps 3 ontologies
      // alive at steady state, and BackendAssCache accumulates per-ontology data.
      // For mini-family this is ~15 MB/call.  The 200 MB threshold catches
      // regressions where reset() stops working (unbounded growth).
      expect(
        growth,
        `RSS grew ${growth.toFixed(0)} MB — reset() may not be freeing old ontologies`,
      ).toBeLessThan(200);
    },
    60_000,
  );
});
