---
title: "fix: Remaining work after the lossy-realization fix — verify, triage, incremental C++ core, thin TS layer, performance"
type: fix
status: active
date: 2026-10-09
origin: docs/plans/2026-10-08-002-fix-nondeterministic-lossy-realization-plan.md
---

# Remaining work after the lossy-realization fix

## Overview

Patch 019 (plus 017, 018) fixes the non-deterministic loss of role assertions in the native build (8/8 fresh-process samples equal to the pristine-upstream oracle). The rebuilt WASM binary is committed (`build: rebuild WASM with patches 017-019`). Full suite on the new binary: **573 passed, 10 failed, 3 skipped**. This plan orders the remaining work by priority. The user's original goal remains the centre of gravity: **the Konclude kernel does incremental classify + realize on a kept-alive reasoner; the TS layer only does N3 store integration/persistence.** (Per user decision 2026-10-09 the TS layer and the sequential-call tests will be reworked anyway.)

Read first: `docs/next-session-prompt.md`, `docs/solutions/best-practices/native-debug-pipeline-playbook.md`, `docs/solutions/debugging/realization-loss-investigation.md`, `docs/solutions/architecture-patterns/konclude-native-incremental-revisions.md`.

## Priorities at a glance

| Prio | Unit | Why now |
| --- | --- | --- |
| P0 | U1 WASM verification of patch 019 (multi-process oracle sample) | The fix is only proven natively; the product is WASM |
| P0 | U2 Failure triage record (10 failures classified) | Avoid chasing tests that are going to be rewritten; isolate real regressions |
| P1 | U3 Two `property-characteristics` hangs (disjointUnionOf, NegativePropertyAssertion) | Real hangs in small ontologies, failing in isolation, predate this session; native harness can reproduce |
| P1 | U4 Justification walker reads uninitialized pointers | Memory-safety bug in our override that ships in WASM |
| P1 | U5 Make revisions truly incremental (native) | The user's goal; research already done |
| P2 | U6 C++ incremental API + Embind | Needs U5 |
| P2 | U7 Thin TS layer + rewritten sequential tests | Needs U6; replaces the 7 sequential failures |
| P2 | U8 Reflexive-pair delta (`x isRelationOf x`) | Deterministic small output difference vs upstream |
| P3 | U9 Performance tuning on the native bench | Reuse the debug pipeline; needs an `-O2` build and profiler |
| P3 | U10 Patch/config hygiene (parked patches, WASM config tunings, patch 018) | Reduce surface area |
| P3 | U11 Documentation (ce-compound entries, README, CLAUDE.md commands) | Capture learnings |

## Current failure inventory (full suite, new WASM build)

| Failures | Class | Plan |
| --- | --- | --- |
| `hang-debug` (2), `hang-minimal` (3), `warmup-sequential` (2) | Sequential-call tests exercising today's reset+reload orchestration; 120 s timeouts (known sequential-call hang) | U5-U7: rewritten for the new API; do not diagnose against the old TS behaviour |
| `property-characteristics`: `disjointUnionOf`, `NegativePropertyAssertion` | 30 s timeouts, reproduce in isolation, already failing before this session | U3 |
| `explanation-perf`: "materialize: explanation overhead < 500%" | Timing ratio; realization now does the previously skipped confirmation tests, which shifts the ratio | U2 (re-measure; adjust threshold only with justification) |

## Implementation Units

- [x] **Unit 1 (P0): WASM verification of the realization fix**

**Goal:** Prove on the shipped WASM binary what the native sampler proved natively.

**Files:**
- Create: `scripts/wasm-sample.mjs` (spawns N fresh Node processes; each loads Roberts via `RdfReasoner`, materializes, writes sorted NTriples; parent compares per-property buckets with `scripts/compare-fingerprint.py` / the oracle JSON)
- Modify: `Makefile` (`make repro-wasm`)
- Test: runs as a script, plus a smoke vitest that checks one sample against the oracle

**Approach:** One reasoner per process (a worker pool exhausts pthreads if recreated). Compare only gated buckets; `rdf:type` is not gated. Use the same canonicalization (`scripts/oracle/canon.py`).

**Test scenarios:** Happy path: 8/8 samples equal oracle. Error path: a hang is reported by timeout, not silently skipped. Edge: output differing only by equivalent-property representative is equal.

**Verification:** `make repro-wasm N=8` passes; record per-sample wall time (WASM vs native `-O1`).

- [x] **Unit 2 (P0): Triage record**

**Goal:** One table of every failing test, with cause, owner unit and "expected to change".

**Files:** Modify `docs/solutions/debugging/realization-loss-investigation.md` (appendix) or a short `docs/solutions/debugging/wasm-suite-status-2026-10-09.md`.

**Approach:** Re-run `explanation-perf` alone twice; record the ratio before/after patch 019 (git stash is not needed: compare against the previous binary at `a978980` if rebuilt; otherwise justify with the realization step timing). Decide threshold change only with data.

**Verification:** Every one of the 10 failures has a class and a unit.

