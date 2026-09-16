---
title: "WASM Threading Model — Patch Catalogue and Critical Invariants"
date: 2026-06-09
category: docs/solutions/architecture-patterns/
module: wasm-threading
problem_type: architecture_pattern
component: tooling
severity: critical
applies_when:
  - About to modify any C++ reasoning code in the WASM port
  - Debugging a hang, race, or stale-state crash in classify/materialize/checkConsistency
  - Adding new patches or overrides to the Konclude vendor source
tags:
  - wasm
  - emscripten
  - pthreads
  - concurrency
  - konclude
  - invariants
  - patch-catalogue
---

# WASM Threading Model — Patch Catalogue and Critical Invariants

A self-contained reference for anyone touching C++ reasoning code in this WASM port.
Read it before making any change. Section 8 (Critical Invariants Checklist) is the most
important — each invariant is a falsifiable rule with a named consequence if violated.

---

## 1. Patch Catalogue

24 patches are applied to `vendor/konclude/` at CMake configure time. Numbers are
non-consecutive because several early patches were consolidated or replaced.

### 1.1 QT-REMOVE — Qt dependency elimination

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `001-all-wasm-changes` | ~190 files across `Source/Concurrent/`, `Source/Reasoner/`, headers | Replace all `#include <QThread>`, `<QSemaphore>`, `<QHash>`, etc. with `#include "QtCompat.h"`. `CThread.h`: remove `QThread` base class, add WASM stubs (`isRunning()`, `wait()`, `startThread` signature fix). `CBlockingCallbackData.h`: `QSemaphore` shim substitution. | Remove Qt compile dependency from kernel |
| `004-bool-ref-hash` | `Source/Reasoner/Preprocess/CExtractPropagationIntoCreationDirectionPreProcess.cpp` | Replace `bool& ref = hash[key]; ref = true;` with `hash.value(key, false)` + `hash.insert(key, true)` | `unordered_map<CRole*, bool>` (our QHash shim) returns a real reference; upstream code relied on `vector<bool>`'s proxy reference semantic surviving a hash resize. Crash in role propagation preprocessing. |
| `007-cthread-ideal-thread-count` | `Source/Concurrent/CThread.h` | Fix `idealThreadCount()` stub: return `hardware_concurrency()` clamped to [2, 8] instead of always 1 | KPSet parallel sub-tests need a pool count > 1 to fan out; returning 1 starved sub-test parallelism |
| `010-wasm-log-override` | `Source/Logger/CLogger.h` | Wrap LOG macro definitions in `#ifndef WASM_LOG_OVERRIDE` | Allow CMake to define `WASM_LOG_OVERRIDE` and supply a custom log backend without patching every `LOG(...)` call site |
| `016-mapper-simple-abox-setter` | `Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.h` | Add public `setConfExtractSimpleABoxAssertions(bool)` setter | `KoncludeReasoner.cpp` needs to control ABox extraction mode; field was protected with no accessor |

### 1.2 CALLBACK-ATOMIC — thread-safe, fire-exactly-once callbacks

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `011-once-fire-callback` | `CRequirementProcessedCallbackEvent.h/.cpp` | Change `CThread* recThread` → `std::atomic<CThread*>`; use `exchange(nullptr)` so only the first caller posts the event | Stale STPU pthreads can fire `doCallback()` after the Manager thread already processed+deleted the event. Second fire = use-after-free. |
| `012-realizer-callback-atomic` | `COntologyRealizingDynamicRequirmentCallbackData.h` | Change `CCallbackData* mCallback` → `std::atomic<CCallbackData*>`; add `takeCallback()` that atomically exchanges to nullptr | Realizer callback fires from multiple concurrent pthread workers; second fire = double-decrement + use-after-free |
| `013-realizer-callsite-take` | `COptimizedRepresentativeKPSetOntologyRealizingThread.cpp` | Replace `getProcessingFinishedCallback()->doCallback()` with `takeCallback()` + null check | Must use atomic-take pattern consistently across all call sites of the atomic mCallback field |
| `014-realizer-item-callsite-take` | `COptimizedRepresentativeKPSetOntologyRealizingItem.cpp` | Same `takeCallback()` pattern at item-level call site | Same |
| `015-realizer-testing-step-callsite-take` | `CRealizingTestingStep.cpp` | Same `takeCallback()` pattern at testing-step call site | Same |

### 1.3 SINGLETON-RESET — stale state on singleton thread reuse

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `033-precomp-counter-reset` | `CPrecomputationThread.cpp` | Add `mCurrRunningTestParallelCount = 0` on new ontology item creation. Add `if (count > 0) { --count; }` guard in decrement callbacks | Counter persists across calls in the singleton precomputation thread. Non-zero residue from prior call → `canProcessMoreTests()` returns false → no work dispatched → deadlock |

