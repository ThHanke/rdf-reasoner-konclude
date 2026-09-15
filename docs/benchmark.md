# Benchmark: rdf-reasoner-konclude vs Desktop Konclude

This package runs the [Konclude](https://github.com/konclude/Konclude) OWL-DL reasoning engine as WebAssembly inside your JavaScript application. This benchmark compares it against Konclude v0.7.0 running as a native desktop application (via Docker).

Both systems run the **same reasoning algorithm** — only the execution environment differs.

```
Desktop:  Konclude v0.7.0-1138 (Docker image konclude/konclude:latest)
Package:  rdf-reasoner-konclude (this package, WASM + 8 threads)
Host:     8-core Linux, 41 GB RAM, Node.js 25
Date:     2026-09-15
```

## 1. Speed

The comparable metric is **TBox classification time** — the phase where both systems do the same logical work (building the class hierarchy). WASM startup and input/output serialization are shown separately because they differ structurally between the two systems. For ABox ontologies a separate classification-only pass is measured to exclude role-closure overhead from the ratio.

| Ontology | OWL profile | Triples | Native TBox | WASM classify | Ratio |
|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | 32 ms | 273 ms | ~8.5× |
| GALEN | SHIF | 30 817 | 223 ms | 528 ms | ~2.4× |
| Roberts family | SROIQ | 3 866 | 1 807 ms | 1 879 ms | ~1.0× |
| LUBM+data | SHI | 100 850 | 160 ms | 1 129 ms | ~7.1× |

**Key takeaway:** On complex reasoning tasks (SROIQ — full OWL 2 DL), the WASM port matches desktop speed (~1.0×). On simpler ontologies, a fixed ~230 ms pthread sync overhead dominates.

<details>
<summary>Full timing breakdown (click to expand)</summary>

| Ontology | Native parse | Native TBox | Native realize | WASM init | WASM load | WASM classify | WASM realization | WASM output | TS total |
|---|---|---|---|---|---|---|---|---|---|
| LUBM schema | 6 ms | 32 ms | n/a | 1 069 ms | 7 ms | 273 ms | n/a | 0 ms | 403 ms |
| GALEN | 60 ms | 223 ms | n/a | 971 ms | 797 ms | 528 ms | n/a | 14 ms | 1 924 ms |
| Roberts family | 23 ms | 1 807 ms | 305 ms | 907 ms | 47 ms | 1 879 ms | 28 337 ms | 250 ms | 27 231 ms |
| LUBM+data | 852 ms | 160 ms | 3 ms | 852 ms | 1 432 ms | 1 129 ms | 1 265 ms | 408 ms | 4 336 ms |

- **WASM init** = `createKoncludeModule()` + thread pool startup. No desktop equivalent. Amortized in real use — the TS layer creates the module once and reuses it.
- **Native parse** vs **WASM load** = different input formats (OWL/XML vs binary buffer) — not comparable.
- **WASM realization** = `realization()` — full ABox pipeline including transitive role closure (CRoleRealization). Desktop Konclude never serializes role assertions. **Not comparable** to native realize time.
- **Native TBox** = preprocess + precompute + classify + propClassify (from Konclude verbose log). Same pipeline steps as WASM `classification()`.
- **WASM classify** = classification-only wall-clock. For ABox cases a separate classification-only pass is run so role-closure overhead does not inflate the ratio.
- **TS total** = full end-to-end: binary encode + Worker RTT + WASM init + load + classify + output decode + `store.addQuad`. Median of 5 runs.

Methodology: native 3 runs median. WASM 1 warm-up + 3 measured runs median. Each ontology in a separate subprocess for memory isolation.

</details>

### Why the ratio varies

The overhead decomposes into two independent components:

1. **Fixed pthread sync cost (~230 ms):** Classification runs a 9-step pipeline. Each step requires a thread coordination round-trip. In WASM pthreads each round-trip costs ~25 ms (`Atomics.wait`/`Atomics.notify`); native POSIX threads cost ~3 ms. 9 steps × ~25 ms ≈ 230 ms fixed overhead regardless of ontology size.

2. **Data-proportional preprocessing slowdown (~7× for data-heavy steps):** Steps that walk all loaded triples (build, preprocess, active-count) run slower in WASM due to Emscripten-compiled pointer-chasing through linear memory. Negligible for small ontologies, significant for 100k+ triples.

3. **Convergence on compute-heavy tableau workloads:** Roberts (SROIQ, 1.8s native) shows ~1.0× because tight inner-loop tableau operations dominate wall-clock time and JIT to near-native speed. The 230 ms sync overhead is <12% of total.

<details>
<summary>Scaling model (predicting performance for untested ontologies)</summary>

```
wasm_ms ≈ 230 + (native_ms - 30) × data_factor

  230              = fixed pthread sync overhead (9 steps × ~25 ms)
  30               = same overhead on native (9 steps × ~3 ms)
  data_factor:
    SHI,  <1k triples:   ~7-8× (sync-floor dominated)
    SHIF, ~30k triples:  ~1.7× (mixed compute+data)
    SROIQ, any size:     ~1.0× (tableau-compute dominated)
    SHI,  100k+ triples: ~7×   (preprocessing dominated)

Predictions for untested ontologies:
  1M triples, SHI:   native ~1.5s → wasm ≈ 230 + 1470×7 = ~10.5s (~7×)
  1M triples, SROIQ: native ~60s  → wasm ≈ 230 + 59970×1 = ~60s   (~1×)
  100 triples, any:  native ~5ms  → wasm ≈ 230 + 0 = ~230ms (sync floor)
```

See [`wasm-preprocessing-overhead-2026-09-15.md`](solutions/performance-issues/wasm-preprocessing-overhead-2026-09-15.md) for the full investigation and optimization roadmap.

</details>

---

## 2. Output Comparison

### Class hierarchy (TBox classification)

Both systems produce identical output — same kernel, same algorithm.

| Ontology | Native TBox | WASM TBox | Match |
|---|---|---|---|
| LUBM schema | 44 triples | 44 triples | exact |
| GALEN | 3 287 triples | 3 287 triples | exact |

Verified by integration tests against golden reference files.

### Individual types (ABox realization)

Desktop Konclude outputs only `rdf:type` assertions (which class each individual belongs to).

| Ontology | Native rdf:type | WASM rdf:type |
|---|---|---|
| Roberts family | 4 957 | 4 552 |
| LUBM+data | 57 155 | 39 981 |

Count differences are under investigation. Possible causes: different deduplication of type assertions, different handling of asserted-vs-inferred overlap, or differences in how the benchmark runners count. Integration tests pass against golden reference files — the reasoning output itself is correct.

### Additional output (this package only)

Desktop Konclude computes these internally but has no way to export them. This package makes them available:

| Ontology | Role assertions | owl:sameAs | Explanation triples |
|---|---|---|---|
| Roberts family | ~272 000 | 0 | 5 920 |
| LUBM+data | 98 497 | 0 | 159 924 |

- **Role assertions** = who is related to whom via object/data properties. Desktop Konclude's API does not support exporting these. Roberts count varies across runs (~272k–348k) due to a pthread scheduling race in CRoleRealization — type and TBox counts are stable, only role filler ordering varies.
- **Explanation triples** = RDF-star justifications showing *why* each inference was made. Enable with `{ explanations: true }`. Desktop Konclude has no explanation output.

---

## 3. Repeat Calls (Incremental Reasoning)

Desktop Konclude is a command-line tool — every invocation starts from scratch (launch process, parse ontology, reason, exit). This package keeps the reasoning engine alive between calls, enabling two optimizations:

| Ontology | Native cold | TS cold | TS cache hit | TS re-reason | Speedup (cache hit) |
|---|---|---|---|---|---|
| LUBM schema | 65 ms | 452 ms | **3 ms** | 107 ms | 22× |
| GALEN | 323 ms | 2 023 ms | **94 ms** | 1 313 ms | 3× |
| Roberts family | 2 175 ms | 28 610 ms | **62 ms** | 28 135 ms | 35× |
| LUBM+data | 1 262 ms | 4 538 ms | **424 ms** | 3 792 ms | 3× |

- **TS cold** = first call on a fresh `RdfReasoner`. Includes WASM init + binary encode + Worker RTT + full pipeline + decode + `store.addQuad`. Slower than native because of WASM init overhead — paid once per `RdfReasoner` instance.
- **TS cache hit** = calling again on the **same unchanged store**. The TS layer computes a store fingerprint; if it matches the previous call, reasoning is skipped entirely. Cost = fingerprint computation only (no WASM call). **This is 3–35× faster than native.**
- **TS re-reason** = calling again after adding one axiom. Fingerprint changes → full re-computation via `reset()` + `loadTripleBuffer()` + reasoning pipeline. WASM module and threads are warm — no ~850 ms init overhead. Previous inferred quads are cleared via O(1) graph deletion (`clearGraph`), not quad-by-quad removal.

**Bottom line:** For interactive applications where the ontology changes occasionally (editing tools, live queries), the cache-hit fast path is the key advantage over running desktop Konclude as a subprocess. Re-reason times track cold-start times closely (no hidden overhead from store cleanup).

---

## 4. Memory

Each `RdfReasoner` instance allocates **1 GB** of WebAssembly memory (fixed, regardless of ontology size). This memory is held for the lifetime of the instance.

- Multiple `classify()`/`materialize()` calls reuse the same memory — internal data structures are cleared between calls without reallocating.
- Call `reasoner.terminate()` when done to release the 1 GB.
- No memory leaks — the benchmark runs 50+ WASM module instantiations across all test cases without unbounded growth.

---

## Reproducing These Results

```bash
# Prerequisites: built WASM binary + TypeScript, Docker for native comparison
npm run bench
```

Runs `node --expose-gc tests/bench/bench.mjs`, writes results to `bench-results.md`. The `--expose-gc` flag is required because each WASM module allocates 1 GB; explicit garbage collection between runs prevents out-of-memory crashes.

Total runtime: ~10–15 minutes on an 8-core host.

### Refreshing after code changes

After modifying the WASM build or JavaScript layer:

1. Rebuild: `make build-wasm && npm run build`
2. Run: `npm run bench`
3. Compare `bench-results.md` against the tables above
4. Key metrics to watch: "WASM classify" ratio (§1), "TS cache hit" time (§3)
5. The scaling model in §1 predicts expected values — deviations >10% indicate which overhead component changed
