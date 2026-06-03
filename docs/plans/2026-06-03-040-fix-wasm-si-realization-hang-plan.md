---
title: "fix: WASM materialize() hang for SI-expressiveness ontologies (R7a/R7b)"
type: fix
status: active
date: 2026-06-03
---

# fix: WASM materialize() hang for SI-expressiveness ontologies (R7a/R7b)

## Overview

`materialize()` hangs indefinitely in WASM for ontologies with SI-expressiveness
(`owl:AllDisjointClasses`, `owl:disjointUnionOf` with ABox individuals). Native
Konclude v0.7.0 completes identical fixtures in ~8 ms. `checkConsistency()` and
`classify()` work correctly for the same fixtures — the hang is specific to the
`realization` pipeline.

The fix follows a **trace-then-fix** approach: add `fprintf` log points to the
realizer code path (via a new WASM override, not vendor edits), rebuild WASM once,
observe where the completion chain breaks, then apply the targeted fix in the same
override file (second rebuild). Native Konclude's top-level logs confirm the fixture
works; WASM logs pinpoint the divergence.

## Problem Frame

`materialize()` maps to Konclude's `realization` pipeline command. The blocking
synchronization point is `CBlockingCallbackData::waitForCallback()` inside
`CReasonerManagerThread::prepareOntology()`. The callback fires only when every
requirement in `reqList` is marked `PSCOMPLETELYYPROCESSED`. For SI-expressiveness
ontologies, at least one requirement (`OPSCONCEPTREALIZE`,`OPSROLEREALIZE`, or
`OPSSAMEINDIVIDUALSREALIZE`) never calls `setDynamicRequirementProcessed()` →
`prepareOntology()` never returns → 30-second timeout.

**Completion chain (must all fire for prepareOntology to return):**
```
realizer pthread
  → setDynamicRequirementProcessed()
    → CRequirementProcessedCallbackEvent → manager thread
      → continueRequirementProcessing()
        → CBlockingCallbackData::doCallback()
          → semaphore.release() → WASM dispatch thread unblocks
```

**SI vs ALC difference:** AllDisjointClasses and disjointUnionOf force nondeterministic
tableau splits. Saturation produces `NONDETERMINISTIC_*` label types in the
BackendAssCache. The realizer reads these via `visitLabelCacheEntries()`. If the
BackendAssCache Update2 phase has not published a slot for the fresh ontology ID by
the time the realizer's fixed cache reader is created, the reader returns no data.
The realizer initializes all concept items with zero possible instances but still
creates requirement processing data for the concept/role/sameIndividuals steps. Since
no tableau jobs are issued, `setDynamicRequirementProcessed()` is never called for
those steps → permanent hang.

## Requirements Trace

- R1. `materialize()` completes without hang for SI-expressiveness ontologies
  containing `owl:AllDisjointClasses` and ABox individuals
- R2. `materialize()` completes without hang for `owl:disjointUnionOf` with ABox
  individuals  
- R3. All existing 311 passing tests continue to pass after the fix
- R4. The fix is instrumented and logged so future regressions are diagnosable

## Scope Boundaries

- Only the `realization` pipeline hang for SI-expressiveness is in scope
- The complementOf mapper fix (R4 in plan-039) is a separate defect; do not attempt
  to combine
- ALIF+ hangs (FunctionalProperty/InverseFunctionalProperty) are confirmed native
  Konclude v0.7.0 bugs; out of scope
- No new WASM API surface or TS changes

### Deferred to Separate Tasks

- **R7a/R7b test activation** (remove `it.skip` in `owl2dl-parity.test.ts`): kept
  as `it.skip` until this fix is verified; activating is a 1-line change post-fix

## Context & Research

### Relevant Code and Patterns

**Realization lifecycle:**
- `src/KoncludeReasoner.cpp` — `realization()` → `runPipeline(impl, true)` → appends
  `OPSINITREALIZE`, `OPSCONCEPTREALIZE`, `OPSROLEREALIZE`, `OPSSAMEINDIVIDUALSREALIZE`
  to reqList; calls `stopAndClearRealizers()` after `waitSynchronization()` returns
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
  — main realizer thread; NOT overridden; critical methods:
  - `initializeIndividualProcessingKPSetsFromConsistencyData()` — reads
    `consistence->getConsistenceModelData()` → indiProcVector OR BackendAssCache
    reader fallback; dispatches QtConcurrent concurrent initialization for
    `hasPossibleInstances=true` items
  - `doNextPendingTests()` → `createNextTest()` → dispatches tableau jobs to STPU
  - `setDynamicRequirementProcessed()` — fires when all jobs for a step complete;
    calls `callback->doCallback()` when `mProcessingRequirmentCount` reaches zero
