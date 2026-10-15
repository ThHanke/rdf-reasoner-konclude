---
title: "Investigation log: non-deterministic / lossy role realization (isRelationOf) in the native port"
module: realizer / role realization
tags: [realization, nondeterminism, bisect, patches, native-harness, oracle]
problem_type: investigation
status: in-progress
updated: 2026-10-08
---

# Investigation log: lossy role realization

Living document. Update after every experiment. Plan: `docs/plans/2026-10-08-002-fix-nondeterministic-lossy-realization-plan.md` (local, gitignored).

## 1. Symptom

Fresh process, `tests/fixtures/roberts-family.nt`, realization: about 50% of runs lose a random number of role assertions. Expected total about 353,337 triples; observed 249k to 353k.

## 2. Tooling (committed)

| Tool | Purpose |
| --- | --- |
| `build-native/konclude_repro` (`src/native_repro.cpp`, `native/CMakeLists.txt`) | Native (no WASM, no N3) harness; `--mode reuse --runs 1` = one fresh-process sample; `--reread N` re-reads after a delay |
| `scripts/repro-sample.sh` / `make repro N=5` | N fresh-process samples vs oracle; exit 0 equal, 1 mismatch, 2 hang |
| `scripts/oracle/gen-oracle.py`, `canon.py`, `scripts/compare-fingerprint.py` | Oracle from **pristine upstream Konclude** (Qt build, outside repo at `~/konclude-orig`), canonicalization of equivalent/inverse properties, per-property fingerprints |
| `tests/fixtures/oracle/roberts-family.oracle.json` | Golden fingerprints; `known_deltas` documents the reflexive pair |
| `scripts/bisect-variants.sh` | Serial variant runner over `REPRO_*` env switches |
| `scripts/baseline-info.sh` | Prints commit / enabled patches / vendor diff hash for each run |
| `build-native-ordered/` (not committed) | Same kernel with `-DREPRO_ORDERED_QHASH=ON` (insertion-ordered QHash/QSet shim) |

Native-only `REPRO_*` switches (inert in WASM): `REPRO_THREADS`, `REPRO_SLOT_WAIT_MAX`, `REPRO_UNCHANGED_LABELS_COMPAT`, `REPRO_THREADED_UPDATE_SYNC`, `REPRO_AUTO_CLASSIFIER_SELECT`, `REPRO_NO_JUST_WALK`.

Gotchas: never `pkill -f <pattern>` from the Bash tool (kills its own shell, exit 144); `-w 1` hangs in upstream and in our build; a debug sample takes about 40 s.

## 3. Findings (chronological, with evidence)

1. **Pristine upstream is stable.** Role closure `isRelationOf` = 157,610 in 4/4 runs; only a tiny class-assertion flake (`PersonWithManySibling` 1 vs 2; about 1 in 5000). Upstream `-w 1` hangs.
2. **Loss is confined to one role.** In 5 samples, 46 of 47 role buckets equal the oracle exactly; only `isRelationOf` varies (-1 / -314 / -1,222 / -45,019).
3. **Sub-role is complete.** `isBloodRelationOf` (same extension) is intact in the same dump, so the loss is in sub->super role propagation into `isRelationOf`, per source individual, in chunks of 81/82/164 pairs.
4. **Deterministic reflexive delta.** Upstream emits `john_william_folland isRelationOf/isBloodRelationOf john_william_folland`; the port never does (-1 in both buckets, every sample). The readout has no self-skip, so the kernel does not hold it. Recorded as `known_deltas`.
5. **Not late completion.** Re-reading 10 s and 20 s later returns identical counts.
6. **Class and role hierarchies are identical in all samples** (165 non-role/non-type triples equal across 9 dumps incl. lossy). Classification is deterministic; the loss is in ABox role realization (OPSROLEREALIZE).
7. **Not config.** Setting our four overridden config values to upstream defaults together: still 3/6 lossy (baseline 3/6).
8. **Not thread count.** 2 threads 3/6, 4 threads 3/6, 8 threads about 3/6.
9. **Address-dependent, not a race.** With ASLR off (`setarch -R`) the loss is identical in 4/4 runs (-1,641 pairs).
10. **Uninitialized read in our override.** With `MALLOC_PERTURB_` the run segfaults in `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` (~line 1637): the WASM justification dependency-chain walker follows an uninitialized `getPreviousDependencyTrackPoint()` pointer (`0xaaaa...`). With the walker off (`REPRO_NO_JUST_WALK=1`): ASLR-off loss -1,641 -> -5, perturb no longer matters, ASLR-on 4/5 equal. Real bug, but not the sole cause (one sample still lost 11,747).
11. **Ordered QHash shim.** Insertion-ordered `QHash` (build-native-ordered): outputs nearly constant (353,325 in 5/6; outliers -264 / -289). So hash iteration order is a major factor.
12. **Ordered QHash + QSet is worse and discrete.** Only three outcomes (-104,170 / -13,349 / -11,623), 0/8 equal. With insertion order the outcome now follows thread interleaving. Conclusion: some code is **order-sensitive** (result depends on the order sets/hashes are filled/iterated), and the algorithm is correct for upstream's ordering only by luck of Qt hash behaviour.
13. **Patch 002 touches the realizer core** (suspect area): `COptimizedRepresentativeKPSetOntologyRealizingItem.cpp`, `...RealizingThread.cpp`, `CRealizingTestingStep.cpp`, `CRealizingCalculatedCallbackEvent.cpp/.h` (stamps / generation checks that can **drop** a callback event: `if (t && mTestingItem->mGeneration == mExpectedGeneration) postEvent`), `COntologyRealizingDynamicRequirmentCallbackData` (override + `takeCallback()`), `mOntItemHash` keyed by `{ontology, callGeneration}`.

