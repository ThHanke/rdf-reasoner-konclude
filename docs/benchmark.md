## Benchmark Results

Latency and robustness of `repair()` (inconsistency repair) on ontologies from 312 to 100k quads: [`benchmark-repair.md`](benchmark-repair.md).

```
Date:      WASM columns 2026-11-12 (this release); Konclude and HermiT columns 2026-10-16 (recorded, not repeated)
Package:   rdf-reasoner-konclude 0.9.4 for the WASM columns; 0.8.0 (git b928e4c; vendor/konclude 056334ad) for the recorded columns
WASM:      dist/konclude.wasm sha256 dd01c43e2b91; pthread pool 32; Konclude processors 8
Native:    Konclude v0.7.0-1138 - 500e11d9 (image 49374483e311); threads 8 (-w AUTO)   [2026-10-16]
HermiT:    1.9.10 (image 731aaa3c781f)   [2026-10-16]
Host:      Intel(R) Xeon(R) Silver 4216 CPU @ 2.10GHz, 8 cores, 41 GB; load average at start 4.39 (2026-11-12 run), 5.35 (2026-10-16 run)
Runtime:   Node v25.1.0
```

The WASM columns of §1–§3 were re-measured for v0.9.4; native Konclude and HermiT were not run again, so their cells and the WASM / Konclude ratios use the 2026-10-16 native medians (same native image on the same host class, different load). PMDco is in §4.

Markers: † spread (max−min)/median above 10%; ‡ fewer than 5 samples (indicative only). Cells show median [min–max].

### § 1 Speed Benchmark

**Definitions.** *WASM ingest→result*: encode + `syncTripleBuffer()` + reasoning (includes the lazy parse/mapping) + output decode; WASM module start (*init*) is one-off and excluded. *Konclude total*: Konclude's own "Total processing time" inside the container (OWL/XML parse + reasoning + result serialisation; excludes container start). Ratios use only these two.

#### §1a TBox ontologies (classification) — end to end

| Ontology | Exp. | Triples | Konclude total | HermiT reason ⁴ | WASM ingest→result | WASM / Konclude |
|---|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | 67 ms [63–72]†‡ | 55 ms | 261 ms [249–273] | ~3.9× |
| GALEN | SHIF | 30817 | 322 ms [306–325]‡ | 4750 ms | 1126 ms [1098–1137] | ~3.5× |

#### §1b ABox ontologies (realization) — classification path, and full role-closure realization

Upstream Konclude's `realization` computes only concept realization by default and its OWL/XML output lists class assertions only. WASM `realization()` also runs the bulk role-realization step. The like-for-like native number is therefore the unmodified Konclude binary run with its own config key `Konclude.Calculation.Realization.RealizePrecomputation.RoleInstances=true` (⁸): it does the same bulk role realization, still serializes class assertions only. The classification path compares Konclude total minus its realization phase with WASM `classification()`.

| Ontology | Exp. | Triples | Konclude realization (types only) | Konclude excl. realization ⁷ | WASM classification path (ingest→result) | WASM / Konclude (classification path) | Konclude realization + role instances ⁸ | WASM full realization (ingest→result, incl. role closure) | WASM / Konclude (full) |
|---|---|---|---|---|---|---|---|---|---|
| Roberts family | SROIQ | 3866 | 2223 ms [2077–2282]‡ | 1909 ms | 1679 ms [1676–1742]‡ | ~0.9× | 40038 ms [32229–49872]†‡ | 29640 ms [29033–30218]‡ | ~0.7× |
| LUBM schema + data | SHI | 100850 | 1221 ms [1200–1255]‡ | 1219 ms | 2249 ms [2157–2469]† | ~1.8× | 1237 ms [1227–1255]‡ | 2616 ms [2573–2644] | ~2.1× |

#### §1c WASM phase breakdown (breakdown only — do not compare phases across releases)

| Ontology | Op | init (one-off) | ingest (encode+sync) | reasoning | output decode | ingest→result | TS layer total ³ |
|---|---|---|---|---|---|---|---|
| LUBM schema | classification | 886 ms [840–1125]† | 1 ms [1–2]† | 259 ms [247–270] | 1 ms [1–1] | 261 ms [249–273] | 415 ms [400–449]† |
| GALEN | classification | 917 ms [869–961] | 54 ms [49–58]† | 1051 ms [1024–1069] | 15 ms [14–27]† | 1126 ms [1098–1137] | 1649 ms [1639–1705] |
| Roberts family | realization | 859 ms [841–1324]†‡ | 7 ms [6–13]†‡ | 29244 ms [28755–29905]‡ | 307 ms [271–383]†‡ | 29640 ms [29033–30218]‡ | 27643 ms [27471–31282]†‡ |
| LUBM schema + data | realization | 854 ms [836–897] | 161 ms [158–162] | 2200 ms [2167–2216] | 255 ms [247–267] | 2616 ms [2573–2644] | 3702 ms [3651–3724] |

