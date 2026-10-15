## Benchmark Results

```
Native:  Konclude v0.7.0-1138 - 500e11d9 (konclude/konclude:latest)
ROBOT:   1.9.10 + HermiT (obolibrary/odkfull:latest)
Ported:  vendor/konclude @ 056334ad (submodule)
Threads: 8 (native -w AUTO / WASM pthreads)
Date:    2026-10-15
```

### § 1 Speed Benchmark

> **Comparable columns:** "WASM classify ²" vs "Konclude TBox ²" — same kernel, different runtime. "HermiT reason ⁴" vs "Konclude TBox ²" — different reasoner, same OWL 2 DL logic.
> ABox realization times (role closure) are shown separately and are **not** comparable between systems.

| Ontology | Exp. | Input | Konclude parse ¹ | Konclude TBox ² | Konclude realize | HermiT JVM+parse | HermiT reason ⁴ | HermiT fill+write | WASM init ⁰ | WASM load ¹ | WASM classify ² | WASM realization ⁶ | WASM output | TS total ³ | WASM/Konclude ² | HermiT/Konclude ⁴ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | 5 ms | 31 ms | n/a | 411 ms | 54 ms | 31 ms | 947 ms | 1 ms | 283 ms | n/a | 1 ms | 432 ms | ~9.1× | ~1.7× |
| GALEN | SHIF | 30817 | 61 ms | 217 ms | n/a | 1929 ms | 4530 ms | 202 ms | 914 ms | 54 ms | 1500 ms | n/a | 21 ms | 1890 ms | ~6.9× | ~20.9× |
| Roberts family | SROIQ | 3866 | 25 ms | 1707 ms | 299 ms | FAIL | FAIL | FAIL | 866 ms | 7 ms | 1858 ms | 26345 ms | 367 ms | FAIL | ~1.1× | — |
| LUBM schema + data | SHI | 100850 | 826 ms | 156 ms | 4 ms | 3598 ms | 1085 ms | 2501 ms | 906 ms | 175 ms | 2647 ms | 2780 ms | 537 ms | 4273 ms | ~17.0× | ~7.0× |

**Speed notes:**

⁰ "WASM init" = `createKoncludeModule()` + `new KoncludeReasoner()` — WASM compilation, memory allocation (1 GB linear memory), pthread pool startup. **Integration-specific overhead** with no native equivalent (native starts as a process). Excluded from the comparable ratio. Amortized in real use: the TS layer creates the module once and reuses it across calls.

¹ "Native parse" = OWL/XML parsing; "WASM load" = binary encode + `syncTripleBuffer()` (content digest + store of the buffers; Raptor parsing + `mapTriples()` happen lazily inside the first `classification()`/`realization()`). Different input formats → **not comparable**.

² **Comparable column.** Both run the same Konclude pipeline: triples-mapping → active-count → build → preprocess → consistency → precompute-saturation → class-classify → property-classify. "Native TBox" = preprocess + precompute + classify + propClassify (from Konclude verbose log, same pipeline steps). "WASM classify" = `classification()` wall-clock (same pipeline via `prepareOntology()`). For ABox cases, a **separate classification-only pass** is run so role-closure overhead does not inflate the number.

³ "TS total" = binary encode + Worker `postMessage` + WASM init + load + classify + output decode + `store.addQuad`. Includes init overhead + output serialization. For ABox cases includes role assertions that native never emits. Median of 5 measured runs.

⁴ **HermiT comparison.** HermiT is a different OWL 2 DL tableau reasoner (Java-based, run via ROBOT/ODK Docker). "HermiT JVM+parse" = JVM startup + OWLAPI parsing (no Konclude equivalent — different runtime). "HermiT reason" = consistency check + classification + axiom generation. "HermiT fill+write" = OWL/XML serialization. HermiT/Konclude ratio compares pure reasoning time. Roberts may timeout (HermiT is significantly slower on SROIQ).

⁶ "WASM realization" = `realization()` timing — runs the full pipeline including 4 extra ABox steps: initRealize → conceptRealize → roleRealize → sameIndividualsRealize. The roleRealize step computes full transitive role closure (CRoleRealization) producing 271k+ role fillers for Roberts. Native realization may skip or short-circuit roleRealize since it never serializes role assertions. **Not** comparable to native realize time.

- Konclude native: 3 runs per ontology, median. WASM: 1 warm-up + median of 3 measured. TS: 2 warm-ups + median of 5 measured. HermiT: 3 runs median. Node.js v25.1.0, pthreads (PTHREAD_POOL_SIZE=8).
- LUBM+data native input: NTriples merged to RDF/XML via rdflib (auto-generated, .gitignored).

