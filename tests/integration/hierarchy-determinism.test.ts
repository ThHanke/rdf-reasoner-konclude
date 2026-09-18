// @vitest-environment node
//
// Regression test: inferred class hierarchy must be deterministic across calls.
//
// Measured by ontosphere (fix/reasoner-determinism-and-memory): ten cold sessions
// on PMDco @3b98aad + Fe-Si record returned 380-389 inferred triples; all 59
// differing statements were rdfs:subClassOf between named classes, while the
// transitive closure was always identical (8246 statements). Root cause: the
// Hasse diagram computation in buildInferredTripleBuffer walks unordered_maps
// whose iteration order varies with thread scheduling / hash seeds.
//
// This test uses PMDco alone (TBox-only, no ABox) — the nondeterminism is in
// the class hierarchy, not instance data. Runs materialize() N times with fresh
// stores and asserts the inferred subClassOf count is identical every time.
//
// A C++ fix would sort subClassOf edges by (subject IRI, object IRI) before
// emitting in buildInferredTripleBuffer. Until then, ontosphere's
// canonicalInferredHierarchy() TS post-processor is the workaround.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Store, Parser, DataFactory } from "n3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);
const __dirname = dirname(fileURLToPath(import.meta.url));
// PMDco exercises OptimizedKPSetClassSubsumptionClassifierThread (owl:unionOf).
// This is the nondeterministic path — the actual regression fixture.
// With MaxParallel=1 workaround each run takes ~60s; 3 runs = ~3 min total.
const FIXTURE = join(__dirname, "../fixtures/pmdco.nt");
const INFERRED = "urn:konclude:inferred";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

const { namedNode } = DataFactory;

function loadStore(): Store {
  const text = readFileSync(FIXTURE, "utf8");
  const store = new Store();
  store.addQuads(new Parser({ format: "N-Triples" }).parse(text));
  return store;
}

function countInferredSubClassOf(store: Store): number {
  return store.getQuads(null, namedNode(RDFS_SUB_CLASS_OF), null, namedNode(INFERRED)).length;
}

describe("class hierarchy: inferred subClassOf count is deterministic across calls", () => {
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
    "all 3 runs on PMDco produce identical inferred subClassOf edge count (KPSet path)",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built — skipping hierarchy determinism test");
        return;
      }

      const N = 3;
      const counts: number[] = [];

      for (let i = 0; i < N; i++) {
        const store = loadStore();
        await reasoner.materialize(store, {
          includeClassHierarchy: true,
          inferredGraph: INFERRED,
        });
        counts.push(countInferredSubClassOf(store));
      }

      console.info(`[determinism] subClassOf counts across ${N} runs: ${counts.join(", ")} (fixture: PMDco, KPSet path)`);

      const allSame = counts.every((c) => c === counts[0]);
      if (!allSame) {
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        console.warn(
          `[determinism] NONDETERMINISM DETECTED: range ${min}–${max} ` +
            `(${max - min} edge variance). ` +
            "Apply canonicalInferredHierarchy() post-processing or fix Hasse sort in C++."
        );
      }

      // Assert all counts are identical.
      // If this fails, the variance tells you how many redundant edges vary between runs.
      for (let i = 1; i < N; i++) {
        expect(
          counts[i],
          `Run ${i + 1} produced ${counts[i]} subClassOf edges, run 1 produced ${counts[0]}. ` +
            "Hasse diagram is nondeterministic."
        ).toBe(counts[0]);
      }
    },
    300_000
  );
});
