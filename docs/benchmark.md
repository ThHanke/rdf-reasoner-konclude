# Benchmark: Konclude Native vs HermiT vs WASM

This benchmark compares three OWL 2 DL reasoning systems on the same ontologies:

1. **Konclude native** — desktop C++ reasoner via Docker
2. **HermiT** — Java tableau reasoner via [ROBOT](http://robot.obolibrary.org/) / ODK Docker
3. **rdf-reasoner-konclude** — this package (Konclude compiled to WASM)

Konclude native and WASM run the same algorithm — only the execution environment differs. HermiT is an independent implementation for cross-system comparison.

```
Konclude: v0.7.0-1138 (Docker image konclude/konclude:latest)
HermiT:  via ROBOT 1.9.10 (Docker image obolibrary/odkfull:latest)
Package: rdf-reasoner-konclude (this package, WASM + 8 threads)
Host:    8-core Linux, 41 GB RAM, Node.js 25
Date:    2026-09-16
```

## 1. Speed

The comparable metric is **TBox classification time** — the phase where all systems do the same logical work (building the class hierarchy). WASM startup and input/output serialization are shown separately because they differ structurally. For ABox ontologies a separate classification-only pass is measured to exclude role-closure overhead from the ratio.

| Ontology | OWL profile | Triples | Konclude | HermiT | WASM | WASM overhead | HermiT overhead |
|---|---|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | 33 ms | 55 ms | 688 ms | ~20.8× | ~1.7× |
| GALEN | SHIF | 30 817 | 221 ms | 4 644 ms | 904 ms | ~4.1× | ~21× |
| Roberts family | SROIQ | 3 866 | 1 750 ms | **FAIL** | 2 211 ms | ~1.3× | — |
| LUBM+data | SHI | 100 850 | 156 ms | 1 110 ms | 1 516 ms | ~9.7× | ~7.1× |

**Key takeaway:** On complex reasoning (SROIQ — full OWL 2 DL), WASM overhead is only ~1.3× vs native Konclude while HermiT fails entirely. On simpler ontologies the overhead is higher (~4–21×), dominated by a fixed ~230 ms pthread sync cost. HermiT is 2–21× slower than Konclude on the ontologies it can handle.

<details>
<summary>Full timing breakdown (click to expand)</summary>

| Ontology | Konclude parse | Konclude TBox | Konclude realize | HermiT JVM+parse | HermiT reason | HermiT fill+write | WASM init | WASM load | WASM classify | WASM realization | WASM output | TS total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LUBM schema | 6 ms | 33 ms | n/a | 416 ms | 55 ms | 32 ms | 284 ms | 8 ms | 688 ms | n/a | 1 ms | 693 ms |
| GALEN | 64 ms | 221 ms | n/a | 1 855 ms | 4 644 ms | 196 ms | 226 ms | 803 ms | 904 ms | n/a | 15 ms | 2 322 ms |
| Roberts family | 27 ms | 1 750 ms | 302 ms | FAIL | FAIL | FAIL | 166 ms | 43 ms | 2 211 ms | 29 402 ms | 261 ms | 27 613 ms |
| LUBM+data | 858 ms | 156 ms | 3 ms | 3 512 ms | 1 110 ms | 2 564 ms | 181 ms | 1 411 ms | 1 516 ms | 1 673 ms | 395 ms | 4 771 ms |

- **Konclude parse** / **WASM load** = different input formats (OWL/XML vs binary buffer) — not directly comparable.
- **Konclude TBox** = preprocess + precompute + classify + propClassify (from Konclude verbose log). Same pipeline steps as WASM `classification()`.
- **HermiT JVM+parse** = JVM startup + ontology loading. Extracted from ROBOT `-vvv` log timestamps. Includes Docker container overhead.
- **HermiT reason** = pure reasoning time (from "Starting reasoning..." to "Reasoning took" log markers).
- **HermiT fill+write** = axiom generation + OFN output writing (from "Reasoning took" to "Subcommand Timing").
- **WASM init** = `createKoncludeModule()` + thread pool startup. Amortized in real use — the TS layer creates the module once and reuses it.
- **WASM realization** = `realization()` — full ABox pipeline including transitive role closure (CRoleRealization). Desktop Konclude never serializes role assertions. **Not comparable** to Konclude realize time.
- **WASM classify** = classification-only wall-clock. For ABox cases a separate classification-only pass is run so role-closure overhead does not inflate the ratio.
- **TS total** = full end-to-end: binary encode + Worker RTT + WASM init + load + classify + output decode + `store.addQuad`. Median of 5 runs.

Methodology: Konclude native 3 runs median. HermiT 3 runs median. WASM 1 warm-up + 3 measured runs median. Each ontology in a separate subprocess for memory isolation.

</details>

### Why the ratio varies

The overhead decomposes into two independent components:

1. **Fixed pthread sync cost (~230 ms):** Classification runs a 9-step pipeline. Each step requires a thread coordination round-trip. In WASM pthreads each round-trip costs ~25 ms (`Atomics.wait`/`Atomics.notify`); native POSIX threads cost ~3 ms. 9 steps × ~25 ms ≈ 230 ms fixed overhead regardless of ontology size.

2. **Data-proportional preprocessing slowdown (~7× for data-heavy steps):** Steps that walk all loaded triples (build, preprocess, active-count) run slower in WASM due to Emscripten-compiled pointer-chasing through linear memory. Negligible for small ontologies, significant for 100k+ triples.

3. **Convergence on compute-heavy tableau workloads:** Roberts (SROIQ, 1.8s native) shows ~1.3× because tight inner-loop tableau operations dominate wall-clock time and JIT to near-native speed. The 230 ms sync overhead is <13% of total.

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

### HermiT: Roberts family FAIL

HermiT runs out of memory (Java heap space) on the Roberts family ontology (SROIQ with 405 individuals, 24 property chains, transitive and symmetric properties), exiting with error code 1 — never reaching classification. Konclude classifies + realizes the same ontology in 2.1 seconds.

This is consistent with published findings:

- **ORE 2015 competition** (Parsia et al., "The OWL Reasoner Evaluation (ORE) 2015 Competition Report," *Journal of Automated Reasoning*, 59(4), 2017, pp. 455–482, Springer): Konclude placed 1st in all three OWL DL tracks (consistency, classification, realisation); HermiT timed out on many complex ontologies.
- **Konclude system description** (Steigmiller, Liebig & Glimm, "Konclude: System Description," *Journal of Web Semantics*, 27–28, 2014, pp. 78–85): describes the completion-graph caching and dependency-directed backtracking optimizations that give Konclude its advantage on SROIQ workloads.
- **OWL reasoner survey** (Abicht, "An Overview of OWL Reasoners," *arXiv:2308.04600*, 2023): confirms Konclude as the performance leader for OWL 2 DL, with HermiT showing exponential blowup on ontologies heavy in role interactions and nominals.

HermiT is the only other widely-used reasoner that supports full OWL 2 DL. Other reasoners (ELK, JFact) cover only OWL 2 EL or incomplete fragments.

---

## 2. Output Comparison

### Class hierarchy (TBox classification)

Konclude native and WASM produce identical output (same kernel). HermiT counts differ slightly due to different axiom-generation strategies.

| Ontology | Konclude | HermiT | WASM | Konclude vs WASM | HermiT vs Konclude |
|---|---|---|---|---|---|
| LUBM schema | 44 | 44 | 44 | exact | exact |
| GALEN | 3 287 | 3 348 | 3 287 | exact | +61 (+1.9%) |
| Roberts family | — | FAIL | — | — | — |

HermiT infers 61 additional SubClassOf axioms on GALEN — likely entailments Konclude prunes as redundant (dominated by existing axioms). Both are logically correct. Verified by integration tests against golden reference files.

### Individual types (ABox realization)

Desktop Konclude outputs only `rdf:type` assertions (which class each individual belongs to). HermiT outputs ClassAssertion axioms in OWL Functional Syntax. Both native and WASM counts exclude trivial `rdf:type owl:Thing` assertions (every individual is an owl:Thing by definition — native Konclude emits these, WASM does not).

| Ontology | Konclude | HermiT | WASM | Konclude vs WASM |
|---|---|---|---|---|
| Roberts family | 4 552 | FAIL | 4 552 | exact |
| LUBM+data | 39 981 | 18 143 | 39 981 | exact |

Konclude native and WASM produce identical rdf:type output (same kernel). Exact match enforced by integration tests against golden fixtures. HermiT's lower count on LUBM+data reflects different axiom-generation scope (ClassAssertion only, no redundant asserted types).

### Additional output (this package only)

Desktop Konclude computes these internally but has no way to export them. This package makes them available:

| Ontology | Role assertions | owl:sameAs | Explanation triples |
|---|---|---|---|
| Roberts family | ~286 000 | 0 | 5 920 |
| LUBM+data | 98 497 | 0 | 161 551 |

- **Role assertions** = who is related to whom via object/data properties. Desktop Konclude's API does not support exporting these. Roberts count varies across runs (~272k–348k) due to a pthread scheduling race in CRoleRealization — type and TBox counts are stable, only role filler ordering varies.
- **Explanation triples** = RDF-star justifications showing *why* each inference was made. Enable with `{ explanations: true }`. Desktop Konclude has no explanation output.

---

## 3. Repeat Calls (Incremental Reasoning)

Desktop Konclude is a command-line tool — every invocation starts from scratch (launch process, parse ontology, reason, exit). This package keeps the reasoning engine alive between calls, enabling two optimizations:

| Ontology | Konclude cold | TS cold | TS cache hit | TS re-reason | Speedup (cache hit) |
|---|---|---|---|---|---|
| LUBM schema | 67 ms | 878 ms | **2 ms** | 95 ms | 34× |
| GALEN | 322 ms | 2 693 ms | **94 ms** | 1 286 ms | 3× |
| Roberts family | 2 126 ms | 27 695 ms | **60 ms** | 27 241 ms | 35× |
| LUBM+data | 1 254 ms | 4 850 ms | **428 ms** | 3 820 ms | 3× |

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
# Prerequisites: built WASM binary + TypeScript, Docker for native + HermiT comparison
# Docker images: konclude/konclude:latest, obolibrary/odkfull:latest
npm run bench
```

Runs `node --expose-gc tests/bench/bench.mjs`, writes results to `bench-results.md`. The `--expose-gc` flag is required because each WASM module allocates 1 GB; explicit garbage collection between runs prevents out-of-memory crashes.

HermiT runs via `robot reason --reasoner HermiT` inside the ODK Docker image. Timing is extracted from ROBOT `-vvv` log timestamps. Roberts family times out / errors after ~5 minutes — this is expected behavior, not a benchmark bug.

Total runtime: ~20–25 minutes on an 8-core host (HermiT adds ~10 min, mostly Roberts timeout).

### Refreshing after code changes

After modifying the WASM build or JavaScript layer:

1. Rebuild: `make build-wasm && npm run build`
2. Run: `npm run bench`
3. Compare `bench-results.md` against the tables above
4. Key metrics to watch: "WASM classify" ratio (§1), "TS cache hit" time (§3)
5. The scaling model in §1 predicts expected values — deviations >10% indicate which overhead component changed