**Overhead analysis (measured 2026-10-15):**

- **Fixed overhead:** `WASM init` (~0.9 s: module compile, 1 GB linear memory, pthread pool) is paid once per Worker and excluded from the comparable ratio. Small inputs (LUBM schema, 307 triples) are dominated by thread-coordination round-trips across the WASM↔JS boundary: 283 ms WASM vs 31 ms native (~9×).
- **Data-heavy inputs are slowest relative to native:** GALEN (30k triples, SHIF) ~7× and LUBM+data (100k triples, SHI) ~17× native classification. Steps that walk all loaded triples (build, preprocess, active-count) run slower in WASM linear memory.
- **Compute-heavy tableau workloads converge:** Roberts (SROIQ) classification is ~1.1× native (1858 ms vs 1707 ms).
- **Realization with role closure is not comparable:** Roberts `realization()` takes ~26 s in WASM because it materializes ~349k role assertions; native realization (299 ms) never computes or writes them.
- **No predictive model is published.** An earlier fixed-cost + per-expressiveness scaling model (230 ms + factor) was calibrated on 2026-09-18 numbers (GALEN 544 ms, LUBM+data 1169 ms) that do not reproduce: on 2026-10-15 main and this branch both measure GALEN at ~2.0 s end-to-end, so the model under-predicts. Treat any extrapolation to untested ontologies as unmeasured.
- Investigation notes: `docs/solutions/performance-issues/wasm-preprocessing-overhead-2026-09-15.md`.

**HermiT comparison context:**

