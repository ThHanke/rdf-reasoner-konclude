---
title: "fix: restriction test hang regression from nuclear patches 034-036"
type: fix
status: active
date: 2026-06-08
---

# fix: restriction test hang regression from nuclear patches 034-036

## Overview

Restriction tests (hasValue, someValuesFrom, allValuesFrom, hasSelf) hang at 30 s with
VERBOSE=OFF binary after patches 034–036. VERBOSE=ON binary passes all restriction tests.

**Current state (patches 001-039):** 7 failing / 319 skipped.

**Root cause (confirmed):** WASM pthread scheduling ≠ Qt preemptive QThread. The individual
saturation job for triple-indexed individuals (bob, alice, rex, carol with restriction concepts)
is submitted to KPSet, but KPSet workers never complete it without explicit OS-level yields.
`fflush(stderr)` in Emscripten proxies to the JS main thread — this is an accidental yield
that unblocks KPSet workers. Without it, KPSet workers starve.

## Problem Frame

### Threading model difference (root cause)

Native Konclude: Qt `QThread` with OS-level preemptive scheduling. KPSet worker threads get
CPU time automatically.

WASM: Emscripten fixed pthread pool (8 threads). Threads do NOT preempt each other in the
browser/Node context without explicit yield points. `CSingleThreadTaskProcessorUnit` override
(`src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`) uses `std::mutex` + semaphore
blocking. When the precomp thread submits the individual saturation job and enters its event
loop waiting for a callback, KPSet worker pthreads must get scheduled and process the job.
Without a yield at the submission boundary, the OS may not context-switch to KPSet workers.

### Why VERBOSE=ON passes

VERBOSE adds `fflush(stderr)` throughout `createNextTest()`. Emscripten's `fflush` on a
worker thread proxies to the JS main thread via `_emscripten_proxy_to_main_thread_js`.
While the precomp worker blocks for the proxy, the OS scheduler runs other workers. This is
an OS-level yield — it gives KPSet pthread workers CPU time to process the saturation job.

### Why restriction ontologies hang but property-characteristics pass

Unknown — this is the key open question. Property-characteristics tests (FP, IFP, etc.)
submit individual saturation jobs and complete. Restriction-type ontologies also submit
individual saturation jobs but those jobs hang. The difference must be in what KPSet does
internally when processing restriction concepts (hasValue uses nominal {Alice}, someValuesFrom/
allValuesFrom involve role successors). Restriction processing may require more internal
sub-task steps or BackendAssCache role lookups that create a deeper dependency chain.

### What diagnostics show (post patch 039)

- `[HANG-DBG] precomp-tested: type=1` fires — concept saturation callback received
- NOTHING after that — no `indi-dec`, no `sync-retrieve`, no `cache-write-done`
- The triple-indexed individual saturation job IS submitted (type=1 callback proves precomp
  thread is alive and processed concept saturation), but KPSet never completes it