- [x] **Unit 3 (P1) — reclassified, see docs/solutions/debugging/wasm-suite-status-2026-10-09.md: Two property-characteristics hangs**

**Goal:** Find why `disjointUnionOf` and `NegativePropertyAssertion` ABox cases time out (30 s) on WASM.

**Files:**
- Modify: `src/native_repro.cpp` only if a mode is needed (the harness already runs any `.nt`); create `tests/fixtures/pc-disjoint-union.nt`, `tests/fixtures/pc-negative-property.nt` extracted from the test file
- Possibly patches under `patches/` (via `scripts/new-multi-file-patch.sh`)

**Approach:** Reproduce natively with `konclude_repro --mode reuse` on each fixture (the native build has the same patches). If native completes, compare WASM-only behaviour (pthread pool size, async/sync paradigm). If native hangs, use the playbook: watchdog abort, gdb backtrace of all threads, `--dump-role`. Check first whether patch 019's `hasToProcessPossibleInstancesFlag` re-queue can loop on tiny ontologies; the failures predate 019, so also check the older suspects (processing set stale entries, patch 009).

**Test scenarios:** Both vitest cases pass; native `make repro`-style run on both fixtures completes < 10 s; add them as regression fixtures in the native sampler.

**Verification:** `npx vitest run tests/integration/property-characteristics.test.ts` green.

- [x] **Unit 4 (P1): Justification walker uninitialized pointers**

**Goal:** Remove the memory-safety bug found with `MALLOC_PERTURB_` (override `CSatisfiableTaskClassificationMessageAnalyser.cpp`, the WASM justification dependency-chain walker follows an uninitialized `getPreviousDependencyTrackPoint()`).

**Files:** Modify `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp`; test via native harness and `tests/integration/*justification*`.

**Approach:** Find which dependency nodes legitimately have no previous track point and what the vendor code treats as the end marker (use graphify on `CDependencyNode` / `CDependencyTrackPoint`); guard on that, or bound the walk by validity flags. Keep `REPRO_NO_JUST_WALK` as a diagnostic switch.

**Test scenarios:** `MALLOC_PERTURB_=85 setarch -R konclude_repro ...` no longer crashes; justification tests still pass (native-justification suites); oracle equality unchanged.

**Verification:** Perturbed run completes; justification tests green.

- [~] **Unit 5 (P1) PAUSED 2026-10-10: Konclude has no working incremental realizer; see konclude-native-incremental-revisions.md. U6/U7 proceed with result caching**: Make revisions truly incremental (native)**

**Goal:** `addRevisionNTriplesStr` + `realization()` reuses work (log shows incremental threads, far fewer individual updates and tests) and equals a from-scratch run.

**Files:** Modify `src/KoncludeReasoner.cpp` (revision handling, `runPipeline`), `src/compat/overrides/CPrecomputationManager.cpp`, `src/compat/overrides/CClassificationManager.cpp` (restore upstream incremental selection), `src/native_repro.cpp` (scenarios); patches as needed.

**Approach:** Find where upstream sets `isIncrementalOntology()` and `setPreviousClassTypesRealizedOntology` (revision manager / reasoner manager after realization) and mirror it; check that the overrides do not bypass `CIncrementalPrecomputationThread`, `CIncrementalKPSetClassSubsumptionClassifierThread`, `CIncrementalKPSetOntologyConceptRealizingThread`; keep the revision chain alive with a defined lifetime (ownership rules in `docs/solutions/architecture-patterns/konclude-native-incremental-revisions.md`). Scenarios: classify→realize→realize (no-op), ABox add, ABox delete, TBox change. Note upstream's incremental realizer is concept-only for ABox-only changes; measure what role realization redoes.

**Test scenarios:** Each scenario equals the from-scratch oracle on the stable buckets over N fresh processes; log evidence of incremental threads (count of satisfiable tests / individual updates well below the full run).

**Verification:** `konclude_repro --mode incr-abox` PASS with the evidence counters printed.

- [ ] **Unit 6 (P2): C++ incremental API + Embind**

**Goal:** Explicit operations on a kept-alive reasoner: load/update (add/remove triples), classify, realize, read results, with cached idempotent results and invalidation only on change.

**Files:** `src/KoncludeReasoner.h/.cpp`, `src/bindings.cpp`; tests: native scenarios from U5 plus `tests/integration/incremental-reasoning.test.ts` (extend).

**Approach:** State machine (loaded → classified → realized → dirty) in C++; revision lifetime from U5; remove `reset()` as the per-call policy.

**Verification:** Embind surface documented; native scenarios still pass through the new API.

- [ ] **Unit 7 (P2): Thin TS layer + rewritten sequential tests**

**Goal:** `ts/index.ts` / `ts/worker.ts` only convert quads ↔ NTriples and persist results in the N3 store; no reset/reload/canReuse policy.

**Files:** `ts/index.ts`, `ts/worker.ts`, `ts/intern.ts`, README; tests: replace `warmup-sequential`, `hang-*` with new-API sequence tests; adapt `explanation-persistence`.

