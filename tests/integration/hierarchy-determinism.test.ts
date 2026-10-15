// @vitest-environment node
//
// Regression test: inferred class hierarchy must be deterministic across calls.
//
// Root cause (patch 008): sortSubsumingConceptItemList() used qSort (unstable)
// with a comparator that only keyed on subsumer count. When two sibling classes
// have equal count, their relative sort order depended on insertion order into
// mSubsumingConceptItemList, which in WASM is thread-completion order —
// nondeterministic. The transitive reduction loop picks the "first parent" by
// position in this list, so different orderings produce different direct edges.
//
// Fix: tie-break by getConceptTag() (stable sequential integer) + std::stable_sort.
//
// This test runs materialize() N times with fresh stores and asserts both the
// inferred subClassOf count AND the exact set of subClassOf triples are identical
// every time. Count-only was the pre-fix assertion; exact-triple comparison is
// the stronger post-fix regression guard.

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

function inferredSubClassOfKey(store: Store): string {
  return store
    .getQuads(null, namedNode(RDFS_SUB_CLASS_OF), null, namedNode(INFERRED))
    .map((q) => `${q.subject.value} ${q.object.value}`)
    .sort()
    .join("\n");
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
    "all 3 runs on PMDco produce identical inferred subClassOf edges (KPSet path, patch 008)",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built — skipping hierarchy determinism test");
        return;
      }

      const N = 3;
      const counts: number[] = [];
      const keys: string[] = [];

      for (let i = 0; i < N; i++) {
        const store = loadStore();
        await reasoner.materialize(store, {
          includeClassHierarchy: true,
          inferredGraph: INFERRED,
        });
        counts.push(countInferredSubClassOf(store));
        keys.push(inferredSubClassOfKey(store));
      }

      console.info(
        `[determinism] subClassOf counts across ${N} runs: ${counts.join(", ")} (fixture: PMDco, KPSet path)`
      );

      // Count check (pre-fix regression)
      for (let i = 1; i < N; i++) {
        expect(
          counts[i],
          `Run ${i + 1} produced ${counts[i]} subClassOf edges, run 1 produced ${counts[0]}. ` +
            "Hasse nondeterminism detected — patch 008 (concept-tag tie-breaker) may not be active."
        ).toBe(counts[0]);
      }

      // Exact-triple check (post-fix regression — catches ordering bugs that preserve count)
      for (let i = 1; i < N; i++) {
        expect(
          keys[i],
          `Run ${i + 1} subClassOf set differs from run 1 despite equal count. ` +
            "Some edges changed identity — Hasse tie-breaking is still nondeterministic."
        ).toBe(keys[0]);
      }
    },
    300_000
  );
});

describe("class hierarchy: diagnostic — fresh reasoner per run (isolates state-accumulation from ordering nondeterminism)", () => {
  it(
    "3 independent WASM instances produce identical subClassOf counts",
    async () => {
      if (!wasmExists) {
        console.warn("[SKIP] WASM not built — skipping fresh-reasoner diagnostic test");
        return;
      }

      const N = 3;
      const counts: number[] = [];
      const keys: string[] = [];

      for (let i = 0; i < N; i++) {
        const r = new RdfReasoner();
        await r.ready;
        try {
          const store = loadStore();
          await r.materialize(store, {
            includeClassHierarchy: true,
            inferredGraph: INFERRED,
          });
          counts.push(countInferredSubClassOf(store));
          keys.push(inferredSubClassOfKey(store));
        } finally {
          r.terminate();
        }
      }

      console.info(
        `[fresh-reasoner] subClassOf counts across ${N} independent instances: ${counts.join(", ")}`
      );

      for (let i = 1; i < N; i++) {
        expect(
          counts[i],
          `Fresh instance ${i + 1} produced ${counts[i]} edges vs instance 1 with ${counts[0]}. ` +
            "Nondeterminism present even without state accumulation — within-run ordering issue."
        ).toBe(counts[0]);
      }

      for (let i = 1; i < N; i++) {
        expect(keys[i], `Fresh instance ${i + 1} subClassOf set differs from instance 1.`).toBe(
          keys[0]
        );
      }
    },
    600_000
  );
});