- With patch 039: ZERO `cache-write-done` fires (pre-039 ONE did fire — meaning
  all-assertion individual's concept saturation WAS writing to BackendAssCache before)

### Nuclear patch history

| Patch | Change | Broke |
|-------|--------|-------|
| 034 | Reset stale `mCurrRunningTestParallelCount`; guard decrement with `> 0` | Nothing |
| 035 | `resetOntologyData()` in BackendAssCache | Potentially stale scan cursor |
| 036 | Skip all-assertion individual role assertions AND saturation job (`if (false) {`) | Restriction tests |
| 039 | Conditional skip: only skip all-assertion for ALIF+ ontologies (`hasAlifPlusCondition`) | Still hanging |

Patch 036 at line 1597: `if (false) {` skips role assertions on all-assertion individual.
Patch 039 restores all-assertion individual to concept saturation for non-ALIF+ ontologies,
but does NOT remove the `if (false)` at line 1597 — role assertions still skipped.

## Requirements Trace

- R1. All 7 restriction tests (hasValue×2, someValuesFrom×1, allValuesFrom×1, hasSelf×2,
  classify PetOwner subClassOf Animal×1) pass with VERBOSE=OFF binary
- R2. All other 317 currently-passing tests remain passing
- R3. No ALIF+ deadlock regression (FP+ABox 1-filler tests stay passing)

## Scope Boundaries

- Do NOT require VERBOSE=ON for correctness
- Do NOT add fflush calls disguised as "yield" — fix the scheduling, not the symptom
- Patches 034 and 035 are not in question (correct logic fixes)
- ALIF+ 2-filler upstream bugs remain skipped (out of scope)

## Open Questions

### Resolved During Planning

- **Why does VERBOSE=ON fix the hang?** `fflush` proxies to JS main thread → OS-level
  yield → KPSet workers get CPU time. Confirmed.
- **Is it a logic bug or a scheduling bug?** Scheduling. The same saturation job completes
  correctly in native. WASM just needs explicit yields for KPSet workers to run.
- **Does patch 039 fix restriction tests?** No. Even with all-assertion individual back in
  concept saturation (for non-ALIF+ ontologies), the triple-indexed individual saturation
  job hangs.

### Deferred to Implementation

- **WHERE exactly does KPSet stall for restriction concepts?** Does the STPU thread wake
  up at all? Does it process some tasks and then block? Does it spin internally without
  yielding? Needs STPU-level diagnostics (a `processingLoop` iteration counter).
- **Does patch 036's `if (false)` (skip role assertions) affect KPSet processing of
  restriction individuals?** If KPSet's restriction processing needs all-assertion
  individual role data from BackendAssCache and that data is absent (skipped), KPSet might
  wait forever for data that will never arrive.
- **What is the minimal yield that unblocks the restriction individual saturation job?**
  Is one `sched_yield()` at job submission sufficient? Or does KPSet need multiple yields
  during its internal processing?
- **Why do property-characteristics tests NOT hang?** What's different about how KPSet
  processes role-axiom individuals vs restriction-concept individuals?

## Context & Research

### Relevant Code and Patterns

- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — WASM STPU: semaphore-based
  blocking, `processingLoop()` at line 384, `signalizeEvent()` at line 352
- `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp` — counter incremented
  at line 162 (`processCalculationJob` for saturation jobs); callback decrements at line 330
- `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp` — job
  submission at line 2069 (`createTripleIndexedIndividualsSaturationProcessingJob`); patch 036
  at line 1597 (`if (false)` role assertion skip); patch 039 at lines 1956-1988
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp` —
  WRITE handler fires when individual saturation data published

### Institutional Learnings

- See [[project_restriction_hang_bug]] — full bug history, threading root cause, what was tried
- See [[project_sequential_call_fix]] — prior semaphore stall fix in STPU `startProcessing()`
- See [[project_thread_inventory]] — thread type roles and interaction matrix

## Key Technical Decisions

- **Add STPU-level diagnostics before attempting yield fix**: Need to confirm whether the
  STPU even wakes up for the restriction individual job before adding sched_yield. If STPU
  never wakes, the problem is signal delivery, not scheduling starvation.
- **Try `emscripten_sleep(0)` first**: This is the Emscripten-idiomatic yield. It yields
  to the JS event loop, giving all pending pthreads a turn. Safer than `sched_yield()` which
  is POSIX but may not yield to Emscripten-managed threads.
- **Fix patch 036 `if (false)` ONLY IF it's the cause**: Restoring all-assertion individual
  role assertions risks re-introducing ALIF+ hang. Only do this if diagnostics confirm that
  missing role data is why KPSet stalls for restriction individuals.

## Implementation Units

- [x] **Unit 1: Add targeted diagnostic logging (patch 038 — DONE)**

Applied as `patches/038-restriction-hang-diagnostics.patch`. Confirmed output:
`precomp-tested: type=1` fires (concept saturation), then silence. No `cache-write-done`,
no `indi-dec`, no `sync-retrieve`. Individual saturation job submitted, never completes.

---

- [x] **Unit 2a: Diagnostic output analyzed — divergence identified**

Diagnostic output (Unit 1 / patch 038 + WASM built June 8):
- `precomp-tested: type=1` fires → concept saturation callback received
- NO `precomp-tested: type=2` → individual saturation never completes
- NO `cache-write-done` → BackendAssCache write never happens
- NO `sync-retrieve` → never reaches retrieve phase

Conclusion: KPSet workers are stuck during individual saturation. Root cause is
patch 036's `if (false)` at line 1597 — role assertions on all-assertion individual
are skipped for ALL ontologies, but restriction processing (hasValue, someValuesFrom,
etc.) requires those role assertions in BackendAssCache to complete. Without role
data, KPSet loops indefinitely on restriction concepts.

VERBOSE=ON masks this via fflush yields (allows KPSet workers CPU time), but the
underlying issue is missing role data, not scheduling starvation.

Skipping Unit 2b (STPU diagnostics) — divergence is clear enough from Unit 1 output.

---

- [ ] **Unit 2a (original): Capture VERBOSE=ON trace to establish correct execution sequence**

**Goal:** Get the ground-truth execution log for a passing restriction test, then compare
with VERBOSE=OFF + HANG_DIAGNOSTICS output to find the exact divergence point.

`WASM_PRECOMP_VERBOSE=ON` is the equivalent of "native with debug patches" — it passes all
restriction tests and produces dense per-step logging in `createNextTest()`. We do NOT need
a native Qt build; this IS the reference trace.

**Dependencies:** None — existing WASM_PRECOMP_VERBOSE flag.

**Files:**
- No code change — build with `-DWASM_PRECOMP_VERBOSE=ON`, run one test, capture stderr

**Approach:**

1. `docker compose run --rm build` with `WASM_PRECOMP_VERBOSE=ON` in CMakeLists.txt
2. `npx vitest run -t "hasValue — materialize"` and capture full stderr to a file
3. Search for `precomp-tested: type=1` in the log and list all `[WASM-PRECOMP]` and
   `[HANG-DBG]` events that follow it until completion
4. That sequence = what VERBOSE=OFF must reproduce to not hang

**What to look for:**

Events between `precomp-tested: type=1` and final completion:
- Does `precomp-tested: type=2` fire? (would mean individual sat completes)
- Which `createNextTest` phase-gate labels appear?
- Does `sync-retrieve` appear? Does `indi-dec` appear?
- How many `createNextTest: entry` cycles happen?

**Verification:** Log captured, events after type=1 listed, divergence point identified.

---

- [ ] **Unit 2b: Add STPU-level diagnostics to confirm whether KPSet worker activates**

**Goal:** Determine if the STPU pthread even wakes up to process the restriction individual
saturation job, and if so, how far it gets before stalling.

**Dependencies:** Unit 2a trace — divergence point narrows where STPU diagnostics are needed.

**Files:**
- Modify: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- Create: `patches/040-stpu-diagnostics.patch`

**Approach:**

Add `#ifdef WASM_HANG_DIAGNOSTICS` guards at:
1. `processingLoop()` entry: `"[HANG-DBG] stpu: loop-entry mProcessingBlocked=%d"`
2. Each task-processing iteration: `"[HANG-DBG] stpu: tick queue=%p"`
3. When blocking on semaphore: `"[HANG-DBG] stpu: blocking-on-semaphore"`
4. After semaphore acquire: `"[HANG-DBG] stpu: wake-from-semaphore"`

**What the output tells us:**

| Pattern | Diagnosis |
|---|---|
| `stpu: loop-entry` never appears | STPU not signaled — signal delivery broken |
| `stpu: blocking-on-semaphore` with no tick | Job not in STPU task queue |
| `stpu: tick` many times, then silence | Task sub-graph deadlocked |

**Test scenarios:**
- `npx vitest run -t "hasValue — materialize"` with diagnostics, observe STPU activation

**Verification:** STPU-level output appears before timeout, disambiguates signal vs scheduling vs task-loop stall.

**Files:**
- Modify: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- Modify (new patch): `patches/040-stpu-diagnostics.patch`

**Approach:**

Add `#ifdef WASM_HANG_DIAGNOSTICS` guards (already enabled in CMakeLists.txt). Add at:
1. `processingLoop()` entry: print `"[HANG-DBG] stpu: loop-entry mProcessingBlocked=%d"`
2. Each iteration of the task-processing while-loop: print `"[HANG-DBG] stpu: tick queue=%p"`
3. When blocking on semaphore: print `"[HANG-DBG] stpu: blocking-on-semaphore"`
4. After semaphore acquire: print `"[HANG-DBG] stpu: wake-from-semaphore"`

**What the output tells us:**

| Pattern | Diagnosis |
|---|---|
| `stpu: loop-entry` never appears | STPU not signaled at all — signal delivery broken |
| `stpu: blocking-on-semaphore` then nothing | STPU woke, found no tasks, re-blocked — job not reaching STPU task queue |
| `stpu: tick queue=X` many times, then silence | STPU is processing but task sub-graph is infinite/deadlocked |

**Test scenarios:**
- Run `npx vitest run -t "hasValue"` with diagnostics, observe STPU activation pattern

**Verification:** STPU-level output appears before 30 s timeout, disambiguating signal vs scheduling vs task-loop stall.

---

- [ ] **Unit 2c: Root cause fix — threading yield at KPSet job submission**

**Goal:** Add explicit yield after submitting the individual saturation job so KPSet workers
get CPU time to process it.

**Dependencies:** Unit 2a diagnostics to confirm STPU IS being signaled (scheduling starvation
case) — if STPU is never signaled, this is the wrong fix.

**Files:**
- Modify: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` OR
  `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
- Create: `patches/041-stpu-yield-fix.patch` (if in vendor file)

**Approach:**

Primary candidate: after `mCalculationManager->calculateJob(job, callbackEvent)` returns
in `CPrecomputationThread::processCalculationJob()` (line 168), add:
```
#ifdef __EMSCRIPTEN__
  emscripten_sleep(0);   // yield to JS event loop → KPSet workers get CPU time
#endif
```
This would go in `src/compat/overrides/` or via a patch.

Alternative: in `CSingleThreadTaskProcessorUnit::signalizeEvent()`, after releasing the
semaphore, add `sched_yield()` on EMSCRIPTEN builds. This yields immediately after waking
the worker, giving it a chance to run before the calling thread continues.

**Execution note:** Only apply if Unit 2b confirms STPU IS signaled but not scheduled.
If STPU is signaled and running but task-graph loops, the yield won't help — see Unit 2d.

**Test scenarios:**
- `npx vitest run -t "Restriction constructs"` — all 7 must pass
- `npm test` — full suite must show ≥319 passing, no ALIF+ regression

**Verification:** All 7 restriction tests pass without timeout.

---

- [x] **Unit 2d: Root cause fix — patch 036 role assertion skip causes KPSet stall**

**Applied as `patches/040-allassertion-role-alif-conditional.patch`.**

Changed `if (false)` at CTotallyPrecomputationThread.cpp:1597 to check
`hasAlifPlusConditionForRoles` (any asserted role is functional/IFP). For non-ALIF+
ontologies (restriction tests), role assertions are now added to the all-assertion
individual. For ALIF+ ontologies (FP+ABox), they are still skipped.

**Pending: WASM rebuild + test run.**

---

- [ ] **Unit 2d (original): Root cause fix — patch 036 role assertion skip causes KPSet stall**

**Goal:** Fix KPSet stall caused by restriction processing needing all-assertion individual
role data that patch 036 suppresses.

**Dependencies:** Unit 2b showing STPU runs many iterations without completing (task-loop
infinite stall case), OR Unit 2c yield fix doesn't resolve the hang.

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
  (line 1597 — the `if (false) {` role assertion skip from patch 036)
- Update: `patches/036-...` or new override patch

**Approach:**

Patch 036 at line 1597: `if (false) {` prevents collection of role assertions on the
all-assertion individual. For ALIF+ ontologies this was correct — the role assertions caused
an infinite loop. But for restriction ontologies, KPSet's restriction-concept processing may
require role data from the all-assertion individual's BackendAssCache entry.

Fix options (ranked by safety):
1. Make the `if (false)` conditional on `hasAlifPlusCondition` (same pattern as patch 039's
   fix for the saturation job skip). Restore role assertions for non-ALIF+ ontologies.
2. If option 1 re-introduces ALIF+ hang: add a role-assertion filter that only applies to
   restriction-relevant roles (not all functional/IFP roles).

**Risk:** Restoring role assertions on the all-assertion individual risks re-introducing
the ALIF+ KPSet infinite loop (the original bug that patch 036 fixed). Must test FP/IFP
tests explicitly after this change.

**Test scenarios:**
- `npx vitest run -t "Restriction constructs"` — all 7 must pass
- `npx vitest run -t "FunctionalProperty\|InverseFunctionalProperty"` — must not hang
- `npm test` — full suite ≥319 passing, ≤2 skipped

**Verification:** 7 restriction tests pass, no ALIF+ regression.

---

- [ ] **Unit 3: Cleanup and docs**

**Goal:** Remove diagnostic patches, update docs/solutions, update parity gap memory.

**Dependencies:** Unit 2a, 2b, or 2c — whichever resolved the hang.

**Files:**
- Remove/archive: `patches/038-restriction-hang-diagnostics.patch` (or keep as reference)
- Remove/archive: `patches/040-stpu-diagnostics.patch`
- Modify: `docs/solutions/` — add entry for root cause and fix
- Modify: memory file `project_owl2dl_parity_gaps.md` — update to 326 passing / 0 failing / 2 skipped

**Approach:** Regenerate final patches without diagnostic logging. Commit with message
describing root cause (WASM pthread scheduling) and fix mechanism.

**Test scenarios:**
- `npm test` — 326 passing / 2 skipped (FP/IFP 2-filler remain upstream bugs)

**Verification:** `npm test` passes. No WASM_HANG_DIAGNOSTICS output in clean build.

## High-Level Technical Design

> *Directional guidance, not implementation specification.*

```
Diagnostic flow:

  Unit 2a: Capture VERBOSE=ON passing trace
       ↓
  What fires after precomp-tested: type=1?
       type=2 fires → individual sat completes → hang is AFTER
       no type=2 → individual sat job never completes → go to 2b

  Unit 2b: Add STPU-level diagnostics
       ↓
  [HANG-DBG] stpu: loop-entry?
       N → STPU never signaled → signal delivery broken
       ↓ Y
  [HANG-DBG] stpu: blocking-on-semaphore immediately (no tick)?
       Y → job not in STPU queue → job routing broken
       ↓ N
  [HANG-DBG] stpu: tick count?
       low (<10) → data dependency stall → try Unit 2d (patch 036 role data)
       high (100+) → internal spin → Unit 2c (emscripten_sleep yield)
       completes → callback delivery broken → investigate callback routing

Fix selection:
  STPU never signaled → investigate calculateJob → signalizeEvent() chain
  STPU blocks quickly → all-assertion role data missing (patch 036) → Unit 2d
  STPU spins high count → scheduler starvation → Unit 2c yield
  STPU completes but no callback → callback routing bug (new unit needed)
```

## System-Wide Impact

- Any yield added at job submission touches all 4 reasoning operations (classify, materialize,
  checkConsistency, classify-TBox) — regression-test all
- Restoring role assertions on all-assertion individual (Unit 2c) affects every ontology with
  ABox + restriction concepts — must not regress property-characteristics tests
- WASM_HANG_DIAGNOSTICS compile flag currently always-on via CMakeLists.txt line 276 — must
  be removed or made opt-in in Unit 3

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| yield fix (Unit 2b) adds latency to non-hanging tests | Measure before/after on full suite |
| Restoring role assertions (Unit 2c) re-introduces ALIF+ hang | Test FP/IFP explicitly; conditional on hasAlifPlusCondition |
| Two failure modes active simultaneously (need both 2b + 2c) | Do Unit 2a first to disambiguate |
| emscripten_sleep(0) unavailable in worker context | Check emscripten_sleep docs; fallback to sched_yield() |

## Sources & References

- Plan 043: `docs/plans/2026-06-05-043-fix-alif-plus-precomp-deadlock-plan.md` (nuclear patches 034-036)
- Memory: `memory/project_restriction_hang_bug.md` — full threading root cause documentation
- STPU override: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- Job submission: `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp:162-168`
- Patch 036 role skip: `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp:1597`
- Patch 039 ALIF+ conditional: `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp:1956-1988`
