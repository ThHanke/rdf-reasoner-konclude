---
title: "refactor: WASM threading architecture — patch catalogue, event model, and critical invariants"
type: refactor
status: active
date: 2026-06-09
---

# WASM Threading Architecture — Patch Catalogue, Event Model, and Critical Invariants

## Overview

This plan produces a durable architecture document that:
1. Catalogues all 33 vendor patches with their rationale and category
2. Documents how Konclude's event/thread/task/satisfaction model works natively (Qt) and in WASM (pthreads pool)
3. States the critical invariants that must hold on every future code change

The output is `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`.
No code changes. The deliverable is knowledge capture only.

## Problem Frame

The WASM port required deep changes to Konclude's threading model. Those changes are spread across
33 patches, several `src/compat/overrides/` files, and informal session knowledge. Currently:

- The reason each patch exists is known only from commit messages and session memory
- The rules for what can safely change and what will cause hangs/races/state corruption are implicit
- New ALIF+ fix attempts have repeatedly broken things because the threading constraints were not written down
- Any new contributor (or future session) repeats the investigation cycle

## Requirements

- R1. Every patch is catalogued: file modified, change made, reason, category
- R2. CThread / event dispatch / blocking-callback mechanism is documented end-to-end for both native and WASM
- R3. The "singleton server" model (long-lived threads, reused state) is documented vs native "fresh thread per call"
- R4. The pthreads pool constraints are documented: what can block, what cannot, why cooperative scheduling matters
- R5. BackendAssCache write→retrieve pipeline is documented (Update1 → Retrieval1 → saturation → Update2)
- R6. KPSet parallel fan-out and mCurrRunningTestParallelCount semantics are documented
- R7. The allAssertionIndi saturation path (ALIF+ vs non-ALIF+) is documented as a named invariant
- R8. A "before you change anything" checklist is produced for future implementers

## Scope Boundaries

- This plan produces documentation only — no patches, no code changes
- Does not re-implement any ALIF+ fix (that is a separate task)
- Does not cover the JS/TS layer (worker.ts, index.ts) in detail — only the C++ threading model

## Context and Research Sources

### Patches to catalogue

`patches/001` through `patches/033` — read each file directly.

### Key source files to read

| File | What it documents |
|------|------------------|
| `src/compat/overrides/CThread.cpp` | WASM event-loop replacement for QThread |
| `src/compat/QtCompat.h` | QThread / QSemaphore / QMutex shim definitions |
| `vendor/konclude/Source/Concurrent/CThread.cpp` | Native Qt event loop |
| `vendor/konclude/Source/Concurrent/CBlockingCallbackData.h` | Blocking cross-thread callback |
| `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp` | mCurrRunningTestParallelCount, event dispatch |
| `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp` | allAssertionIndi, ALIF+ path |
| `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp` | 2-phase write pipeline |
| `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassifierThread.cpp` | Parallel test fan-out |
| `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md` | Existing pthread concurrency doc |

### Existing solution docs to incorporate

- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- `memory/project_thread_inventory.md`
- `memory/project_backend_asscache_pattern.md`
- `memory/project_sequential_call_fix.md`
- `memory/project_alif_plus_fix_strategy.md`

## Key Technical Decisions

- **One document, not many**: A single `wasm-threading-model-invariants.md` is more useful than multiple
  scattered docs because it gives a complete mental model in one read
- **Catalogue format**: A table per patch category, with rationale column — so readers understand
  *why* the change was needed, not just *what* it does
- **Invariants as named rules**: Each critical constraint gets a name (e.g. "SINGLETON-THREAD",
  "NO-BLOCK-ON-MAIN", "ALIF-GUARD") so it can be referenced in commit messages and code comments

## Implementation Units