14. **Dropped realizer callbacks ruled out.** gdb (ASLR off, deterministic -1,641): all 6,724 `CRealizingCalculatedCallbackEvent::doCallback` calls reached `postEvent`; the count is identical in the walker-off variant. Suspect "patch 002 drops events" is not the cause.
15. **Leading hypothesis (iterator invalidation).** `COptimizedRepresentativeKPSetOntologyRealizingThread::prepareRoleInitializingTestData` (and likely siblings) iterates a `QHash<cint64, ...>` via `constBegin()/constEnd()` while calling `addComplexRoleExplicitIndirectNeighbourLink`, which inserts into hashes. Qt's chained-node `QHash` tolerates insertion during iteration; our shim backs `QHash` with `robin_hood::unordered_node_map`, whose iterators are invalidated when an insert grows the table, so the loop reads freed memory (address-dependent, chunk-shaped loss, discrete outcomes, MALLOC_PERTURB sensitive). The insertion-ordered list-backed variant (finding 11) is stable under insertion, consistent with this. Test: `-DREPRO_STD_QHASH=ON` (std::unordered_map: node-stable iterators, stable end()) in `build-native-std/`.

16. **std::unordered_map-backed QHash (node-stable iterators): not the fix.** 5/8 equal (baseline 3/6), failures discrete (-2,059 x2, -25,988). Iterator invalidation of the robin_hood map is at most a minor contributor; hypothesis 15 is demoted. Next tool: AddressSanitizer (`-DREPRO_ASAN=ON`, `build-native-asan/`), which names use-after-free / overflow directly (address-dependent + perturb-sensitive + deterministic with ASLR off = memory-error signature).

17. **ASan clean after patch 017 (and with benign type-mismatch checks off).** Not a heap/stack corruption. Patch 017 fixes a real upstream bug (`*limit--` decrementing the pointer; stack-garbage dependent merging limit) but does not cure the loss (1/8 equal afterwards).
18. **Realizer state at the end of a deterministic lossy run** (`--dump-role isRelationOf`, `setarch -R`, 3 identical runs): the `isRelationOf` role item has complex data for all 397 individuals, **all marked initialized (successor direction)**, `hasOnlyTransitiveComplexRoleCandidates=0` (so initialization went through the role-candidate **test** path, not the transitive-closure path), but the stored explicit successor links total only 155,374 vs about 157.6k needed. 378 of 397 individuals are 1-14 links short. So initialization completes with incomplete data; nothing marks failure.
19. **The missing set is coherent.** In one deterministic layout the lost targets are the same 12 "archer" individuals missing from about 395 sources each: a cluster reachable only through specific edges, not random pairs. Sub-roles (`isBloodRelationOf`, transitive `hasAncestor` etc.) are 100% complete in the same dump, so the loss is in the **super-role aggregation / candidate-test path for isRelationOf**.
20. **Layout dependence is per binary.** Any code change shifts the (deterministic) layout and therefore the loss value (-2188, -78,402, ...); compare variants only within one binary.
21. **Pointer-hash seed experiment** (in progress): `REPRO_HASH_SEED=<n>` mixes a seed into every pointer hash (QHash/QSet shim and `qHash(T*)`), reordering pointer-keyed containers without changing heap layout. If the loss varies with the seed while ASLR is off, container iteration order is the cause; then bisect by container class.