**WASM column against the recorded 0.8.0 run (same columns, different day and load):** LUBM schema 297 → 261 ms (−12 %), GALEN 1,594 → 1,126 ms (−29 %), Roberts classification path 1,854 → 1,679 ms (−9 %), LUBM + data classification path 2,870 → 2,249 ms (−22 %), LUBM + data full realization 3,550 → 2,616 ms (−26 %). **Roberts full realization is slower: 27,471 → 29,640 ms (+8 %, outside the recorded range, 3 samples each).** Warm behaviour: Roberts "unchanged content" is 59 ms against 17 ms recorded (not investigated). The Roberts one-axiom-added cell of the earlier run (105,520 ms, range 28,592–155,490 ms) contained the intermittent slow call named below; this run's samples were all typical. The explanation graph for Roberts has 5,900 quads (5,905 before).

**Reading these numbers:**

- Single host, shared machine; numbers carry the host load average from the header. A difference smaller than the printed spread is not evidence of a difference.
- ³ "TS layer total" = one full public `RdfReasoner` call in a fresh process: Worker + module start, encode, sync, reasoning, output, `store.addQuad`. It includes startup that §1a/§1b exclude.
- ⁴ HermiT (via ROBOT/ODK) is a different reasoner run in Docker; "reason" = consistency + classification + axiom generation, excluding JVM start and parsing.
- ⁸ Konclude realization + role instances: the unmodified `konclude/konclude` image, `realization -c roles.xml` with `Konclude.Calculation.Realization.RealizePrecomputation.RoleInstances=true` (default false); Konclude's own "Total processing time". Its output still lists class assertions only, but the bulk role-realization step (the one WASM requests) has run.
- ⁷ Konclude excl. realization = Konclude total − its `Finished (lazy) realization` phase; an approximation of parse + classification + serialisation.
- The earlier "WASM classify" column (2026-09-18 and before) excluded parse/mapping, which then lived in "load"; v0.8.0 performs that work lazily inside reasoning. Old and new phase columns are therefore not comparable. Details and the A/B measurement: `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md`.
- WASM runs: warm-up and run counts are per case (`tests/bench/cases.mjs`); slow cases use fewer runs and are marked ‡.
- Outliers are never filtered. Roberts *one axiom added* shows an intermittent very slow call (up to ~220 s against ~27-34 s typical). It is not caused by the Worker recycle: with recycling forced, with an awaited `terminate()` and with no recycle at all, roberts-160 shows the same 1.5-3x outliers (`tests/bench/recycle-probe.mjs`). It is the kernel step-time variance on identical input (`docs/solutions/performance-issues/ts-runner-in-process-slow-runs-2026-10.md`). The TS-layer cold numbers run one fresh process per measurement.
- LUBM+data native input: NTriples merged to RDF/XML via rdflib (auto-generated, .gitignored).


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
| LUBM schema | SHI | 44 | 44 | 44 | ✓ equal count | ✓ equal count |
| GALEN | SHIF | 3287 | 3348 | 3287 | ✓ equal count | 3348 (+61) |

TBox classification output is identical: same kernel, same Hasse diagram. Match is enforced by integration tests against golden fixtures (lubm-native-tbox.nt, galen-native-tbox.nt).

#### §2b ABox Realization — rdf:type (ClassAssertion)

Konclude native outputs ClassAssertion (rdf:type) only. HermiT via ROBOT also outputs ClassAssertion. WASM outputs the same set. Trivial `rdf:type owl:Thing` assertions are excluded from all counts (native emits them, WASM does not).

| Ontology | Exp. | Konclude rdf:type | HermiT rdf:type | WASM rdf:type | Konclude=WASM | HermiT vs Konclude |
|---|---|---|---|---|---|---|
| Roberts family | SROIQ | 4552 | FAIL | 4552 | ✓ equal count | — |
| LUBM schema + data | SHI | 39981 | 18143 | 39981 | ✓ equal count | 18143 (-21838) |