- [ ] **Unit 1: Patch catalogue**

  **Goal:** Read all 33 patches, produce a table: patch name | file(s) modified | change summary | category | reason

  **Categories to assign:**
  - `QT-REMOVE` — Qt include / type removal / shim substitution
  - `CALLBACK-ATOMIC` — thread-safety / atomic callback fire-once fix
  - `SINGLETON-RESET` — stale-state / counter reset guard for singleton thread reuse
  - `ID-GUARD` — recycled-pointer / ontology-ID hash safety
  - `BACKENDASSCACHE` — BackendAssCache write pipeline / isolation fix
  - `CORRECTNESS` — upstream Konclude logic bug (NPA scramble, FP hash swap, etc.)
  - `DIAGNOSTICS` — verbose logging only (compiled out in production)

  **Files:**
  - Read: `patches/001` through `patches/033`
  - Write: catalogue into `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md` (section 1)

  **Verification:** Every patch has an entry; no patch is skipped

---

- [ ] **Unit 2: Native threading model (Qt)**

  **Goal:** Document how Konclude's native threading works — what an implementer needs to know
  to understand *what the WASM port had to preserve*

  **Topics:**
  - `CThread` = `QThread` subclass running a `QEventLoop`
  - `postEvent()` = `QCoreApplication::postEvent()` — async, thread-safe
  - `CBlockingCallbackData::waitForCallback()` = `QSemaphore::acquire(1)` — caller blocks
  - Each reasoning thread (precomputer, saturation, classifier, realizer, BackendAssCache) is a
    persistent server-lifetime QThread with its own event queue
  - In native, each *call* creates a fresh ontology item; the thread itself is long-lived but
    the item state is per-call
  - `mCurrRunningTestParallelCount` counts in-flight saturation jobs; decremented on callback;
    `canProcessMoreTests()` gates new job creation

  **Files:**
  - Read: `vendor/konclude/Source/Concurrent/CThread.cpp`, `CBlockingCallbackData.h`
  - Write: into document section 2

  **Verification:** A reader with no Konclude background can understand what QThread + QEventLoop
  does and why the model is "each thread is a message-passing actor"

---

- [ ] **Unit 3: WASM threading model (pthreads pool)**

  **Goal:** Document what changed when Qt threads were replaced by Emscripten pthreads

  **Topics:**
  - `src/compat/overrides/CThread.cpp` — event loop replaced with a spin-loop processing a
    `std::queue<CCustomEvent*>` protected by `std::mutex` + `std::condition_variable`
  - `postEvent()` pushes to the queue and notifies; the pthread wakes, processes, sleeps again
  - `CBlockingCallbackData::waitForCallback()` — **must NOT block on the main thread** because
    Emscripten's main thread cannot block (no `futex_wait`). All blocking calls happen on worker pthreads.
  - `PTHREAD_POOL_SIZE=32` — pool pre-allocates 32 pthreads; KPSet fans out to ~8 workers simultaneously
  - Why `PROXY_TO_PTHREAD` is NOT used (existing solution doc explains this)
  - Singleton reuse: in WASM the same pthread processes calls N and N+1 for the same thread type.
    Native Konclude never did this — each logical reasoning operation had a fresh environment.
    This is the root cause of all SINGLETON-RESET and ID-GUARD patches.

  **Files:**
  - Read: `src/compat/overrides/CThread.cpp`, `src/compat/QtCompat.h`
  - Read: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
  - Write: into document section 3

  **Verification:** Explains *why* WASM must not block the main thread and *why* singleton reuse
  is structurally different from native

---

- [ ] **Unit 4: Event flow for each reasoning operation**

  **Goal:** Document the complete event/callback chain for each of the 4 operations
  (classify, checkConsistency, materialize, whatIf) showing which threads participate,
  in what order, and what the hand-off points are

  **Pipeline sketch (from existing session knowledge + verbose logs):**

  classify / checkConsistency:
  ```
  JS → WASM classify()
    → KoncludeReasoner::classify()
    → prepareOntology() → precompute() [blocking on worker pthread]
      → CTotallyPrecomputationThread::precompute event
        → concept saturation job → BackendAssCache Update1
        → BackendAssCache Retrieval1
        → individual saturation (if ABox) → BackendAssCache Update2
      → CTotallyPrecomputationThread callback fires
    → classify() → COptimizedKPSetClassifierThread
      → parallel subsumption tests → results gathered
      → callback fires
  → getInferredNTriples()
  ```

  materialize adds:
  ```
    → COptimizedRepresentativeKPSetOntologyRealizingThread
      → initializeKPSets from BackendAssCache
      → fan-out possible-instance tests
      → callback fires
  ```

  **Files:**
  - Read: `src/KoncludeReasoner.cpp` (the orchestration point)
  - Read: verbose log outputs from existing solution docs
  - Write: into document section 4 as a table + narrative

  **Verification:** For each operation, the full thread participation chain is listed with no gaps