**Verification:** Full suite green; multi-process oracle sample (U1) still green.

- [ ] **Unit 8 (P2): Reflexive-pair delta**

**Goal:** Emit `x isRelationOf x` (and `isBloodRelationOf`) like upstream for `john_william_folland`, or document the semantic reason it is absent and keep `known_deltas`.

**Approach:** The readout has no self-skip; find where upstream's SPARQL path produces the pair (sameAs-derived self role?) vs the realizer role data (use `--dump-role`, graphify on `visitTargetIndividuals`).

**Verification:** Oracle comparison without `known_deltas` for those two buckets.

- [ ] **Unit 9 (P3): Performance tuning on the native bench**

**Goal:** Use the pipeline for speed work (see playbook section 5).

**Files:** `native/CMakeLists.txt` (`-O2` option / separate build dir), `scripts/perf-sample.sh` (per-phase timings from Konclude log lines, test counts, peak RSS)

**Approach:** Baseline against the pristine-upstream binary; install `perf`/`valgrind`; investigate processing-order effects (unlucky orders do ~130k confirmation tests vs 0 in good orders: a deterministic favourable order, e.g. processing role items/individuals in a stable sorted order, may be a large win); explore the hash-seed vectors as experiments.

**Verification:** Oracle equality preserved; table of before/after timings per fixture.

- [ ] **Unit 10 (P3): Patch / config hygiene**

**Goal:** Reduce surface area.

**Approach:** Decide on parked patches 010, 012-016 (delete or archive with notes); review the three remaining WASM config tunings in `WasmConfigProvider` against sameAs/unsat regression coverage (they are not the cause of the loss); keep patch 018 only if still useful (native-only trace, gated by `NATIVE_DEBUG_BUILD`); make `make reset-patches` the single documented way and add a CI-style check that all enabled patches apply from scratch.

- [ ] **Unit 11 (P3): Documentation**

**Goal:** ce-compound entries for patch 019 (root cause, detection method), the native debug playbook link in `CLAUDE.md` Common Commands (`make repro`), README note on determinism, update memory.

## Risks

| Risk | Mitigation |
| --- | --- |
| Patch 019 makes unlucky processing orders do much more real work (slow worst case) | U9 (stable favourable order); U1 measures WASM times; keep per-test timeouts realistic |
| Native proof does not carry to WASM (mimalloc, pthread pool) | U1 multi-process WASM sampling before anything else |
| Incremental threads are only partly supported upstream (concept realization for ABox-only changes) | U5 measures what is redone; accept partial incrementality for roles if it stays correct |
| Revision chain lifetime (leaks vs use-after-free) | Define ownership in U5; ASan build option exists (`-DREPRO_ASAN=ON`) |
| Disk pressure (variant builds ~4 GB each) | One tree at a time; delete when done |

## Sources & References

- `docs/next-session-prompt.md`, `docs/solutions/best-practices/native-debug-pipeline-playbook.md`
- `patches/017-019`, `scripts/mod_017-019_*.py`
- Vendor: `Source/Reasoner/Kernel/Manager/CRealizationManager.cpp`, `Source/Reasoner/Revision/CSPOntologyRevisionManager.cpp`, `Source/Reasoner/Ontology/COntologyIncrementalRevisionData.*`

## U1 result (2026-10-09)

`make repro-wasm N=8`, twice (16 fresh-process samples, ~34 s each): no lossy realization (patch 019 holds on WASM). Every sample has the same single delta vs oracle: extra `martha_cotton_1806 hasSister martha_cotton_1806` (hasSister 235 vs 234; native does not emit it; same class as U8 reflexive pairs). One of 16 samples hung (600 s timeout, run 1 only; not reproduced in run 2) — unexplained, watch for it. CLI emits inferred triples only; the script merges the fixture before comparing.

## U4 result (2026-10-09)

Root cause: `CDependencyNode` constructor never initialized `mDepTrackPoint` / `mConceptDescriptor` / `mIndividualNode` (only some derived init functions assign them), so `getPreviousDependencyTrackPoint()` (walker) and upstream `hasDependencies()` / `getDependedBranchingTag()` read garbage. Fixed by patch 020 (ctor zero-init), enabled; `make reset-patches` applies 15/15. Native: 10/10 fresh-process samples equal oracle; `MALLOC_PERTURB_=85` runs complete. One perturbed run (first, walker on) was lossy (-44999 isRelationOf), not reproducible in 3 reruns: watch item. WASM rebuilt; `make repro-wasm N=8`: same single known delta (hasSister +1, U8), no loss, no hang. Full suite: 576 pass / 7 fail / 1 skip. Remaining failures: 5 sequential-call (hang-debug 1, hang-minimal 1, warmup-sequential 2) + property-characteristics 2 (sequential-call); `explanation-perf` now passes. `explanation-persistence` "kj:axiom quads" failed once in the full run but passes alone (2/2): flake/watch item.
