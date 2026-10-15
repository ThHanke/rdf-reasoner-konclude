## Benchmark Results

```
Date:      2026-10-15
Package:   rdf-reasoner-konclude 0.8.0  (git 1bd5942; vendor/konclude 056334ad)
WASM:      dist/konclude.wasm sha256 a8e8134d27e1; pthread pool 32; Konclude processors 8
Native:    Konclude v0.7.0-1138 - 500e11d9 (image 49374483e311); threads 8 (-w AUTO)
HermiT:    1.9.10 (image 731aaa3c781f)
Host:      Intel(R) Xeon(R) Silver 4216 CPU @ 2.10GHz, 8 cores, 41 GB; load average at start 4.56
Runtime:   Node v25.1.0
```

Markers: † spread (max−min)/median above 10%; ‡ fewer than 5 samples (indicative only). Cells show median [min–max].

### § 1 Speed Benchmark

**Definitions.** *WASM ingest→result*: encode + `syncTripleBuffer()` + reasoning (includes the lazy parse/mapping) + output decode; WASM module start (*init*) is one-off and excluded. *Konclude total*: Konclude's own "Total processing time" inside the container (OWL/XML parse + reasoning + result serialisation; excludes container start). Ratios use only these two.

#### §1a TBox ontologies (classification) — end to end

| Ontology | Exp. | Triples | Konclude total | HermiT reason ⁴ | WASM ingest→result | WASM / Konclude |
|---|---|---|---|---|---|---|
| LUBM schema | SHI | 307 | 67 ms [67–68]‡ | 57 ms | 298 ms [286–352]† | ~4.4× |
| GALEN | SHIF | 30817 | 321 ms [317–321]‡ | 4692 ms | 1589 ms [1569–1649] | ~5.0× |

#### §1b ABox ontologies (realization) — classification path, and full role-closure realization

Native realization outputs rdf:type only and never computes role assertions; WASM `realization()` materialises the full role closure. Only the **classification path** is like-for-like: Konclude total minus its realization phase vs WASM `classification()` on the same input. The full-realization column is reported for reference and is **not comparable**.

| Ontology | Exp. | Triples | Konclude total (types only) | Konclude excl. realization ⁷ | WASM classification path (ingest→result) | WASM / Konclude (classification path) | WASM full realization (ingest→result, incl. role closure) |
|---|---|---|---|---|---|---|---|
| Roberts family | SROIQ | 3866 | 2205 ms [2098–2222]‡ | 1899 ms | 1854 ms [1835–1907]‡ | ~1.0× | 26748 ms [26511–27000]‡ |
| LUBM schema + data | SHI | 100850 | 1217 ms [1217–1229]‡ | 1215 ms | 2868 ms [2830–2894] | ~2.4× | 3508 ms [3477–3683] |

#### §1c WASM phase breakdown (breakdown only — do not compare phases across releases)

| Ontology | Op | init (one-off) | ingest (encode+sync) | reasoning | output decode | ingest→result | TS layer total ³ |
|---|---|---|---|---|---|---|---|
| LUBM schema | classification | 946 ms [894–1280]† | 1 ms [1–2]† | 294 ms [284–349]† | 2 ms [1–2]† | 298 ms [286–352]† | 467 ms [464–482] |
| GALEN | classification | 928 ms [892–999]† | 56 ms [55–61]† | 1511 ms [1487–1574] | 20 ms [19–23]† | 1589 ms [1569–1649] | 1940 ms [1905–1958] |
| Roberts family | realization | 909 ms [898–1433]†‡ | 11 ms [6–16]†‡ | 26333 ms [26122–26539]‡ | 399 ms [382–449]†‡ | 26748 ms [26511–27000]‡ | 29471 ms [28942–29744]‡ |
| LUBM schema + data | realization | 877 ms [783–900]† | 172 ms [170–188] | 2783 ms [2762–2957] | 541 ms [538–555] | 3508 ms [3477–3683] | 4307 ms [4222–4343] |

**Reading these numbers:**

- Single host, shared machine; numbers carry the host load average from the header. A difference smaller than the printed spread is not evidence of a difference.
- ³ "TS layer total" = one full public `RdfReasoner` call in a fresh process: Worker + module start, encode, sync, reasoning, output, `store.addQuad`. It includes startup that §1a/§1b exclude.
- ⁴ HermiT (via ROBOT/ODK) is a different reasoner run in Docker; "reason" = consistency + classification + axiom generation, excluding JVM start and parsing.
- ⁷ Konclude excl. realization = Konclude total − its `Finished (lazy) realization` phase; an approximation of parse + classification + serialisation.
- The earlier "WASM classify" column (2026-09-18 and before) excluded parse/mapping, which then lived in "load"; v0.8.0 performs that work lazily inside reasoning. Old and new phase columns are therefore not comparable. Details and the old-vs-new measurement: `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md`.
- WASM runs: warm-up and run counts are per case (`tests/bench/cases.mjs`); slow cases use fewer runs and are marked ‡.
- Outliers are never filtered. The Roberts *one axiom added* scenario shows an intermittent very slow call (maximum ~220 s against ~31–34 s typical): after a call that grows the WASM heap past 2 GiB, the next changed-content call recycles the Worker (terminate and start a new one in the same process). This is an open follow-up (`docs/next-session-prompt.md` item 4; `docs/solutions/performance-issues/ts-runner-in-process-slow-runs-2026-10.md`). The TS-layer cold numbers run one fresh process per measurement and are not affected.
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
| Roberts family | SROIQ | realization | 348562 | 0 | 348648 | 4552 | +348648 (×77.6 total) | 5902 |
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
| LUBM schema | SHI | 462 ms [439–493]† | 5 ms [3–6]† | 10 ms [8–16]† | 136 ms [111–147]† |
| GALEN | SHIF | 2000 ms [1963–2035] | 84 ms [74–88]† | 136 ms [132–138] | 1458 ms [1405–1465] |
| Roberts family | SROIQ | 29090 ms [28479–29364]‡ | 17 ms [14–17]†‡ | 1602 ms [1592–1737]‡ | 33840 ms [31293–220383]†‡ |
| LUBM schema + data | SHI | 4425 ms [4326–4484] | 278 ms [272–280] | 1368 ms [1367–1409] | 3695 ms [3641–3713] |

**Scenario definitions:**
- *cold*: first public call on a fresh `RdfReasoner` in a fresh process (includes Worker and WASM start). Each repetition of the four scenarios is its own process.
- *unchanged content*: same Store again. The call still encodes the whole Store and sends `sync`; the kernel compares its 128-bit content digest set with the previous one, answers "unchanged" and skips the rebuild. Cost = encode + one Worker round-trip, so it scales with store size, not with reasoning effort.
- *identical content, new Store*: a different Store instance with the same quads; the digest ignores Store identity, order and duplicates, so this is also a no-rebuild call.
- *one axiom added*: `rdfs:subClassOf owl:Thing` for a new class; the digest changes, the generation bumps and the ontology is rebuilt (full recompute on a warm Worker).
- Each scenario asserts the kernel counters (`syncStats` generation and rebuild count); the run aborts if the semantics differ.
- Native Konclude is a stateless batch CLI; no warm figure exists, so no ratio is shown. For repeated changed-content calls (stability and memory) see `tests/bench/sequential-runner.mjs`.