rdf:type output is identical to native. Exact match enforced by integration tests against golden fixtures (roberts-native-abox.nt, lubm-native-tbox.nt).

#### §2c WASM-only Output (native = 0 for all columns)

Native Konclude has no output path for role assertions, sameAs, or justifications.

| Ontology | Exp. | Op | Role assertions ⁶ | owl:sameAs ⁷ | WASM extra total | Native total ⁸ | Delta | Expl quads ⁹ |
|---|---|---|---|---|---|---|---|---|
| LUBM schema | SHI | classification | 0 | 0 | 0 | 44 | +0 (×1.0 total) | 55 |
| GALEN | SHIF | classification | 0 | 0 | 0 | 3287 | +0 (×1.0 total) | 4752 |
| Roberts family | SROIQ | realization | 348562 | 0 | 348648 | 4552 | +348648 (×77.6 total) | 5900 |
| LUBM schema + data | SHI | realization | 98497 | 0 | 98541 | 39981 | +98541 (×3.5 total) | 73984 |

**Capabilities notes:**
⁵ The "equal count" cells compare counts only. Set-level equality is enforced by the integration suite for rdf:type (golden fixtures `roberts-native-abox.nt`, `lubm-native-tbox.nt`, `galen-native-tbox.nt`). Known representation variance between builds, which count-equality hides: Konclude chooses one representative per class of equivalent roles (e.g. `hasChild` vs `isParentOf`) and per class of equivalent classes (`rdfs:subClassOf owl:Thing` is emitted for the representative only). `tests/bench/equivalence.mjs` compares role assertions modulo equivalent/inverse roles declared in the input.
⁶ Role assertions = ObjectPropertyAssertion + DataPropertyAssertion. Konclude computes these internally via CRoleRealization (full transitive closure); its OWL/XML serializer never writes them. `GetObjectPropertyAssertions` OWLlink = "not supported"; wildcard SPARQL `?p ?o` returns empty with "unsupported axiom types". Roberts family role count is large because there are 405 individuals with dense property chains (hasAncestor, isDescendantOf, hasCousin, etc.).
⁷ owl:sameAs: produced by our FP/IFP workaround. For FunctionalProperty/InverseFunctionalProperty with multiple fillers, native Konclude v0.7.0 hangs (upstream tableau bug in ALIF+ extension). Our C++ workaround strips FP/IFP declarations, pre-computes owl:sameAs for identical-individual groups, and emits those pairs. For 1-filler cases the normal tableau path is used (no workaround needed).
⁸ "Native total" = what native CLI writes. For TBox: SubClassOf+EquivalentClasses. For ABox: ClassAssertion only.
⁹ Justification quads: RDF-star triples in the explanation graph (`explanations: true`). Native Konclude has no explanation output. WASM-only feature. Count from first measured TS run (median timing in §1).
- "WASM extra total" = WASM total minus the comparable (native-matchable) portion. "Delta" shows factor over native total.
- TBox classification: role assertions = 0 (no ABox individuals → no role fillers). sameAs = 0 (no individuals → no FP/IFP groups).

---

### § 3 Warm behaviour (one reasoner, repeated calls)

| Ontology | Exp. | cold (first call) | unchanged content | identical content, new Store | one axiom added (full rebuild) |
|---|---|---|---|---|---|
| LUBM schema | SHI | 432 ms [403–502]† | 3 ms [2–8]† | 7 ms [5–15]† | 108 ms [86–119]† |
| GALEN | SHIF | 1722 ms [1697–1771] | 83 ms [79–92]† | 132 ms [127–135] | 1067 ms [1057–1078] |
| Roberts family | SROIQ | 28064 ms [27204–28614]‡ | 59 ms [58–67]†‡ | 1702 ms [1690–1741]‡ | 28585 ms [28209–28917]‡ |
| LUBM schema + data | SHI | 3700 ms [3683–3717] | 285 ms [284–290] | 1327 ms [1316–1338] | 3274 ms [3251–3289] |