- `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp` —
  `takeCallback()` atomic exchange guard preventing late-callback use-after-free
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — STPU; stale semaphore
  drain in `startProcessing()`; unconditional `signalizeEvent()`

**BackendAssCache:**
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
  — Update1→Retrieval1→Saturation→Update2 two-phase pattern; `0 remaining` log in
  Update2 = completion signal; realizer can only read valid data after Update2

**Sequential hang fix (reference pattern):**
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` lines 286–344: stale
  semaphore drain loop + tag reset
- `src/KoncludeReasoner.cpp`: `waitSynchronization()` called after each pipeline
  completes to drain manager events before next call

### Institutional Learnings

- Every blocking wait inside a Konclude event handler requires a real OS pthread
  running concurrently to release it — if any pthread in the completion chain is
  dead or stalled, `prepareOntology()` never returns
  (`docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`)
- BackendAssCache Update2 `0 remaining` is the gating signal; if absent in verbose
  logs, the cache is incomplete and downstream realizer stalls
  (memory: `project_backend_asscache_pattern.md`)
- `COntologyRealizingDynamicRequirmentCallbackData::takeCallback()` prevents
  use-after-free from late `CRealizingCalculatedCallbackEvent` callbacks that arrive
  after the callbackData is freed — verify this is applied before adding other fixes
  (memory: `project_realization_classify_dependency.md`)
- STPU must NOT be stopped between calls; stale semaphore drain in `startProcessing()`
  handles inter-call state reset (memory: `project_sequential_call_fix.md`)

## Key Technical Decisions

- **Trace-first, fix-second:** The specific hang point is not confirmed before the
  plan is written. Unit 1 is a pure instrumentation unit producing logs; the logs
  gate the specific fix in Unit 3. Do not skip to code changes without the trace.
- **Native Konclude verbose run is the ground truth:** The native binary
  (`docker run --rm konclude/konclude:latest`) with Konclude's built-in verbose/debug
  logging flag (`-v 2` or equivalent) on the R7a fixture provides the authoritative
  execution timeline. WASM logging must mirror the same key points.
- **Fix in C++ override/wrapper, not vendor:** If the hang is a WASM-specific
  threading race, the fix belongs in `src/compat/overrides/` or `src/KoncludeReasoner.cpp`,
  following the established pattern. Do not patch vendor files for a WASM threading issue.
- **Zero-work guard as primary fix candidate (fix 3b):** If BackendAssCache Update2
  completes but the realizer finds zero possible instances (no jobs issued),
  `setDynamicRequirementProcessed()` never fires for concept/role/sameIndividuals steps.
  The correct fix mirrors `initializeItems()` lines 157–159 (OPSINITREALIZE pattern):
  call `ontProcStep->setStepFinished(true)` and `ontProcStep->submitRequirementsUpdate()`
  for each realization step that has zero queued items. Do NOT call
  `setDynamicRequirementProcessed()` directly — it requires a live `procData` object
  that does not exist in the zero-work case.
- **Fix 3c (`takeCallback()` race) is already applied:** Confirmed in
  `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp` lines 51–53.
  Remove from fix candidates.
- **All instrumentation and fixes go in a new WASM override, not vendor edits:**
  `src/compat/overrides/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
  is created as a full override (same pattern as `CSingleThreadTaskProcessorUnit.cpp`).
  This satisfies CLAUDE.md ("Never edit `vendor/konclude/` directly"), ships
  instrumentation and fix together, and eliminates a rebuild cycle.

## Open Questions

### Resolved During Planning

- **Is this a native Konclude bug?** No — native completes in ~8 ms. WASM regression.
  (source: `parity-gap-native-investigation-2026-06-03.md`)