---

- [ ] **Unit 5: BackendAssCache 2-phase write pipeline**

  **Goal:** Document the Update1 → Retrieval1 → saturation → Update2 pattern as a named invariant

  **Topics:**
  - Why two update phases exist (first pass: prepare cache slots; second pass: write saturation results)
  - What `mNextIndiUpdateId` tracks and why it must not be stale across calls
  - `initializeIndividualsAssociationCaching()` — sets up slots before saturation begins
  - `getIncompletlyAssociationCachedIndividuals()` — Retrieval1 hand-off
  - Why `resetOntologyData()` was added and why it's NOT in the current baseline
    (it broke ABox realization by clearing data needed by the realizer)
  - `WaitIndividualLabelAssociationIndexed` / `LateIndividualLabelAssociationIndexing` — what they
    do and why setting them to `false` kills ABox realization (lessons from the nuclear patch cycle)

  **Files:**
  - Read: `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
    (indexIndividualLabelAssociations, Update1/Update2 event handlers)
  - Read: `memory/project_backend_asscache_pattern.md`
  - Write: into document section 5

  **Verification:** The invariant "do not reset BackendAssCache between classify and realize on
  the same call" is explicitly named and explained

---

- [ ] **Unit 6: KPSet parallel fan-out and counter semantics**

  **Goal:** Document mCurrRunningTestParallelCount, canProcessMoreTests, doNextPendingTests
  as a named invariant

  **Topics:**
  - `mConfMaxTestParallelCount` defaults to 1 in WASM (sequential) — why
  - `mCurrRunningTestParallelCount++` at job dispatch, `--` at callback
  - Why a stale count > 0 on call N+1 causes deadlock (doNextPendingTests → canProcessMoreTests → false → no work dispatched → thread waits forever)
  - Patch 033: reset to 0 on new ontology item creation
  - Guard `if (count > 0) { --count; }` — prevents underflow from reset-to-0 cycles
  - KPSet fan-out in classifier: multiple sub-tests running concurrently on pthread pool workers;
    callbacks are asynchronous; the precomputation thread's counter must accurately reflect in-flight work

  **Files:**
  - Read: `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp`
  - Read: `patches/033-precomp-counter-reset.patch`
  - Write: into document section 6

---

- [ ] **Unit 7: allAssertionIndi and the ALIF+ invariant**

  **Goal:** Document the allAssertionIndi saturation path as a named invariant with the
  two required conditional guards

  **Topics:**
  - What allAssertionIndi is: aggregate ABox individual created in
    `addIdentifiedRemainingConsistencyRequiredConcepts()` with all ABox concept + role assertions
  - Why it must be saturated for restriction ontologies (hasValue, someValuesFrom etc. depend
    on BackendAssCache seeing its role data)
  - Why it causes infinite KPSet loop for ALIF+ (FP/IFP) ontologies:
    self-referential role assertion → nominal-delayed processing → allAssertionIndi repeatedly
    re-scheduled → type=1 callback loop
  - **Guard 1** in `addIdentifiedRemainingConsistencyRequiredConcepts()`:
    `if (!hasAlifPlusConditionForRoles)` before adding role assertions
  - **Guard 2** in `createMarkedConceptSaturationProcessingJob()`:
    `if (!hasAlifPlusCondition && !isAllAssertionIndividualSaturated())`
  - Why `else { setAllAssertionIndividualSaturated(true); }` is mandatory in Guard 2
  - Why nuclear `if (false)` broke restriction tests
  - Why `WaitIndividualLabelAssociationIndexed=false` broke ABox realization

  **Files:**
  - Read: `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
    (lines ~1600-1630 and ~1980-2010)
  - Read: `memory/project_alif_plus_fix_strategy.md`
  - Write: into document section 7

  **Verification:** The invariant "two conditional guards, keyed on FP/IFP role scan, applied
  per-call" is explicitly stated with the exact conditions