**Scenario definitions:**
- *cold*: first public call on a fresh `RdfReasoner` in a fresh process (includes Worker and WASM start). Each repetition of the four scenarios is its own process.
- *unchanged content*: same Store again. The call still encodes the whole Store and sends `sync`; the kernel compares its 128-bit content digest set with the previous one, answers "unchanged" and skips the rebuild. Cost = encode + one Worker round-trip, so it scales with store size, not with reasoning effort.
- *identical content, new Store*: a different Store instance with the same quads; the digest ignores Store identity, order and duplicates, so this is also a no-rebuild call.
- *one axiom added*: `rdfs:subClassOf owl:Thing` for a new class; the digest changes, the generation bumps and the ontology is rebuilt (full recompute on a warm Worker).
- Each scenario asserts the kernel counters (`syncStats` generation and rebuild count); the run aborts if the semantics differ.
- Native Konclude is a stateless batch CLI; no warm figure exists, so no ratio is shown. For repeated changed-content calls (stability and memory) see `tests/bench/sequential-runner.mjs`.

### § 4 PMDco, the Ontosphere sequence: 0.8.0 vs 0.9.x vs the current branch

Sequence timed: `await reasoner.ready`, then `checkConsistency(store)`, then `materialize(store, { includeClassHierarchy: true })`, one fresh `RdfReasoner` per sample, init excluded. Fixture: Ontosphere PMDco (`pmdco.ttl` as N-Triples, 7,974 triples, 886 named direct subclass edges: `tests/fixtures/pmdco-ontosphere.nt`; 8 cores). Numbers are wall time and CPU-seconds (process CPU in Node, summed renderer-process CPU in Chromium 158). Repeat counts are 2–3 per cell on a quiet machine; **CPU-seconds are the stable figure**, wall time in Chromium varies by several seconds between runs when other work shares the host.

| Build | Node total (consistency + materialize) | Node CPU | Chromium total | Chromium CPU |
|---|---|---|---|---|
| 0.8.0 | 1.3–1.4 s (0.9 + 0.5) | 4.8 s | 1.8–2.6 s (1.1 + 0.7) | 7.5–8.1 s |
| 0.9.0 – 0.9.3 | 4.1–4.2 s (2.4 + 1.7) | 24.8 s | 17.4–19.3 s (9.7 + 9.0) | 111–114 s |
| current branch (wasm EH, wasm-opt, consistency-only, OR-branching stop flag) | 1.9 s (0.43 + 1.45) | 10.2 s | 2.0 s (0.45 + 1.55) | 12.5–12.9 s |

**Why 0.9.x was slower than 0.8.0 (the slowdown is real, and it is correctness work):** since 0.8.0 the KPSet classifier flushed its buffered possible-subsumption messages after it had collected the items to test, so ~4,760 candidate subsumptions (sibling pairs, almost all negative) were never tested and classification ended with untested candidates (0.8.0: 0 calculated tests; PMDco repo fixture loses 2 true edges, Pizza 70). Patch 009 (0.9.0) fixes this, which makes the classifier run the tests that unmodified Konclude runs. Unmodified native Konclude takes 9.6 s for the same classification on one worker; the WASM build takes 10.1–10.4 s on one pinned core, i.e. the WASM compute is within about 5–8 % of native. Bisect (variants of the 0.9.0 sources): patch 009 alone accounts for the whole Node and browser slowdown; patches 005–008 cost nothing.

**Why the browser was 10x and Node 3x:** the tableau ends every OR-branching task with a C++ exception (`CCalculationStopProcessingException`), about 324,000 per classification. One throw cost 3.1 µs in Node and 77–79 µs in Chromium 158 (measured in situ, throw to catch): 25 of the 35 CPU-s of the intermediate build. The current branch (1) uses native WebAssembly exceptions (`-fwasm-exceptions`) instead of the JS-based `-fexceptions`, (2) lets Binaryen optimize the module (wasm 10.4 MB → 7.05 MB, about 2.1 MB gzipped), (3) runs `checkConsistency` only up to Konclude's consistency step instead of a full classification (consistency 2.4 s → 0.4 s in Node), and (4) ends the task by a status flag instead of the exception on the direct rule chain (patch 005). The inferred triple sets equal the 0.9.x output on the checked fixtures.

Reproduce (`<pmdco.nt>` = `tests/fixtures/pmdco-ontosphere.nt`): `node tests/bench/pmdco-seq.mjs <packageRoot> <pmdco.nt>` (Node), `node tests/bench/browser-pmdco.mjs <packageRoot> <pmdco.nt> [runs]` (Chromium harness, CPU from the browser's process table), `scripts/bench-pmdco-node.sh <runs> label=<packageRoot>...` (alternating runs). Profiling builds with C++ function names: `KONCLUDE_PROFILING_FUNCS=ON make build-wasm`, then `node tests/bench/browser-profile.mjs <packageRoot> <pmdco.nt>`.
