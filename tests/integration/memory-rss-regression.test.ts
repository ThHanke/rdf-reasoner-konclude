// @vitest-environment node
//
// Regression: RSS must not grow unbounded across successive reasoning calls.
// Uses mini-family (tiny fixture) so each call is fast (~1s), allowing many
// iterations to detect accumulation without long timeouts.

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

describe("memory: no RSS accumulation across reasoning calls", () => {
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
    "RSS after 10 calls does not grow more than 40 MB vs call 1",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built");
        return;
      }

      const N = 10;
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
        `[memory] RSS samples: ${rss.map((r) => r.toFixed(0)).join(", ")} MB`,
      );
      console.info(
        `[memory] Growth call 1→${N}: ${growth.toFixed(1)} MB`,
      );

      // Without fix: each call accumulates ~10-30 MB (old ontologies kept alive).
      // With fix (aggressive reset): RSS plateaus. Allow 40 MB for GC/V8 noise.
      expect(
        growth,
        `RSS grew ${growth.toFixed(0)} MB over ${N - 1} extra calls — old ontologies may not be freed`,
      ).toBeLessThan(40);
    },
    120_000,
  );
});