---

- [ ] **Unit 8: Critical invariants checklist**

  **Goal:** A named, numbered checklist — "Before you change any C++ reasoning code, verify these"

  **Named invariants to formalize:**

  | Name | Rule |
  |------|------|
  | SINGLETON-THREAD | All reasoning threads are long-lived singletons. Any per-call state must be explicitly reset on new ontology item creation. Never assume a freshly-created item implies a fresh thread state. |
  | NO-BLOCK-MAIN | No blocking call (QSemaphore, std::mutex lock, condition_variable wait) may happen on the Emscripten main thread. All blocking operations must be on worker pthreads. |
  | PTHREAD-COOPERATIVE | WASM pthreads share a cooperative scheduler. A tight busy-loop on a worker can starve other workers. Never spin without yielding. |
  | COUNTER-RESET | `mCurrRunningTestParallelCount` must be reset to 0 when a brand-new ontology item is created. Never assume it is zero from a prior call. |
  | BACKENDASSCACHE-PIPELINE | BackendAssCache operates in two update phases. Do not reset its per-ontology state between precomputation and realization on the same call — the realizer depends on data written in phase 1. |
  | BACKENDASSCACHE-INDEXING | `LateIndividualLabelAssociationIndexing` and `WaitIndividualLabelAssociationIndexed` must remain at their defaults (true). Disabling them skips indexing or waits, breaking ABox realization. |
  | ALIF-GUARD | allAssertionIndi role assertions and saturation scheduling must be conditioned on `!hasAlifPlusCondition` (FP/IFP RBox scan). Skipping unconditionally breaks restrictions. Skipping nothing causes infinite KPSet loop for FP/IFP ontologies. |
  | CALLBACK-ONCE | All callback invocations at the C++ level must fire exactly once. Multiple fires corrupt thread counters and produce duplicate inferences. Patches 011–015 enforce this. |
  | ID-GUARD | Thread-local hash maps keyed by raw `CConcreteOntology*` pointer must check ontology ID on lookup. Freed ontologies can be replaced by new ontologies at the same address. Patches 017/022/023 enforce this. |

  **Files:**
  - Write: into document section 8 as a named table + prose explanation of each invariant

  **Verification:** Each invariant is stated as a falsifiable rule, not vague advice.
  A future implementer reading it knows exactly what to check.

---

- [ ] **Unit 9: Write final document**

  **Goal:** Assemble all units into `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`

  **Document structure:**
  ```
  # WASM Threading Model — Patch Catalogue and Critical Invariants
  ## 1. Patch Catalogue (table)
  ## 2. Native Qt Threading Model
  ## 3. WASM Pthreads Pool — What Changed
  ## 4. Event Flow per Operation (classify / materialize / consistency)
  ## 5. BackendAssCache 2-Phase Pipeline
  ## 6. KPSet Parallel Fan-Out and Counter Semantics
  ## 7. allAssertionIndi and the ALIF+ Invariant
  ## 8. Critical Invariants Checklist (named rules)
  ## 9. Open Work — ALIF+ C++ Fix Still Needed
  ```

  **Files:**
  - Create: `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`

  **Verification:** Document is self-contained — a reader with no prior session history can
  understand the WASM threading constraints from this document alone

## Risks

| Risk | Mitigation |
|------|------------|
| Patch reading reveals additional categories not listed here | Add to catalogue; update invariant checklist if a new rule emerges |
| Source file line numbers shift during research | Use function-name anchors in the document, not line numbers |
| ALIF+ fix strategy section becomes stale when the fix is implemented | Section 9 explicitly marks it as open work; update document when fix lands |

## Sources and References

- All files under `patches/`
- `src/compat/overrides/CThread.cpp`
- `src/compat/QtCompat.h`
- `vendor/konclude/Source/Concurrent/CThread.cpp`
- `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp`
- `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- `memory/project_thread_inventory.md`
- `memory/project_backend_asscache_pattern.md`
- `memory/project_alif_plus_fix_strategy.md`
- `memory/project_sequential_call_fix.md`