- **Which pipeline command hangs?** `realization` (not `classification` or `consistency`).
  `checkConsistency()` for the same fixtures passes.
- **What expressiveness?** `SI` (Schröder-inverses: transitivity + inverse roles).
  AllDisjointClasses alone forces SI; disjointUnionOf also.

### Deferred to Implementation

- **Which step in the completion chain is silent?** Determined by Unit 1 verbose logs.
  Could be: (a) BackendAssCache Update2 never completes, (b) indiProcVector null +
  BackendAssCache reader has no data → zero-work hang, (c) late callback race
  (takeCallback fix missing), (d) STPU pool exhaustion with SI fan-out.
- **Does `mConfConcurrentIndividualPossibleConceptInstantiationInitialization=true`
  trigger for these fixtures?** Must verify from logs; the concurrent path uses
  `QtConcurrent::blockingMap/blockingMappedReduced` (synchronous in WASM) so it
  should not hang there.
- **Is `stopRealizerForOntology()` called correctly in `reset()`?** Verify in current
  `src/KoncludeReasoner.cpp`.
- **Is the `takeCallback()` override already applied?** YES — confirmed in
  `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp` lines 51–53.
  Fix 3c is not needed.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not
> code to reproduce.*

### Investigation decision tree

```
Run R7a NTriples on native with verbose logging
     │
     ▼
Does "Update 2 ... 0 remaining" appear in native log?
     │
     ├─ YES ──► Does it also appear in WASM log?
     │               │
     │               ├─ NO ──► [Unit 3a] Fix: BackendAssCache Update2 not completing
     │               │         in WASM (cache thread join / signal missing)
     │               │
     │               └─ YES ──► Does "initializeItems finished, N items" appear?
     │                              │
     │                              ├─ N=0 ──► [Unit 3b] Fix: zero-work guard —
     │                              │          call setDynamicRequirementProcessed()
     │                              │          immediately when no jobs queued
     │                              │
     │                              └─ N>0 ──► Does STPU receive tableau jobs?
     │                                             │
     │                                             ├─ NO ──► doNextPendingTests()
     │                                             │         not posting jobs → check
     │                                             │         mPossibleInstancesTestingList
     │                                             │
     │                                             └─ YES ──► Do jobs complete?
     │                                                            │
     │                                                            └─ NO ──► STPU
     │                                                                      pool exhaustion
     │                                                                      or callback race
     │
     └─ NO ──► [Unit 3a'] Fix: BackendAssCache Update2 signal not firing
               (different from WASM log case — pure native debugging)
```

### Key log points to instrument

| Stage | Log point | Where in code |
|-------|-----------|---------------|
| BackendAssCache | `"BackendAssCache Update2 start: N labels"` | `CBackendRepresentativeMemoryCache` update2 entry |
| BackendAssCache | `"BackendAssCache Update2 complete: 0 remaining"` | update2 completion path |
| Realizer init | `"indiProcVector: null/non-null, N individuals"` | `initializeIndividualProcessingKPSetsFromConsistencyData()` line ~1010 |
| Realizer init | `"hasPossibleInstances items: N"` | after concurrent initialization |
| Realizer | `"doNextPendingTests: M jobs queued"` | after `createNextTest()` loop |
| Step completion | `"setDynamicRequirementProcessed step=X count→Y"` | `setDynamicRequirementProcessed()` entry |
| Final | `"CBlockingCallbackData::doCallback() fired"` | `waitForCallback()` completion |

## Implementation Units

---

- [ ] **Unit 1: Native verbose run — confirm completion sequence and native behavior**

**Goal:** Confirm native Konclude produces the correct result for R7a and R7b, and
capture any available log output showing expressiveness classification and pipeline
stages. Establish ground truth for what the WASM realizer must do.

**Requirements:** Investigation prerequisite; gates Unit 2 instrumentation choices.

**Dependencies:** None.

**Files:**
- Create: `docs/solutions/capability-gaps/si-realization-hang-native-trace-2026-06-03.md`
  — investigation log with native log excerpts and output OWL/XML

**Approach:**
- Run native Konclude on R7a and R7b fixtures (from `parity-gap-native-investigation-2026-06-03.md`)
  using the Docker volume-mount approach (write .nt to `/tmp/konclude-test/`, mount as
  `/data/`): `docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest realization -i /data/r7a.nt -o /data/r7a_out.owl`