HermiT (via ROBOT/ODK) is a Java-based OWL 2 DL tableau reasoner. On simple TBox ontologies (LUBM, SHI) it is comparable to Konclude. On medium-complexity ontologies (GALEN, SHIF) it is ~20× slower. On hard SROIQ ontologies with many individuals and property chains (Roberts family) HermiT does not complete within the timeout — it fails with `java.lang.OutOfMemoryError: Java heap space`. This matches published benchmarks: the ORE 2015 competition report notes Konclude "had the best performance on large and very large ontologies" while HermiT "for classification and realization tasks, was outperformed by the other reasoners" ([Parsia et al. 2017](https://link.springer.com/article/10.1007/s10817-017-9406-8)). The Konclude system description reports aggregate classification time of 3,893s vs HermiT 7,076s across 484 ontologies — but the gap is much larger on the hard SROIQ tail ([Steigmiller et al. 2014](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.090/Publikationen/2014/StLG14a.pdf)). A 2023 survey confirms HermiT is "slower than [other] reasoners" for classification, "although HermiT had much fewer timeouts" overall ([Abicht 2023](https://arxiv.org/pdf/2309.06888)).

---

### § 2 Capabilities Benchmark

> Each sub-section covers a distinct operation and output type.
> "WASM extra" = triples WASM emits that native cannot produce at all.

#### §2a TBox Classification — SubClassOf + EquivalentClasses

Three systems: Konclude native (OWL/XML), HermiT/ROBOT (OWL Functional), WASM port (NTriples).

| Ontology | Exp. | Konclude TBox | HermiT TBox | WASM TBox | Konclude=WASM | HermiT vs Konclude |
|---|---|---|---|---|---|---|
| LUBM schema | SHI | 44 | 44 | 44 | ✓ exact | ✓ exact |
| GALEN | SHIF | 3287 | 3348 | 3287 | ✓ exact | 3348 (+61) |

TBox classification output is identical: same kernel, same Hasse diagram. Match is enforced by integration tests against golden fixtures (lubm-native-tbox.nt, galen-native-tbox.nt).

#### §2b ABox Realization — rdf:type (ClassAssertion)

Konclude native outputs ClassAssertion (rdf:type) only. HermiT via ROBOT also outputs ClassAssertion. WASM outputs the same set. Trivial `rdf:type owl:Thing` assertions are excluded from all counts (native emits them, WASM does not).

| Ontology | Exp. | Konclude rdf:type | HermiT rdf:type | WASM rdf:type | Konclude=WASM | HermiT vs Konclude |
|---|---|---|---|---|---|---|
| Roberts family | SROIQ | 4552 | FAIL | 4552 | ✓ exact | — |
| LUBM schema + data | SHI | 39981 | 18143 | 39981 | ✓ exact | 18143 (-21838) |

rdf:type output is identical to native. Exact match enforced by integration tests against golden fixtures (roberts-native-abox.nt, lubm-native-tbox.nt).

#### §2c WASM-only Output (native = 0 for all columns)

Native Konclude has no output path for role assertions, sameAs, or justifications.

| Ontology | Exp. | Op | Role assertions ⁶ | owl:sameAs ⁷ | WASM extra total | Native total ⁸ | Delta | Expl quads ⁹ |
|---|---|---|---|---|---|---|---|---|
| LUBM schema | SHI | classification | 0 | 0 | 0 | 44 | +0 (×1.0 total) | 55 |
| GALEN | SHIF | classification | 0 | 0 | 0 | 3287 | +0 (×1.0 total) | 4752 |
| Roberts family | SROIQ | realization | 348562 | 0 | 348648 | 4552 | +348648 (×77.6 total) | FAIL |
| LUBM schema + data | SHI | realization | 98497 | 0 | 98541 | 39981 | +98541 (×3.5 total) | 73984 |

**Capabilities notes:**
⁵ TBox match and ABox rdf:type match are enforced by the integration test suite (assertExactMatch against golden fixtures). Same Konclude kernel; only the output serializer differs.
⁶ Role assertions = ObjectPropertyAssertion + DataPropertyAssertion. Konclude computes these internally via CRoleRealization (full transitive closure); its OWL/XML serializer never writes them. `GetObjectPropertyAssertions` OWLlink = "not supported"; wildcard SPARQL `?p ?o` returns empty with "unsupported axiom types". Roberts family role count is large because there are 405 individuals with dense property chains (hasAncestor, isDescendantOf, hasCousin, etc.).
⁷ owl:sameAs: produced by our FP/IFP workaround. For FunctionalProperty/InverseFunctionalProperty with multiple fillers, native Konclude v0.7.0 hangs (upstream tableau bug in ALIF+ extension). Our C++ workaround strips FP/IFP declarations, pre-computes owl:sameAs for identical-individual groups, and emits those pairs. For 1-filler cases the normal tableau path is used (no workaround needed).
⁸ "Native total" = what native CLI writes. For TBox: SubClassOf+EquivalentClasses. For ABox: ClassAssertion only.
⁹ Justification quads: RDF-star triples in the explanation graph (`explanations: true`). Native Konclude has no explanation output. WASM-only feature. Count from first measured TS run (median timing in §1).
- "WASM extra total" = WASM total minus the comparable (native-matchable) portion. "Delta" shows factor over native total.
- TBox classification: role assertions = 0 (no ABox individuals → no role fillers). sameAs = 0 (no individuals → no FP/IFP groups).

---

### § 3 Incremental Reasoning Benchmark

> Native Konclude is a batch CLI — every invocation is a full cold start.
> Our TS layer keeps the Worker alive, enabling cache hits and warm re-reasoning.

| Ontology | Exp. | Native cold ¹⁰ | TS cold ¹¹ | TS cache hit ¹² | TS re-reason ¹³ | Speedup (cache) | Speedup (re-reason) |
|---|---|---|---|---|---|---|---|
| LUBM schema | SHI | 70 ms | 498 ms | 6 ms | 148 ms | 12× | 0.5× |
| GALEN | SHIF | 313 ms | 2115 ms | 75 ms | 1373 ms | 4× | 0.2× |
| Roberts family | SROIQ | 2047 ms | 39197 ms | 16 ms | 32550 ms | 128× | 0.1× |
| LUBM schema + data | SHI | 1224 ms | 4667 ms | 270 ms | 3724 ms | 5× | 0.3× |

**Incremental notes:**
¹⁰ "Native cold" = full Docker invocation: process spawn + OWL/XML parse + full reasoning pipeline + output serialization. From §1 native total. There is no warm/incremental path — native Konclude is a stateless CLI tool.
¹¹ "TS cold" = first `classify()`/`materialize()` on a fresh `RdfReasoner` instance. Includes WASM init + binary encode + Worker RTT + full pipeline + decode + store.addQuad.
¹² "TS cache hit" = second call on **unchanged** store. The TS layer encodes the store and sends `sync`; C++ compares its 128-bit content digest set with the last one and answers `changed=false`, so classify/realize are idempotent per generation and skipped. Cost = encode + one Worker round-trip.
¹³ "TS re-reason" = call after adding 1 axiom (`rdfs:subClassOf owl:Thing`). Content digest changes (C++ `generation` bump) → ontology rebuilt lazily by `classification()`/`realization()`. But Worker stays alive: no WASM module init, no pthread pool startup. The WASM init (~850 ms) is amortized.
- Native has no incremental reasoning. Every invocation pays the full cold-start cost. The WASM port's persistent Worker is a structural advantage for interactive/iterative use.
- Each scenario uses a single store on one Worker. Repeated changed-content calls (stability, memory) are measured separately with `tests/bench/sequential-runner.mjs`.