22. **CONFIRMED: loss is a deterministic function of the pointer-hash seed (ASLR off).** Seeds 0 and 5 EQUAL to the oracle; seeds 1-4 lose 20k-108k `isRelationOf` pairs. Pointer-keyed container iteration order decides correctness; the realizer/kernel has an order-sensitive algorithm. Seeds are deterministic one-run test vectors (`REPRO_HASH_SEED=n setarch -R konclude_repro ...`, ~45 s).
23. **Type-filter bisect is chaotic, not monotone** (`REPRO_SEED_TYPES`): seeding only Realizer / Ontology / Kernel / Cache key types is EQUAL for seeds 2 and 4; the union "Realization,Classifier,Consistiser,Triples,Preprocess,Query,Answerer" fails (-39k) while any proper subset I tried passes. So no single container class is "the" culprit: the algorithm is sensitive to the *combined* processing order (e.g. order in which individuals/roles/items get processed), and which combinations break is chaotic. Next approach must find the order-sensitive algorithm itself (first divergence between a good seed and a bad seed), not a culprit container.
24. **Realizer state, correctly read (known vs possible).** Readout only emits links with `mKnownInstance`. Failing seeds end with the full candidate set stored (155,374 links in every seed) but many links still *possible, never tested* (`possibleTested=0`, `possibleTestingStillSet=0`): seed 2 known 74,817 / possible 80,557; seed 3 known 152,646 / possible 2,728; missing pairs == possible count (+1 reflexive). Good seeds: possible = 0. Role hierarchy (direct/indirect super roles) identical in good and bad seeds; role tags differ per seed (assigned in address-dependent order), so never compare tags across seeds.
25. **ROOT CAUSE: complex role candidates are queued for confirmation only once, at marking time.** In failing seeds the `isRelationOf` role item ends with `hasComplexCandidates=1, complexQueuedFlag=0` and the item-level confirmation queue empty. `COptimizedRepresentativeKPSetOntologyRealizingItem::markIntanceItemForRoleRealization` queues a role item (`addRoleInstanceItemToProcessComplexCandidateInstances`) exactly once and only if it already has candidates; candidates are created later (`addComplexRoleExplicitIndirectNeighbourLink`, the only creator, from marker-candidate messages and direct collection). A candidate arriving after marking is never queued, the realizer runs out of work, OPSROLEREALIZE completes, and unconfirmed links are dropped by the readout. Whether candidates exist at marking time depends on processing order, hence on container iteration order (pointer hashes, address layout). Also: `COptimizedKPSetRoleInstancesItem::takeNextTestingComplexInstanceCandidate` guards on `hasPossibleInstances()` (the other candidate set) instead of `hasComplexInstanceCandidates()`, and the queued flag is never reset on dequeue. All three are **identical in pristine upstream**; upstream's flake rate is just much lower because Qt's hash order usually lets candidates exist early.
26. **Fix = patch 019** (event-driven queueing when a candidate is added to an already-marked item; reset the queued flag on dequeue; correct the take-next guard). Verified on the deterministic seed vectors that failed before: seeds 5, 6, 7 EQUAL (previously -14k, -98k, -248 pairs). Seed 8 (previously 132k unconfirmed) now needs ~132k real confirmation tests and takes much longer than the 380 s watchdog (see below).

## 4. Ruled out / not the cause

- Late completion, config knobs (the four), thread count, classification, TS/WASM bridge, readout self-skip.

## 5. Open suspects (ranked)

0. (Demoted by finding 16) QHash shim iterator invalidation on insert-during-iteration.
0b. **Memory error (use-after-free / uninitialized / overflow) in kernel, our patches, or overrides — leading; ASan next.**
1. (Ruled out by finding 14) Patch 002 generation/stamp logic in the realizer callback path (event dropped when `mGeneration != expectedGeneration`, or event posted to null after `exchange`) — a dropped realization callback would silently lose a chunk of role-propagation work. Check: count dropped events (log in `CRealizingCalculatedCallbackEvent`), expect >0 in lossy runs.
2. Order-sensitive iteration in the realizer role code (`COptimizedKPSetRoleInstances*`, `...RoleNeighbourInstancesHashData`, `...CombinedNeighbourRoleSetCacheLabel*`), touched by patch 005 (destructors) and the QHash/QSet shim semantics (iterator invalidation on insert with robin_hood).
3. Override `COntologyRealizingDynamicRequirmentCallbackData.cpp` (wholesale replacement of the callback bookkeeping).
4. BackendAssCache interaction (patch 003 cache sync/no-thread; `CBackendRepresentativeMemoryCache.cpp` +67 lines).