- Try Konclude logging flags if available (`--logging-config` or `-v`); the native binary
  may only emit top-level `{info}` lines — that is acceptable. The primary goal is to
  confirm the OWL/XML output (`ClassAssertion(A, alice)`, `ClassAssertion(Thing, alice)`)
  and the expressiveness label (`SI`)
- Note: Native `{info}` logs alone confirm the test suite behavior; detailed BackendAssCache
  and realizer internals will be captured from the WASM side in Unit 2

**Test scenarios:**
Test expectation: none — pure research unit.

**Verification:**
- Log file exists with native output for R7a and R7b
- Confirms: native emits `ClassAssertion(A, alice)` and `ClassAssertion(owl:Thing, alice)` for R7a
- Confirms: native emits `ClassAssertion(C, alice)` and `ClassAssertion(A, alice)` for R7b
- Expressiveness shown as `SI` in native logs

---

- [ ] **Unit 2: Create realizer override with instrumentation — pinpoint hang location**

**Goal:** Create `src/compat/overrides/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
as a full WASM override of the realizer file, with `fprintf(stderr, ...)` log points
at the key stages of the completion chain. Run `materialize()` on the R7a fixture
and observe which log points are reached and which are absent. This override will
also carry the fix in Unit 3.

**Requirements:** R4 (instrumentation for diagnosability). Gates fix selection in Unit 3.

**Dependencies:** Unit 1.

**Files:**
- Create: `src/compat/overrides/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
  — copy vendor source, add log points guarded by `#ifdef WASM_BUILD_VERBOSE` or
  unconditional `fprintf` for initial debug build
- Modify: `CMakeLists.txt` — exclude vendor realizer `.cpp` and compile override instead
  (same pattern as existing overrides in `CMakeLists.txt`)

**Approach:**
- Model structure on `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — same
  `#include` of the vendor header, same file exclusion in `CMakeLists.txt`
- Add `fprintf(stderr, "[WASM-REALIZER] ...")` log points at:
  1. Entry of `initializeIndividualProcessingKPSetsFromConsistencyData()`: log
     whether `indiProcVector` is null and individual count
  2. After concurrent initialization: log count of items with `hasPossibleInstances=true`
  3. Entry of `doNextPendingTests()`: log `mProcessingOntItemList` size
  4. Each call to `setDynamicRequirementProcessed()`: log step ID and remaining count
  5. When `mProcessingRequirmentCount` reaches zero and `doCallback()` fires
- Also add a log in `src/KoncludeReasoner.cpp` when `waitForCallback()` returns (or
  confirm existing WASM_VERBOSE_LOGGING covers this)
- Rebuild WASM: `docker compose run --rm build`
- Run a minimal reproducer (or existing test, with 30 s timeout extended to 60 s to
  allow logs to accumulate): observe which log lines appear
- The last log line before the hang is the location of the missing signal

**Patterns to follow:**
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — override structure
- `CMakeLists.txt` — existing `EXCLUDE_FROM_COMPILATION` / `target_sources` pattern

**Test scenarios:**
Test expectation: none — instrumentation unit. Output is the divergence point.

**Verification:**
- `npm run build` succeeds
- Running R7a through `materialize()` in a test prints WASM-REALIZER log lines up
  to but not beyond the hang point
- Divergence point is documented (added to investigation log from Unit 1)

---

- [ ] **Unit 3: Apply targeted fix based on Unit 2 divergence point**

**Goal:** Fix the specific hang cause identified by the Unit 2 log comparison.
The fix strategy depends on the divergence point (see High-Level Technical Design).

**Requirements:** R1, R2.

**Dependencies:** Unit 2 (divergence point required).

**Files (conditional on Unit 2 divergence, but override already created in Unit 2):**

*Fix path 3a — BackendAssCache Update2 not completing in WASM:*
- Modify: `src/KoncludeReasoner.cpp` — BackendAssCache thread join in
  `WasmReasonerManagerThread::threadStopped()`

*Fix path 3b — Zero-work hang (most probable, BackendAssCache complete but zero
possible instances → step completion callbacks never fire):*
- Modify: `src/compat/overrides/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
  — already created in Unit 2; add the zero-work guard here

*Fix path 3d — STPU stale semaphore from realization fan-out:*
- Modify: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`