### 1.4 ID-GUARD — recycled-pointer / ontology-ID safety

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `017-precomputer-id-guard` | `CPrecomputationThread.cpp` | First attempt: check `item->getOntology()->getOntologyID() != ontology->getOntologyID()` before using cached item | In WASM, freed ontology memory is reused; a new ontology at the same address makes `mOntItemHash` return the stale item from the prior call. **Superseded by patch-022** (dereferencing stale pointer is UB). |
| `018-preprocessor-id-guard` | `CPreprocessingThread.cpp` | Same ID check for preprocessing hash | Same. **Superseded by patch-023.** |
| `019-classifier-id-guard` | `CSubsumptionClassifierThread.cpp` | First attempt: compare `staleItem->getOntology() != onto` | Same. **Superseded by patch-023.** |
| `020-reqdata-generation-counter` | `CRequirementPreparingData.h/.cpp`, `CReasonerManagerThread.cpp`, `CRequirementProcessedCallbackEvent.h/.cpp` | Add `mGeneration` atomic counter to `CRequirementPreparingData`; stamp each `CRequirementProcessedCallbackEvent` with expected generation at creation; discard callback if mismatch | `reqData` pointer can be freed and reallocated at the same address by a subsequent call; stale callbacks from call N must not fire for call N+1's reqData |
| `022-precomputer-id-guard-fix` | `CPrecomputationThread.cpp/.h` | Add `mOntIdHash: QHash<CConcreteOntology*, cint64>` companion map; store ontology ID at insertion; compare against it instead of dereferencing `item->getOntology()` | Dereferencing `item->getOntology()` when the ontology has been freed is undefined behaviour. Companion hash records ID at insert time safely. |
| `023-preprocessor-classifier-id-guard-fix` | `CPreprocessingThread.cpp/.h`, `CSubsumptionClassifierThread.cpp/.h` | Same `mOntIdHash` companion pattern for preprocessor and classifier threads | Same UB fix for the other two hash-keyed threads |

### 1.5 BACKENDASSCACHE — BackendAssCache write pipeline / isolation

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `024-backendasscache-fresh-data-compatible` | `CBackendRepresentativeMemoryCache.cpp` | When `mConfInterpretUnchangedLabelsAsCompatible` is set, treat association data with no `getPreviousData()` (freshly created this call cycle) as compatible | `mNextIndiUpdateId` is a global counter that never resets across calls. Fresh data's initial `updateId=1` is always < accumulated counter → `usedUpdateId` mismatch → false `incompatibleChanges` → unnecessary full label replacement cycles |

### 1.6 CORRECTNESS — upstream Konclude logic bugs

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `025-negative-prop-assertion-filter-fix` | `CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp` | Fix `initPartialFilteringStatement` argument order for NPA filters: `SOURCE_INDIVIDUAL`, `TARGET_INDIVIDUAL`, `TARGET_VALUE`, `ASSERTION_PROPERTY` were scrambled as `SOURCE_INDIVIDUAL`, `ASSERTION_PROPERTY`, `TARGET_INDIVIDUAL`, `TARGET_VALUE` | Wrong filter predicates → NPA triples not found at all; `NegativeObjectPropertyAssertion` / `NegativeDataPropertyAssertion` never built |
| `026-negative-prop-assertion-hash-fix` | `CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp` | Swap `mObjectPropertyNodeIdentifierDataHash` ↔ `mDataPropertyNodeIdentifierDataHash` and `getNegativeObjectPropertyAssertion` ↔ `getNegativeDataPropertyAssertion` in the two NPA lookup paths | Data NPA was being built with object-property hash and vice versa; property expressions crossed |
| `027-asymmetric-property-inverse-role-fix` | `CConcreteOntologyUpdateBuilder.cpp` | When building `AsymmetricObjectProperty`, add bidirectional inverse role linkers to both `role` and `invRole` | Saturation clash check for AsymmetricProperty needs the inverse role structure to detect `r(a,b) ∧ r(b,a)`; missing links made the check invisible |
| `030-saturation-clash-combined` | `CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp` | Add clash checks *before* the `othIndiNode` initialization branch: (1) EquivalentObjectProperties+AllDisjointProperties self-clash, (2) AllDisjointProperties ABox clash between two individuals, (3) AsymmetricProperty ABox assertion check, (4) IrreflexiveProperty self-loop check | All these clashes depend only on role axioms / ABox assertions — not on whether the target saturation node is initialized. Placing them inside the `othIndiNode` branch silently skips them when the target node is uninitialized |

### 1.7 DIAGNOSTICS — verbose logging (compiled out in production)

| Patch | File(s) modified | Change | Reason |
|-------|-----------------|--------|--------|
| `031-realizer-verbose-logging` | `COptimizedRepresentativeKPSetOntologyRealizingThread.cpp` | `#ifdef WASM_REALIZATION_VERBOSE` fprintf gates at key realization phase points | Trace realization phases when diagnosing ABox/realization issues |
| `032-precomp-verbose-logging` | `CTotallyPrecomputationThread.cpp` | `#ifdef WASM_PRECOMP_VERBOSE` fprintf gates at precomputation phase checkpoints (concept-sat job create/submit, individual sat batches, BackendAssCache retrieve, finish) | Trace precomputation phases when diagnosing saturation or ALIF+ loop issues |

---

## 2. Native Qt Threading Model