## 6. Patch / override inventory and decisions

Status legend: KEEP = needed (reason known); SUSPECT = being investigated; FIX = real bug to fix; UNKNOWN = necessity not yet verified; PARKED = not applied.

| Item | What it does | Status | Notes |
| --- | --- | --- | --- |
| 000 qt-removal | Qt type substitutions (171 files) | KEEP | Required to compile |
| 001 compile-prereqs | atomic STPU, composite keys, call-generation API | KEEP | Required; call-generation API is used by 002 |
| 002 pthread-core | atomic callbacks, stamps, yield, mutex, KPSet nondeterminism, destructors | **SUSPECT** | Touches realizer event path; verify dropped-event hypothesis (suspect 1) |
| 003 cache-sync | 6 caches mutex-protected / no-thread | UNKNOWN | Needed for single-thread-style WASM; test each cache's sync mode against oracle |
| 004 sequential-call-perf | BackendAssCache reset, tag-based SatExpCache | KEEP (perf) | Not implicated; revisit when doing incremental |
| 005 multi-call-memory | destructors for single-run assumptions | SUSPECT (low) | Realizer destructors; unlikely to change results of one call |
| 006 alif-fix | ALIF+ fix | KEEP | Unrelated |
| 007 owl2dl-conformance | NPA, asymmetric/irreflexive clash checks | KEEP | Unrelated to role closure |
| 008 kpset-classifier | ordering determinism | KEEP | Classification already deterministic (finding 6) |
| 009 processing-set-clear | clear processing sets per pipeline | KEEP | Needed for sequential calls; not implicated in single call |
| 011 kpset-drain-loop-fix | itDownPoss -> itPoss | KEEP | Upstream bug fix (crash at call 4) |
| 010, 012-016 | counter fix, realizer cleanup/deep cleanup, slot GC, reader removal | PARKED | Experiments for the sequential hang; not applied; do not enable until baseline is fixed |
| override CSatisfiableTaskClassificationMessageAnalyser | justification capture | **FIX** | Walker reads uninitialized pointers (finding 10): guard / re-implement |
| override COntologyRealizingDynamicRequirmentCallbackData | WASM callback bookkeeping | SUSPECT | See suspect 3 |
| override CPrecomputationManager, CPreprocessingManager, CClassificationManager | synchronous WASM managers | UNKNOWN | Classification output identical across samples, so low priority |
| override CThread, CIntervalThread, CSingleThreadTaskProcessorUnit | pthread threading model | UNKNOWN | Thread count not the cause; keep |
| WasmConfigProvider: SlotUpdateWaitingIncreaseMaximumCount=0, InterpretUnchangedLabelsAsCompatible=true, ThreadedUpdateSynchronization=false, AutomatedOptimizedClassifierSelection=false | WASM tuning | UNKNOWN (not the cause) | Each fixes a documented symptom (sameAs, KPSet forcing); do not remove without sameAs / unsat-class regression coverage |
| QtCompat QHash (robin_hood, vector buckets) / QSet (unordered_set) | Qt container shim | SUSPECT | Order sensitivity (findings 11-12); decide after realizer-code check |

## 7. Next steps

1. Instrument the realizer callback path (native-only counters): events created / posted / dropped by generation mismatch / dropped by null `exchange`; compare lossy vs complete runs (use ASLR-off, deterministic).
2. If drops are confirmed: fix the stamp/generation logic in patch 002 via `scripts/new-multi-file-patch.sh`; re-run `make repro N=10` (aim 10/10) and the ordered-shim build as a robustness check.
3. If not: bisect realizer-item code order sensitivity (sorted iteration in the role instance / neighbour hash code).
4. Fix the justification walker (finding 10) regardless.
5. Decide the reflexive-pair delta (finding 4): where does upstream emit it (likely a sameAs-derived self role); then remove `known_deltas`.
6. Then: WASM rebuild + `make repro`-equivalent multi-process WASM sampling; follow-up plan for the C++ incremental API.