**Approach:**
- **3b (most probable based on research):** In `initializeIndividualProcessingKPSetsFromConsistencyData()`
  (in the Unit 2 override), after concurrent initialization completes, count concept
  items with `hasPossibleInstances=true`. If zero for a given step, call
  `ontProcStep->setStepFinished(true)` and `ontProcStep->submitRequirementsUpdate()`
  — the same pattern used for `OPSINITREALIZE` at `initializeItems()` lines 157–159.
  Do NOT call `setDynamicRequirementProcessed()` directly — it requires a live `procData`
  that does not exist in the zero-work case. This guard is semantically correct:
  zero possible instances means nothing to test → step is immediately complete.
- **3a:** If Unit 2 logs show BackendAssCache Update2 `0 remaining` absent, inspect
  `WasmReasonerManagerThread::threadStopped()` in `src/KoncludeReasoner.cpp` — ensure
  the BackendAssCache thread is joined after Update2 before the next pipeline step begins.
- **3d:** If Unit 2 logs show STPU not receiving jobs, verify `startProcessing()` drain
  in `CSingleThreadTaskProcessorUnit.cpp` covers the realization-initiated path.
- All fixes live in `src/compat/overrides/` or `src/KoncludeReasoner.cpp`; never in
  `vendor/konclude/` (CLAUDE.md constraint: vendor edits only via patches).
- After fix: rebuild WASM, confirm WASM-REALIZER logs show all four realization steps
  completing, `CBlockingCallbackData::doCallback()` fires, test returns within timeout.

**Patterns to follow:**
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp::startProcessing()` — stale
  semaphore drain pattern
- `src/KoncludeReasoner.cpp::waitSynchronization()` — post-pipeline drain pattern
- `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp` — existing
  WASM override structure

**Test scenarios:**
- Happy path: `materialize(r7a_quads)` returns within 30 s for AllDisjointClasses fixture
- Happy path: `materialize(r7b_quads)` returns within 30 s for disjointUnionOf fixture
- Happy path: returned inferred triples match native output (`alice rdf:type A`,
  `alice rdf:type owl:Thing` — but NOT `alice rdf:type B`)
- Happy path (regression): all 311 existing tests continue to pass
- Edge case: second sequential `materialize()` call on SI-expressiveness ontology completes
- Edge case: `classify()` immediately followed by `materialize()` on SI ontology — no hang

**Verification:**
- `npm run build` succeeds
- `npm test` passes with 311 tests (no regressions)
- Verbose logs show `setDynamicRequirementProcessed()` firing for all four realization
  steps and `CBlockingCallbackData::doCallback()` completing

---

- [ ] **Unit 4: Activate R7a/R7b tests + remove instrumentation**

**Goal:** Convert the two `it.skip` blocks for R7a (AllDisjointClasses materialize)
and R7b (disjointUnionOf materialize) to active `it` tests. Remove or gate verbose
instrumentation behind a compile-time flag.

**Requirements:** R1, R2, R3.

**Dependencies:** Unit 3 (must pass for these tests to pass).

**Files:**
- Modify: `tests/integration/owl2dl-parity.test.ts` — activate R7a and R7b it.skip
  blocks; update comment headers from WASM REGRESSION to a note referencing this plan
- Modify: instrumentation files from Unit 2 — remove or gate behind `#ifdef` guard

**Approach:**
- Find R7a skip (around line 547): `it.skip("WASM REGRESSION — AllDisjointClasses/materialize:...")`
  → `it("AllDisjointClasses/materialize:...")`; remove 30 000 ms override if test
  completes in <5 s; otherwise keep timeout
- Find R7b skip (around line 607): same activation pattern
- Verify assertions in the test bodies match the native output from Unit 1 logs
  (native emits `ClassAssertion(A, alice)` and `ClassAssertion(owl:Thing, alice)` for R7a)
- For the instrumentation: wrap log lines in `#ifdef WASM_REALIZATION_VERBOSE` so they
  can be kept for future debugging without impacting production output