Understanding the native model is required to understand *what the WASM port had to preserve*.

### 2.1 CThread = QThread actor

Each `CThread` subclass is an **actor** with its own OS thread and message queue:

```
CThread (QThread subclass)
  → start() creates an OS thread
  → run() calls exec()     ← Qt event loop; blocks until quit()
  → event(QEvent*)         ← called by Qt event loop on each delivered event
  → postEvent(QEvent*)     → QCoreApplication::postEvent()  ← thread-safe, async
```

`postEvent()` puts an event into the Qt event queue for that thread. The Qt event loop
delivers it by calling `event(QEvent*)` on the thread's own OS thread. This is the
standard Qt actor pattern: no shared mutable state, all cross-thread communication via
posted events.

### 2.2 Blocking synchronization: CBlockingCallbackData

`CBlockingCallbackData` is the mechanism for blocking the *caller* until a remote actor
completes work:

```cpp
// Caller thread (e.g. KoncludeReasoner::classify on the main thread):
CBlockingCallbackData callback;
remoteThread->postEvent(new CDoWorkEvent(&callback));
callback.waitForCallback();  // → QSemaphore::acquire(1) — caller blocks

// Worker thread (remote actor, on its own QThread):
void doCallback() { semaphore.release(); }  // wakes the caller
```

In native Konclude, `CReasonerManagerThread::prepareOntology()` uses exactly this
pattern: posts a work event to Manager and blocks until Manager fires the callback.
In native, this always runs from the main application thread; Qt guarantees the main
thread can block on a semaphore because the OS scheduler will preempt it.

### 2.3 Per-thread state is fresh per call in native

In the native server model, Konclude loads one ontology at startup and classifies it.
Each ontology gets a fresh `COntologyPrecomputationItem`, a fresh `COntologyClassificationItem`,
etc. The long-lived threads (`CPrecomputationThread`, `CSubsumptionClassifierThread`,
`CBackendRepresentativeMemoryCache`, …) exist for the lifetime of the server, but their
*per-ontology state* (hash map entries, running test counters) is only ever populated once
per ontology item, then it stays populated and is never reused.

**This assumption — that per-call state is written once — is the root cause of all
SINGLETON-RESET and ID-GUARD patches.**

### 2.4 mCurrRunningTestParallelCount in native

`CPrecomputationThread::mCurrRunningTestParallelCount` is incremented in
`processCalculationJob()` for every saturation job submitted, and decremented in each
callback handler (`CPrecomputationCalculatedCallbackEvent`, `CSaturationPrecomputationCalculatedCallbackEvent`).

`canProcessMoreTests()` returns `count < mConfMaxTestParallelCount`. In native,
`mConfMaxTestParallelCount` is read from config (typically > 1, allowing parallel
saturation tests). In WASM it is set to 1 to avoid over-subscribing the pthread pool.

In native, the counter starts at 0 for each new ontology and is never stale because
each reasoning session processes one ontology.

---

## 3. WASM Pthreads Pool — What Changed

### 3.1 CThread override (src/compat/overrides/CThread.cpp)

The vendor `CThread.cpp` is excluded from the build; `src/compat/overrides/CThread.cpp`
replaces it. The key change:

```
Native:  CThread extends QThread → exec() runs Qt event loop
WASM:    CThread has a pthread_t + per-thread mutex/condvar + deque<QEvent*>
         startThread() → pthread_create → run() → event loop on the new pthread
         postEvent()   → push to deque + pthread_cond_signal  (non-blocking)
         run()         → pthread_mutex_lock; while(!stop) { cond_wait; dequeue; event(ev); }
         stopThread()  → set shouldStop; cond_signal; pthread_join
```

The semantics are identical from the callers' perspective: `postEvent()` is async and
thread-safe; `event()` is called on the thread's own pthread; `waitSynchronization()`
posts a synchronization event and blocks until the thread processes it.

### 3.2 QSemaphore shim (src/compat/QtCompat.h)

```cpp
class QSemaphore {
    std::mutex mtx;
    std::condition_variable cv;
    int count;
public:
    explicit QSemaphore(int n = 0) : count(n) {}
    void acquire(int n = 1) {
        std::unique_lock<std::mutex> lk(mtx);
        cv.wait(lk, [&]{ return count >= n; });
        count -= n;
    }
    void release(int n = 1) {
        std::unique_lock<std::mutex> lk(mtx);
        count += n;
        cv.notify_all();
    }
};
```

`QSemaphore::acquire()` → `condition_variable::wait()` — this is a real blocking call.
It works correctly on pthreads because `futex_wait` is available on worker threads.
**It must never be called on the Emscripten main thread.** See constraint NO-BLOCK-MAIN.

### 3.3 The cooperative dispatch dead end (why pthreads are required)

The history of six generations of cooperative-dispatch workarounds is documented in
[wasm-pthread-concurrency-architecture-2026-05-08.md](wasm-pthread-concurrency-architecture-2026-05-08.md).
Summary: `COptimizedKPSetClassSubsumptionClassifierThread` spins on
`mCurrRunningTestParallelCount > 0` inside its event handler. No cooperative workaround
can provide a preemption point inside that spin without either:

1. An invasive yield inside the vendor spin loop, or
2. Real preemptive threading (pthreads — the correct solution)

**Do not attempt cooperative dispatch again.** It is structurally incompatible with
the KPSet spin pattern.

### 3.4 Why PROXY_TO_PTHREAD is not used

`PROXY_TO_PTHREAD` would execute the C `main()` function on a worker pthread, making
the Emscripten main thread a pure JS dispatcher. The current build routes the WASM
entry directly to worker threads via the `classify()` / `materialize()` Web Worker
dispatch layer in `ts/worker.ts`. `PROXY_TO_PTHREAD` adds overhead and interacts badly
with the Node.js Worker model already in use.

### 3.5 Singleton reuse — the structural difference from native

In WASM, the same `KoncludeReasoner` instance (and its singleton threads) processes
multiple calls:

```
Call 1:  loadTripleBuffer → classify → reset
Call 2:  loadTripleBuffer → classify → reset
```

After `reset()`, the singleton threads (precomputer, preprocessor, classifier,
BackendAssCache, STPU) continue running. Their internal hash maps, counters, and
thread-local state **persist from Call 1 into Call 2**. Native Konclude never did
this — each ontology was processed once, so per-call state was written once and never
reused.

This is the root cause of:
- All SINGLETON-RESET patches (stale `mCurrRunningTestParallelCount`)
- All ID-GUARD patches (recycled pointer in `mOntItemHash`)
- The BACKENDASSCACHE patch (accumulated `mNextIndiUpdateId`)

---

## 4. Event Flow per Operation

### 4.1 classify() and checkConsistency()

```
JS Web Worker thread
  → KoncludeReasoner::classify()  [worker.ts dispatches to this]
  → KoncludeReasoner::runPipeline(realization=false)
      → prepares reqList: OPPREPROCESSOR + OPPRECOMPUTER + OPCLASSCLASSIFIER
                          + OPOBJECTPROPERTYCLASSIFIER + OPDATAPROPERTYCLASSIFIER
      → CReasonerManagerThread::prepareOntology(ontology, reqList)
          [CBlockingCallbackData: calling thread blocks on QSemaphore]
          │
          │  Manager's pthread event loop:
          ├─► CPreprocessingThread (type=2007 event)
          │     processes ontology structure
          │     fires callback → CRequirementProcessedCallbackEvent → Manager
          │
          ├─► CTotallyPrecomputationThread (type=2007 event)
          │     addIdentifiedRemainingConsistencyRequiredConcepts()
          │       builds allAssertionIndi from all ABox concepts + roles
          │     createSaturationConstructionJob()
          │       STPU processes saturation tasks on its pthread
          │         CBackendRepresentativeMemoryCache Update 1
          │         CBackendRepresentativeMemoryCache Retrieval 1
          │           (getIncompletlyAssociationCachedIndividuals)
          │         ABox individual saturation batch jobs
          │         CBackendRepresentativeMemoryCache Update 2
          │           (8 concurrent label types → 0 remaining)
          │     fires callback → Manager
          │
          ├─► COptimizedKPSetClassifierThread (type=2000 event)
          │     submits N subsumption tests to STPU
          │     waits on mCurrRunningTestParallelCount (in classifier pthread)
          │     CTestCalculatedCallbackEvent type=2001 fires per test
          │     fires callback → Manager
          │
          └─► (object-property + data-property classifiers, similar)
          │
          CBlockingCallbackData::doCallback() releases the caller
      → CReasonerManagerThread::waitSynchronization()
          [barrier: drains Manager's post-callback event queue]
  → KoncludeReasoner::getInferredNTriples()  or  isConsistent()
```

### 4.2 materialize() (adds realization after classification)

Same as classify(), but reqList additionally includes `OPREALIZER`:

```
  ...after classification callback fires...
  │
  ├─► COptimizedRepresentativeKPSetOntologyRealizingThread (type=realizer event)
  │     initializeKPSetsFromConsistencyData()
  │       reads BackendAssCache (populated in Update 2 above)
  │     fan-out possible-instance tests → STPU
  │     fires callback → Manager
  │
  CBlockingCallbackData fires
```

After `runPipeline()` returns, `reset()` calls `stopAndClearRealizers()` to join
realizer threads before they are abandoned.

### 4.3 Thread participation summary

| Thread | classify | checkConsistency | materialize |
|--------|----------|-----------------|-------------|
| CReasonerManagerThread | ✓ | ✓ | ✓ |
| CPreprocessingThread | ✓ | ✓ | ✓ |
| CTotallyPrecomputationThread | ✓ | ✓ | ✓ |
| CBackendRepresentativeMemoryCache | ✓ (Update 1+2, Retrieval 1) | ✓ | ✓ |
| CSingleThreadTaskProcessorUnit (STPU) | ✓ | ✓ | ✓ |
| COptimizedKPSetClassifierThread | ✓ | ✗ | ✓ |
| COptimizedRepresentativeKPSetOntologyRealizingThread | ✗ | ✗ | ✓ |

