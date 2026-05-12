---
title: "Konclude KPSet classifier requires real pthreads — cooperative single-thread WASM deadlocks"
date: 2026-05-08
category: docs/solutions/architecture-patterns/
module: wasm-threading
problem_type: architecture_pattern
component: tooling
severity: critical
applies_when:
  - Porting a C++ multi-actor/event system to WASM where handlers busy-wait for results from other actors
  - The upstream system uses blocking synchronization (QSemaphore::acquire, condition_variable::wait) inside event handlers
  - Worker threads submit tasks and spin-wait for results within the same call frame
tags:
  - wasm
  - emscripten
  - pthreads
  - concurrency
  - konclude
  - actor-model
  - deadlock
  - kpset-classifier
---

# Konclude KPSet classifier requires real pthreads — cooperative single-thread WASM deadlocks

## Context

The Konclude OWL-DL tableau reasoner is a concurrent actor system. Each `CThread` subclass is an actor
receiving work via `postEvent()` and processing it in its own OS thread. `QSemaphore`-based blocking
and Qt event loops are the synchronization primitives that make this work.

During the WASM port, Qt was eliminated and replaced with a cooperative dispatch model:
- Global FIFO queue (`sGlobalEventQueue`) in `src/compat/overrides/CThread.cpp` serialized all events
- `drainUntilCount()` processed the queue cooperatively until a semaphore condition was satisfied
- `CSingleThreadTaskProcessorUnit` (STPU) ran tableau tasks synchronously

This appeared to work for early classification phases (LUBM passes) but fails fatally during the KPSet
subsumption phase, causing Roberts family and GALEN ontology smoke tests to hang indefinitely.

Six generations of workarounds were attempted across multiple debug sessions before the structural root
cause was identified (session history):

1. `processingLoop()` busy-loop — fixed by calling `processingLoop()` directly on `signalizeEvent()`
2. vtable null crash from premature `CThread::run()` teardown; per-thread deferred queue introduced
3. Per-thread guard failed for GALEN cross-thread `postEvent()`; replaced with global BFS trampoline
4. `vector<bool>` proxy dangling reference in `QHash::const_iterator::value()` — fixed by returning by value
5. `CBlockingCallbackData` use-after-free on stack-allocated objects — partially worked around
6. KPSet classifier spin deadlock identified as structural root cause — pthreads decision made

## Guidance

**Do not use cooperative dispatch as a substitute for pthreads in this port. Enable Emscripten pthreads.**

```cmake
# emscripten.cmake
target_compile_options(konclude PRIVATE -pthread)
target_link_options(konclude PRIVATE
    -pthread
    -sUSE_PTHREADS=1
    -sPROXY_TO_PTHREAD=1
    -sPTHREAD_POOL_SIZE=8
    -sALLOW_MEMORY_GROWTH=1
)
```

Required HTTP headers for `SharedArrayBuffer` (needed by pthreads):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These are satisfiable in the Web Worker deployment model this package already uses.

**Replace the cooperative threading shim with real POSIX threading:**

- Remove `sGlobalEventQueue`, `drainUntilCount`, `gWasmSemDrainUntilCount` from `src/compat/overrides/CThread.cpp`
- Remove `CBlockingCallbackData` override
- Replace `QSemaphore` shim with `std::mutex` + `std::condition_variable`:

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
    bool tryAcquire(int n = 1) {
        std::unique_lock<std::mutex> lk(mtx);
        if (count >= n) { count -= n; return true; }
        return false;
    }
};
```

Known constraints (session history):
- `ALLOW_MEMORY_GROWTH=1` may conflict with SharedArrayBuffer on some Emscripten versions; use fixed
  `INITIAL_MEMORY=536870912` (512 MB) if growth causes issues
- Node.js requires `--experimental-wasm-threads --experimental-wasm-bulk-memory` flags
- `PTHREAD_POOL_SIZE=8` is a safe starting value; tune to max concurrent `CThread` instances

## Why This Matters

The KPSet classifier (`COptimizedKPSetClassSubsumptionClassifierThread`) pattern inside its
`CClassifyOntologyEvent` (type=2000) handler:

```
1. Receive CClassifyOntologyEvent — handler entry
2. Submit N independent tableau tests to STPU via CTaskEventCommunicator
3. SPIN: while (currRunningTestParallelCount > 0) {}   ← never yields
4. Tests complete → post CTestCalculatedCallbackEvent (type=2001) via postEvent()
5. Handler returns only after all type=2001 results delivered
```

In single-threaded WASM, steps 3 and 4 are mutually exclusive: the handler spins (step 3) so
`drainUntilCount` cannot run, so type=2001 events in `sGlobalEventQueue` are never delivered,
so `currRunningTestParallelCount` never decrements, so the spin never exits. **Permanent hang.**

This is not a fixable bug — it is the correct behavior of the classifier running on the wrong substrate.
The spin in step 3 is designed to be preempted by the OS scheduler while real worker threads deliver
results. No cooperative workaround can replace preemption without either:

1. An explicit yield point inside the vendor spin loop (invasive modification of `COptimizedKPSetClassSubsumptionClassifierThread`)
2. Real preemptive threading (pthreads — the correct solution)

Without pthreads, any OWL ontology that reaches the KPSet subsumption phase hangs permanently.

## When to Apply

- Porting any C++ multi-actor system to WASM where actors use blocking waits (not just callbacks) to coordinate
- The upstream system has `QSemaphore::acquire()`, `condition_variable::wait()`, or any spin on cross-thread
  data inside event/message handlers
- The actor system has producer-waits-for-consumer patterns within a single call frame

Does **not** apply when all cross-thread communication is purely callback/future-based with no blocking
waits anywhere on the call stack.

## What Didn't Work

1. **Patching `QSemaphore::tryAcquire` to drain events** — fixed early phases that use `tryAcquire`-style
   polling, but KPSet uses a direct integer spin, not `tryAcquire`. Moved the deadlock one phase later.

2. **Re-entrant `drainUntilCount`** — depth-tracked re-entrancy in the drain. Irrelevant: the spin contains
   no yield point from which to call the drain. Re-entrancy does not provide a yield point.

3. **Forcing `mConfDirectUpdateSynchronization = true`** — removed one crash in the cache layer but caused
   a different hang in the preprocessing chain (that path relied on async event delivery to another thread).

4. **Modifying the KPSet spin to call a drain inline** — requires patching a large, deeply-interdependent
   vendor file. Even if done, a cooperative drain cannot block-and-yield without stack-switching. Rejected
   as invasive, fragile across upstream updates, and still structurally wrong.

**Root pattern**: Every single-thread workaround patches one manifestation of the structural mismatch while
leaving the root cause intact. The correct fix is pthreads, not more workarounds.

## Related

- Pthreads migration plan: [docs/plans/2026-05-06-002-fix-feat-wasm-correctness-pthreads-plan.md](docs/plans/2026-05-06-002-fix-feat-wasm-correctness-pthreads-plan.md)
- Port overview plan: [docs/plans/2026-05-04-001-feat-konclude-wasm-npm-port-plan.md](docs/plans/2026-05-04-001-feat-konclude-wasm-npm-port-plan.md)
- Key affected files: `src/compat/overrides/CThread.cpp`, `src/compat/QtCompat.h`
- Classifier: `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