**Test scenarios:**
- Integration: `npm test` passes with 313 expected tests (311 + 2 newly activated)
- Integration: R7a test verifies `hasTriple(inferred, alice, rdf:type, A)` returns `true`
- Integration: R7a test verifies `hasTriple(inferred, alice, rdf:type, B)` returns `false`
  (B is disjoint from A; alice in A should not be in B)
- Integration: R7b test verifies `hasTriple(inferred, alice, rdf:type, C)` returns `true`
  (alice is in A; A ⊑ C via disjointUnionOf)
- Regression: all 311 prior tests still pass

**Verification:**
- `npm test` passes with 313 tests, 10 skipped
- No verbose log output in the test run (instrumentation gated behind flag)

---

## System-Wide Impact

- **Realization pipeline only:** `classify()`, `classifyProperties()`, and
  `checkConsistency()` are unaffected — the fix targets the `realization` path only
- **Completion chain invariant:** Fix must preserve the invariant that
  `setDynamicRequirementProcessed()` is called exactly once per step per ontology
  realization; double-call risks premature callback release for subsequent calls
- **State lifecycle risks:** The zero-work guard (3b) calls completion immediately
  during initialization; this must happen before any asynchronous jobs are posted,
  not after. If the order is wrong, a job could complete and call the step as done
  twice.
- **Thread safety:** `setDynamicRequirementProcessed()` uses an atomic decrement
  for `mProcessingRequirmentCount`; calling it from the realizer's initialization
  path (still on the realizer pthread) is safe
- **Unchanged invariants:** The STPU stale semaphore drain, the `waitSynchronization()`
  barrier, and the `stopAndClearRealizers()` call in `reset()` must not be disturbed

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Native logs too sparse to confirm BackendAssCache Update2 detail | Med | Low | Native logs confirm fixture works; WASM-side instrumentation (Unit 2) is the primary diagnostic tool — native is ground-truth, not the source of detailed trace |
| Fix 3b uses wrong completion API (`setDynamicRequirementProcessed` instead of `setStepFinished + submitRequirementsUpdate`) | Med | High | Use `ontProcStep->setStepFinished(true); ontProcStep->submitRequirementsUpdate()` — exact pattern from `initializeItems()` lines 157–159; do NOT call `setDynamicRequirementProcessed()` directly in the zero-work case |
| Zero-work guard fires at wrong time (after jobs already posted) | Med | High | Guard must run immediately after initialization count is known and before `doNextPendingTests()` is called; ordering is deterministic within the realizer pthread |
| WASM rebuild breaks existing 311 tests | Low | High | Run full `npm test` after each of the two rebuilds (instrumentation rebuild and fix rebuild) before activating Unit 4 |
| BackendAssCache Update2 race window for SI in WASM | Med | Med | If Unit 2 logs show Update2 absent: add explicit `WasmReasonerManagerThread::waitForCacheUpdate2()` barrier after saturation phase |
| PTHREAD_POOL_SIZE=8 exhausted by SI fan-out | Low | Low | Fixture is minimal (one individual, two classes); fan-out is negligible; pool exhaustion not expected |

## Phased Delivery

### Phase 1 — Investigation (Units 1–2)
Produces the diagnosis: which step in the completion chain is silent in WASM.
No WASM rebuild required for Unit 1 (native only). WASM rebuild needed for Unit 2
instrumentation.

### Phase 2 — Fix + Verify (Units 3–4)
Applies the targeted fix, rebuilds WASM, activates tests. One additional WASM rebuild.

**Total rebuilds:** Two (one for instrumentation override in Unit 2, one for the fix
in Unit 3). Each is ~20–30 min. The instrumentation and fix live in the same override
file — Unit 3 modifies the Unit 2 override in-place without creating new files.

## Sources & References

- Native investigation: `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md`
- Parity gap closure: `docs/plans/2026-06-03-039-fix-owl2dl-parity-gap-closure-plan.md`
- Threading architecture: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- Sequential hang fix: memory `project_sequential_call_fix.md`
- Thread inventory: memory `project_thread_inventory.md`
- BackendAssCache pattern: memory `project_backend_asscache_pattern.md`
- Realizer dependency: memory `project_realization_classify_dependency.md`
- Realizer code: `vendor/konclude/Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp`
- STPU override: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- Callback override: `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp`
- Manager/realizer: `src/KoncludeReasoner.cpp`