### 4.4 KoncludeReasoner.cpp orchestration

`runPipeline()` in `src/KoncludeReasoner.cpp`:

1. Calls `mReasonerManager->prepareOntology(ontology, reqList)` — blocks on
   `CBlockingCallbackData` (runs on a worker pthread, not the WASM main thread)
2. Calls `mReasonerManager->waitSynchronization()` — ensures Manager has fully
   drained all post-callback events before the next call begins
3. If realization: calls `stopAndClearRealizers()` to join the realizer thread

The `waitSynchronization()` call (step 2) is essential for sequential correctness.
Without it, Manager's post-callback type=2006 event cascade may still be processing
when the second call's type=2007 event arrives, racing against the cleanup.

---

## 5. BackendAssCache 2-Phase Pipeline

`CBackendRepresentativeMemoryCache` (thread #2 in the inventory) is an actor thread
that maintains a persistent index of individual→label-set associations. It is consulted
by the precomputer and realizer.

### 5.1 The two-phase pattern

All four operations (classify, checkConsistency, materialize, whatIf) run this sequence:

```
Phase 1 — Update 1:
  initializeIndividualsAssociationCaching(ontologyId, individualCount)
    → allocates per-individual association slots
  saturation runs (STPU)
    → individual saturation jobs write initial associations
    → setCacheUpdateId(mNextIndiUpdateId++) per entry

Phase 1.5 — Retrieval 1:
  getIncompletlyAssociationCachedIndividuals(...)
    → returns individuals whose association data is incomplete
    → drives the next batch of ABox individual saturation jobs

Phase 2 — Update 2:
  8 concurrent label types written (8 parallel threads)
  For roberts-family: 404 individuals × 781 labels
  Terminates when "0 remaining" is logged → cache fully populated
```

"0 remaining" in Update 2 is the signal that BackendAssCache is ready for the
classifier and realizer.

### 5.2 mNextIndiUpdateId

`mNextIndiUpdateId` is a global counter that increments on every `setCacheUpdateId()`
call. **It does NOT reset between calls.** After call N, it may be at value 50000.
Call N+1's fresh association data (freshly created, `getPreviousData() == nullptr`)
has an internal `updateId = 1`. This causes a false `incompatibleChanges` detection
(`usedUpdateId (1) != mNextIndiUpdateId (50000)`) unless patch-024 is in place.

### 5.3 LateIndividualLabelAssociationIndexing and WaitIndividualLabelAssociationIndexed

Both are config booleans defaulting to `true`. **Do not change them.**

| Config key | Default | Effect if set to false |
|-----------|---------|----------------------|
| `LateIndividualLabelAssociationIndexing` | `true` | Indexing happens inline during saturation instead of deferred. Disabling it skips the deferred indexing path → all ABox realization data is missing |
| `WaitIndividualLabelAssociationIndexed` | `true` | BackendAssCache waits for indexing to complete before answering Retrieval queries. Disabling → cache answers queries before data is ready → ABox realization hangs on large ontologies |

These were disabled in the "nuclear patch" cycle (2026-06) and broke all ABox realization.

### 5.4 Do not reset BackendAssCache between classify and realize

The realizer (`COptimizedRepresentativeKPSetOntologyRealizingThread::initializeKPSetsFromConsistencyData`)
reads the Update 2 data written by the precomputer in the same call. If BackendAssCache
per-ontology state is cleared between `OPPRECOMPUTER` completing and `OPREALIZER` running
(which happens within the same `prepareOntology()` call), the realizer gets empty data
and produces 0 inferences.

The `resetOntologyData()` approach was explored and abandoned for exactly this reason.

---

## 6. KPSet Parallel Fan-Out and Counter Semantics

### 6.1 Counter lifecycle

`CPrecomputationThread` (base class of `CTotallyPrecomputationThread`) owns:

```cpp
cint64 mCurrRunningTestParallelCount = 0;
cint64 mConfMaxTestParallelCount = 1;  // set to 1 in WASM
```

Flow:

```
processCalculationJob(job, ...)
  → mCurrRunningTestParallelCount++
  → mCalculationManager->calculateJob(job, callbackEvent)
     [STPU processes job on its pthread]
     [callback fires: CPrecomputationCalculatedCallbackEvent or CSaturation...]
        → --mCurrRunningTestParallelCount  (guarded: if (count > 0) { --count; })
        → doNextPendingTests()

doNextPendingTests()
  → while (canProcessMoreTests() && nextTestCreated) { createNextTest(); }

canProcessMoreTests()
  → return mCurrRunningTestParallelCount < mConfMaxTestParallelCount
  → return count < 1
  → return count == 0  (in WASM, with max=1)
```

### 6.2 Deadlock from stale counter

If `mCurrRunningTestParallelCount > 0` at the start of call N+1 (residue from call N):

1. First `createNextTest()` call submits a job → `count++` → count = 2
2. Job completes → `count--` → count = 1
3. `canProcessMoreTests()` = `1 < 1` = false
4. `doNextPendingTests()` creates no more tests
5. Precomputation thread waits forever for a callback that never fires

This is a permanent hang. Patch-033 resets the counter to 0 on new ontology item
creation, before any job is submitted for the new call.

### 6.3 Underflow guard

The guard `if (mCurrRunningTestParallelCount > 0) { --mCurrRunningTestParallelCount; }`
prevents underflow when a reset-to-0 (from patch-033) races with a late callback from
the previous call arriving after the reset but before the new call's first job
increments the counter. Without the guard, underflow → count wraps to
`LLONG_MAX` → `canProcessMoreTests()` returns false forever.

### 6.4 KPSet fan-out mechanics (classifier, not precomputer)

`COptimizedKPSetClassSubsumptionClassifierThread` has its own `mCurrRunningTestParallelCount`
in `CSubsumptionClassifierThread`. It fans out N subsumption tests concurrently on
the STPU pthread pool. The classifier thread (its own pthread) spins until all tests
return. This is the spin that requires real pthreads (see Section 3.3).

The precomputer's counter (Section 6.1) and the classifier's counter are separate
fields in separate classes. Both must follow the same reset-on-new-item pattern.
Currently only the precomputer's reset is in patch-033; the classifier counter resets
naturally because `COptimizedKPSetClassifierThread` is a new object per classify call.

---

## 7. allAssertionIndi and the ALIF+ Invariant

### 7.1 What allAssertionIndi is

`CTotallyPrecomputationThread::addIdentifiedRemainingConsistencyRequiredConcepts()` creates
a temporary fake individual (`tmpAllAssertionIndi`) that aggregates **all ABox concept
assertions and role assertions from all active individuals in the ontology**. This
individual is then submitted for approximated saturation.

Purpose: restriction expressions (`owl:hasValue`, `owl:someValuesFrom`, `owl:allValuesFrom`)
need the BackendAssCache to contain role-neighbour data. Saturating allAssertionIndi
forces that data into the cache even before individual saturation runs.

### 7.2 Why ALIF+ (FP/IFP) ontologies loop

When the ontology has a `FunctionalProperty` or `InverseFunctionalProperty` (ALIF+
condition):

1. The saturation algorithm creates a self-referential role assertion on allAssertionIndi
   (a role pointing to itself, because FP/IFP role semantics generate nominal-delayed
   processing)
2. The saturation job is scheduled, runs, but the self-referential assertion causes the
   nominal expansion to schedule allAssertionIndi *again*
3. On the next type=1 callback, `createMarkedConceptSaturationProcessingJob()` is called
4. `isAllAssertionIndividualSaturated()` returns false (if the saturated flag was not set)
5. allAssertionIndi is re-scheduled → loop → KPSet never terminates → permanent hang

### 7.3 The fix: two conditional guards

Both guards are in `CTotallyPrecomputationThread.cpp`. Both require an FP/IFP role scan:

```cpp
bool hasAlifPlusCondition = false;
for (CRole* role : rolesInRBox) {
    if (role->getFunctional() || role->getInverseFunctional()) {
        hasAlifPlusCondition = true; break;
    }
}
```

**Guard 1** — in `addIdentifiedRemainingConsistencyRequiredConcepts()`:

```cpp
if (!hasAlifPlusConditionForRoles) {
    // Only add role assertions to allAssertionIndi for non-FP/IFP ontologies
    for (CRole* role : assRoleSet) {
        CRoleAssertionLinker* linker = ...;
        tmpAllAssertionIndi->addAssertionRoleLinker(linker);
    }
}
```

Skips adding role assertions to allAssertionIndi for ALIF+ ontologies. Without role
assertions, no self-referential assertion can form.

**Guard 2** — in `createMarkedConceptSaturationProcessingJob()`:

```cpp
if (!hasAlifPlusCondition && !totallyPreCompItem->isAllAssertionIndividualSaturated()) {
    // schedule allAssertionIndi for saturation
    satJob = generator.extend(...allAssertionIndi...);
    totallyPreCompItem->setAllAssertionIndividualSaturated(true);
} else {
    totallyPreCompItem->setAllAssertionIndividualSaturated(true);  // MANDATORY
}
```

The `else { setAllAssertionIndividualSaturated(true); }` branch is **mandatory**. Without
it, `isAllAssertionIndividualSaturated()` stays false and the job is re-scheduled on
every type=1 callback indefinitely.

### 7.4 What NOT to do (nuclear failures)

| Approach | Consequence |
|---------|------------|
| `if (false) { ...role assertions... }` — skip unconditionally | Restrictions (hasValue, someValuesFrom) break: they need role assertions in BackendAssCache |
| `if (false) { ...schedule allAssertionIndi... }` — skip scheduling unconditionally | roberts-family ABox fails: non-FP ontologies need allAssertionIndi saturation to seed BackendAssCache |
| Set `WaitIndividualLabelAssociationIndexed=false` | ABox realization hangs: cache answers retrieval queries before data is ready |
| Set `LateIndividualLabelAssociationIndexing=false` | ABox realization fails: deferred indexing is skipped entirely |

### 7.5 Current state (as of 2026-06-09)

The two-guard fix is documented and designed (see memory: `project-alif-plus-fix-strategy`).
It is **not yet applied** to the main branch. Current state:
- Patches 034-036 (now reverted, not in this repo) implemented a JS-side FP/IFP workaround
  that fixed 1-filler FP/IFP cases but broke restriction tests
- The branch was reverted to `d712b0a` (patches 001-033 only, 325 tests passing)
- 2-filler FP/IFP cases remain upstream bugs; 1-filler is the open C++ fix target

---

## 8. Critical Invariants Checklist

Read this section before modifying any C++ reasoning code.

### INV-1: SINGLETON-THREAD

> **All reasoning threads are long-lived singletons. Any per-call state must be explicitly
> reset on new ontology item creation. Never assume that creating a new ontology item
> implies a fresh thread state.**

Threads affected: CPrecomputationThread, CPreprocessingThread, CSubsumptionClassifierThread,
CBackendRepresentativeMemoryCache, CSingleThreadTaskProcessorUnit.

**Consequence of violation:** Stale counters, stale hash entries, or stale semaphore
counts from call N corrupt call N+1.

**Test:** Run two sequential classify() calls on different ontologies. Both must complete.

---

### INV-2: NO-BLOCK-MAIN

> **No blocking call (QSemaphore::acquire, std::mutex::lock in a blocking path,
> condition_variable::wait) may execute on the Emscripten main thread. All blocking
> operations must run on worker pthreads.**

The Emscripten main thread uses a browser-style event loop (libuv in Node.js). It
cannot invoke `futex_wait`. Any `condition_variable::wait` on the main thread hangs
indefinitely.

`KoncludeReasoner::classify()` is called from the Web Worker thread (`ts/worker.ts`),
not the JS main thread. The `prepareOntology()` blocking call is safe because it runs
on this worker thread. Do not move any blocking reasoning call to the JS main thread.

**Consequence of violation:** Silent hang with no error output.

---

### INV-3: PTHREAD-COOPERATIVE

> **WASM pthreads share the Emscripten thread pool cooperatively. A tight busy-loop
> on a worker pthread can starve other workers. Never spin without yielding.**

Emscripten's pthread pool (32 threads, `PTHREAD_POOL_SIZE=32`) is pre-allocated. If a
worker pthread spins without yielding (`while (flag) {}`), other pthreads waiting for
CPU time may not get scheduled, causing apparent hangs.

The KPSet classifier's spin on `mCurrRunningTestParallelCount` is acceptable because
it runs on its own dedicated pthread while STPU workers run on separate pthreads in
the pool. Do not introduce new spin loops elsewhere.

**Consequence of violation:** Apparent hang that disappears with verbose logging (which
adds implicit `fflush` yield points).

---

### INV-4: COUNTER-RESET

> **`mCurrRunningTestParallelCount` in `CPrecomputationThread` must be reset to 0
> when a brand-new ontology item is created for that thread. Never assume it is zero
> from a prior call.**

Location: `CPrecomputationThread.cpp` — in the `if (!item)` branch of the
`COntologyPrecomputationThread` event handler where a new item is inserted into `mOntItemHash`.

The decrement guard (`if (count > 0) { --count; }`) must also be present in both
callback decrement paths (`CPrecomputationCalculatedCallbackEvent` and
`CSaturationPrecomputationCalculatedCallbackEvent` handlers).

**Consequence of violation:** `canProcessMoreTests()` returns false permanently →
`doNextPendingTests()` dispatches no work → precomputation hangs.

---

### INV-5: BACKENDASSCACHE-PIPELINE

> **BackendAssCache operates in two update phases. Do not reset its per-ontology
> data between precomputation and realization on the same `prepareOntology()` call.
> The realizer reads Update-2 data written by the precomputer.**

Both `OPPRECOMPUTER` and `OPREALIZER` run within a single `prepareOntology()` call
when realization is requested. Manager drives them sequentially: precomputer completes
→ classifier completes → realizer starts. The realizer's `initializeKPSetsFromConsistencyData()`
reads the BackendAssCache data that precomputation wrote in Update 2.

If BackendAssCache is reset (e.g. via `resetOntologyData()`) between the two,
the realizer reads empty data and produces 0 instance assignments.

**Consequence of violation:** Realization produces no output triples; all
`rdf:type` memberships are missing from materialized results.

---

### INV-6: BACKENDASSCACHE-INDEXING

> **`LateIndividualLabelAssociationIndexing` and `WaitIndividualLabelAssociationIndexed`
> must remain at their defaults (`true`). Disabling either breaks ABox realization.**

These config keys control how BackendAssCache indexes individual label associations.
They should be treated as read-only constants in the WASM port:

- `LateIndividualLabelAssociationIndexing=true`: indexing is deferred until after
  saturation completes, then applied in batch (Update 2). Setting false skips the
  deferred path and produces an incomplete index.
- `WaitIndividualLabelAssociationIndexed=true`: BackendAssCache waits for the deferred
  indexing to complete before answering Retrieval queries. Setting false allows queries
  before data is ready.

Both were set to false during the nuclear patch cycle and broke all ABox realization.

**Consequence of violation:** ABox realization hangs (false) or produces empty results (false).

---

### INV-7: ALIF-GUARD

> **allAssertionIndi role-assertion collection and saturation scheduling must be
> conditioned on `!hasAlifPlusCondition` (an FP/IFP role scan of the ontology's RBox).
> Applying the guard unconditionally to all ontologies breaks restriction tests.
> Applying no guard at all causes an infinite KPSet loop for FP/IFP ontologies.**

The guard requires:

1. A per-call FP/IFP role scan: `role->getFunctional() || role->getInverseFunctional()`
2. Two independent guard sites in `CTotallyPrecomputationThread.cpp`
3. `setAllAssertionIndividualSaturated(true)` in *both* the if-branch and the else-branch
   of Guard 2 — without the else, the gate re-fires on every type=1 callback

The guard cannot be global state — it must be computed fresh per call because different
calls process different ontologies with different RBox contents.

**Consequence of violation (guard too broad):** Restriction tests (hasValue, someValuesFrom,
allValuesFrom, hasSelf) produce wrong or empty results.

**Consequence of violation (no guard):** FP/IFP ontology hangs in precomputation
with KPSet cycling indefinitely.

---

### INV-8: CALLBACK-ONCE

> **Every cross-thread callback at the C++ level must fire exactly once. Multiple
> fires corrupt thread counters and produce duplicate or use-after-free accesses.**

Enforced by patches 011–015. All callback objects that can be reached from multiple
pthreads use an atomic exchange pattern (`exchange(nullptr)`) or `takeCallback()` to
ensure only the first caller fires and subsequent callers no-op.

**When adding new cross-thread callbacks:** always use `std::atomic<CCallbackData*>`
for the stored pointer and `takeCallback()` at the call site.

**Consequence of violation:** Double-decrement of requirement counters, double-postEvent
to a Manager that may have already deleted the event, or use-after-free crashes.

---

### INV-9: ID-GUARD

> **Thread-local hash maps keyed by raw `CConcreteOntology*` pointer must use a
> companion `mOntIdHash: QHash<CConcreteOntology*, cint64>` to detect recycled
> pointers. Never compare `item->getOntology()` to detect staleness — the pointer
> may have been freed (UB).**

Enforced by patches 022/023. Pattern:

```cpp
// On insert:
mOntItemHash.insert(ontology, item);
mOntIdHash.insert(ontology, ontology->getOntologyID());

// On lookup:
COntologyItem* item = mOntItemHash.value(ontology);
if (item && mOntIdHash.value(ontology, -1) != ontology->getOntologyID()) {
    mOntItemHash.remove(ontology);
    mOntIdHash.remove(ontology);
    item = nullptr;
}
```

The same pattern must be applied to any new hash map keyed by `CConcreteOntology*`
in any singleton thread.

**Consequence of violation:** A new ontology at the same freed address silently reuses
stale item state from the prior call, causing incorrect reasoning or crashes.

---

## 9. Open Work — ALIF+ C++ Fix Still Needed

**Status as of 2026-06-09:** The two-guard ALIF+ fix (Section 7.3) is designed and
verified conceptually but **not yet applied to the main branch**.

Current baseline is commit `d712b0a`:
- Patches 001–033 applied
- 325 tests passing / 1 known ALIF+ gap (FP/IFP materialize after warmup)
- 2-filler FP/IFP cases (fixture B, C in alif-precomp test) are upstream Konclude bugs
  unrelated to the ALIF+ guard

**Next fix target:** Apply the two conditional guards in `CTotallyPrecomputationThread.cpp`
(Guard 1 in `addIdentifiedRemainingConsistencyRequiredConcepts()` and Guard 2 in
`createMarkedConceptSaturationProcessingJob()`), delivered as a new patch file.

**Verification after fix:** All of these must pass:
- Restriction tests (hasValue, someValuesFrom, allValuesFrom, hasSelf)
- roberts-family ABox / materialize
- alif-precomp fixture A (FP 1-filler materialize after warmup)
- Sequential calls R12–R14

**Update this document** once the fix lands and remove this section.

---

## References

- [wasm-pthread-concurrency-architecture-2026-05-08.md](wasm-pthread-concurrency-architecture-2026-05-08.md) — full history of cooperative dispatch failures and pthreads decision
- [emscripten-pthread-exit-browser-fix-2026-05-13.md](emscripten-pthread-exit-browser-fix-2026-05-13.md) — KPSet "unwind" pthread exit suppression
- Patch files: `patches/001` through `patches/033`
- WASM CThread override: `src/compat/overrides/CThread.cpp`
- WASM STPU override: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- Qt shim: `src/compat/QtCompat.h`
- Orchestration: `src/KoncludeReasoner.cpp`
- Key vendor files:
  - `vendor/konclude/Source/Concurrent/CThread.cpp` (native baseline)
  - `vendor/konclude/Source/Concurrent/Callback/CBlockingCallbackData.cpp`
  - `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp`
  - `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
  - `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
  - `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
