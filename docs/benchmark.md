# Benchmark: rdf-reasoner-konclude vs Native Konclude vs HermiT

This benchmark shows how **rdf-reasoner-konclude** (this package) compares to two reference systems on the same ontologies:

1. **Konclude native** — the same C++ reasoning kernel, compiled for desktop, run via Docker CLI
2. **HermiT** — an independent Java OWL 2 DL tableau reasoner via [ROBOT](http://robot.obolibrary.org/) / ODK Docker

Konclude native and this package run the same algorithm — the difference is execution environment (native C++ vs WASM + pthreads). HermiT is an independent implementation for cross-system correctness and speed comparison.

```
Package:  rdf-reasoner-konclude v0.7.2 (WASM + 8 pthreads)
Konclude: v0.7.0-1138 (Docker image konclude/konclude:latest)
HermiT:   via ROBOT 1.9.10 (Docker image obolibrary/odkfull:latest)
Host:     8-core Linux, 41 GB RAM, Node.js 25
Date:     2026-09-18
```

---

## 1. Speed

The comparable metric is **classification time** — the phase where all systems do the same logical work (building the class hierarchy). WASM startup and input/output serialization are shown separately because they have no native equivalent.

For ABox ontologies a separate classification-only pass is measured to exclude role-closure overhead from the ratio.

| Ontology | OWL profile | Triples | WASM classify | vs Native | vs HermiT |
|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | **253 ms** | ~8.4× native | HermiT 62 ms (2.1× native) |
| GALEN | SHIF | 30 817 | **544 ms** | ~2.4× native | HermiT 4 768 ms (20.8× native) |
| Roberts family | SROIQ | 3 866 | **1 823 ms** | ~1.1× native | HermiT **FAIL** (OOM) |
| LUBM schema + data | SHI | 100 850 | **1 169 ms** | ~7.3× native | HermiT 1 122 ms (7.0× native) |

**Key takeaway:** On complex SROIQ reasoning (Roberts family), WASM matches native Konclude at ~1.1× while HermiT runs out of memory. On simpler ontologies the WASM overhead is higher (~2–8×), dominated by a fixed ~230 ms pthread sync cost across 9 pipeline steps. HermiT is 2–21× slower than Konclude native on the ontologies it can handle.

<details>
<summary>Full timing breakdown (click to expand)</summary>

| Ontology | Native parse | Native TBox | Native realize | HermiT JVM+parse | HermiT reason | WASM init | WASM load | WASM classify | WASM realization | WASM output | TS total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LUBM schema | 6 ms | 30 ms | n/a | 420 ms | 62 ms | 887 ms | 7 ms | 253 ms | n/a | 1 ms | 409 ms |
| GALEN | 62 ms | 229 ms | n/a | 2 043 ms | 4 768 ms | 922 ms | 807 ms | 544 ms | n/a | 15 ms | 2 033 ms |
| Roberts family | 25 ms | 1 711 ms | 307 ms | FAIL | FAIL | 834 ms | 43 ms | 1 823 ms | 28 929 ms | 288 ms | 30 192 ms |
| LUBM schema + data | 852 ms | 161 ms | 4 ms | 3 521 ms | 1 122 ms | 794 ms | 1 427 ms | 1 169 ms | 1 332 ms | 414 ms | 4 550 ms |

- **Native parse** = OWL/XML; **WASM load** = binary encode + `loadTripleBuffer()` (Raptor NTriples + `mapTriples()`). Different formats — not directly comparable.
- **Native TBox** = preprocess + precompute + classify + propClassify (from Konclude verbose log). Same pipeline steps as WASM `classification()`.
- **WASM init** = `createKoncludeModule()` + pthread pool startup (~850 ms). Amortized in real use — the TS layer creates the module once and reuses it across calls.
- **WASM realization** = `realization()` — full ABox pipeline including transitive role closure (CRoleRealization). Native Konclude never serializes role assertions. **Not comparable** to native realize time.
- **TS total** = full end-to-end: binary encode + Worker RTT + WASM init + load + classify + output decode + `store.addQuad`. Median of 5 runs.

Methodology: Konclude native 3 runs median. HermiT 3 runs median. WASM 1 warm-up + 3 measured runs median. Each ontology in a separate subprocess for memory isolation.

</details>

### Why the overhead varies

The overhead decomposes into two independent components:

1. **Fixed pthread sync cost (~230 ms):** Classification runs a 9-step pipeline. Each step requires a thread coordination round-trip. In WASM pthreads each round-trip costs ~25 ms (`Atomics.wait`/`Atomics.notify`); native POSIX threads cost ~3 ms. 9 steps × ~25 ms ≈ 230 ms fixed overhead regardless of ontology size.

2. **Data-proportional preprocessing slowdown (~7× for data-heavy steps):** Steps that walk all loaded triples (build, preprocess, active-count) run slower in WASM due to Emscripten-compiled pointer-chasing through linear memory. Negligible for small ontologies, significant for 100k+ triples.

3. **Convergence on compute-heavy tableau workloads:** Roberts (SROIQ, 1.7s native) shows ~1.1× because tight inner-loop tableau operations dominate wall-clock time and JIT to near-native speed. The 230 ms sync overhead is <13% of total.

<details>
<summary>Scaling model</summary>

```
wasm_ms ≈ 230 + (native_ms - 30) × data_factor

  230              = fixed pthread sync overhead (9 steps × ~25 ms)
  30               = same overhead on native (9 steps × ~3 ms)
  data_factor:
    SHI,  <1k triples:   ~7-8× (sync-floor dominated)
    SHIF, ~30k triples:  ~2.4× (mixed compute+data)
    SROIQ, any size:     ~1.0× (tableau-compute dominated)
    SHI,  100k+ triples: ~7×   (preprocessing dominated)

Predictions for untested ontologies:
  1M triples, SHI:   native ~1.5s → wasm ≈ 230 + 1470×7 = ~10.5s (~7×)
  1M triples, SROIQ: native ~60s  → wasm ≈ 230 + 59970×1 = ~60s  (~1×)
  100 triples, any:  native ~5ms  → wasm ≈ 230 + 0 = ~230ms (sync floor)
```

</details>

---

## 2. Output

### Class hierarchy (TBox classification)

Native Konclude and this package produce identical output (same kernel, same Hasse-reduced hierarchy). HermiT counts differ slightly.

| Ontology | This package | Native Konclude | HermiT | vs Native | HermiT vs Native |
|---|---|---|---|---|---|
| LUBM schema | **44** | 44 | 44 | exact | exact |
| GALEN | **3 287** | 3 287 | 3 348 | exact | +61 (+1.9%) |

HermiT infers 61 additional SubClassOf axioms on GALEN — logically correct entailments that Konclude's Hasse reduction prunes as transitive redundancies. Verified by integration tests against golden reference files.

### Individual types (ABox realization)

Native Konclude and this package produce identical `rdf:type` output. Trivial `rdf:type owl:Thing` assertions are excluded (native emits them, this package does not).

| Ontology | This package | Native Konclude | HermiT | vs Native |
|---|---|---|---|---|
| Roberts family | **4 552** | 4 552 | FAIL | exact |
| LUBM schema + data | **39 981** | 39 981 | 18 143 | exact |

HermiT's lower LUBM+data count reflects different axiom-generation scope. Native Konclude and this package match exactly — same kernel output.

### Additional output (this package only)

Native Konclude computes these internally but has no way to export them:

| Ontology | Role assertions | owl:sameAs | Explanation quads |
|---|---|---|---|
| Roberts family | **348 562** | 0 | 5 917 |
| LUBM schema + data | **98 497** | 0 | 161 011 |

- **Role assertions** = ObjectPropertyAssertion + DataPropertyAssertion. Native Konclude's API does not support exporting these. Enabled by default in `materialize()`.
- **Explanation quads** = RDF-star justifications showing why each inference was made. Enable with `{ explanations: true }`. Native Konclude has no explanation output.

---

## 3. Repeat Calls (Incremental Reasoning)

Native Konclude is a CLI tool — every invocation starts from scratch. This package keeps the reasoning engine alive between calls:

| Ontology | Native cold | Package cold | Cache hit | Re-reason | Cache speedup vs native |
|---|---|---|---|---|---|
| LUBM schema | 67 ms | 474 ms | **1 ms** | 108 ms | 67× |
| GALEN | 337 ms | 2 169 ms | **92 ms** | 1 308 ms | 4× |
| Roberts family | 2 071 ms | 29 025 ms | **61 ms** | 26 581 ms | 34× |
| LUBM schema + data | 1 265 ms | 4 627 ms | **404 ms** | 4 081 ms | 3× |

- **Package cold** = first call on a fresh `RdfReasoner`. Includes WASM init + binary encode + Worker RTT + full pipeline + decode + `store.addQuad`. Slower than native because of WASM init overhead — paid once per `RdfReasoner` instance.
- **Cache hit** = calling again on the **same unchanged store**. The TS layer computes a store fingerprint; if it matches the previous call, reasoning is skipped entirely. Cost = fingerprint computation only (no WASM call). **3–67× faster than running native Konclude.**
- **Re-reason** = calling again after adding one axiom. Full re-computation via `reset()` + `loadTripleBuffer()` + reasoning pipeline. WASM module and threads stay warm — no ~850 ms init overhead.

For interactive or editing workflows where the ontology changes occasionally, the cache-hit path is the key structural advantage over subprocess-based native Konclude.

---

## 4. Memory

Each `RdfReasoner` instance allocates **1 GB** of WebAssembly linear memory (fixed at startup, regardless of ontology size). Call `reasoner.terminate()` to release it. Multiple calls reuse the same memory — internal data structures are cleared between calls without reallocating.

---

## 5. Context

HermiT (via ROBOT/ODK) is the only other widely-used reasoner supporting full OWL 2 DL. Other reasoners (ELK, JFact) cover only OWL 2 EL or incomplete fragments.

- **ORE 2015 competition** (Parsia et al., *J. Automated Reasoning*, 59(4), 2017): Konclude placed 1st in all three OWL DL tracks; HermiT timed out on many complex ontologies.
- **Konclude system description** (Steigmiller et al., *J. Web Semantics*, 27–28, 2014): describes the completion-graph caching and dependency-directed backtracking optimizations that give Konclude its advantage on SROIQ workloads.
- **OWL reasoner survey** (Abicht, arXiv:2308.04600, 2023): Konclude as performance leader for OWL 2 DL; HermiT shows exponential blowup on ontologies heavy in role interactions and nominals.

---

## Reproducing These Results

```bash
# Prerequisites: built WASM binary + TypeScript, Docker for native + HermiT
npm run bench
```

Runs `node --expose-gc tests/bench/bench.mjs`. Each ontology runs in a separate subprocess for memory isolation. HermiT results require `docker pull obolibrary/odkfull:latest`.

Total runtime: ~20–25 minutes (HermiT adds ~10 min, mostly Roberts OOM timeout).
