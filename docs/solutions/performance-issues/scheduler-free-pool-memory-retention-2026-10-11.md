---
title: "Per-call memory retention in long-lived Konclude: scheduler free-pool reserves and overtaken task data"
module: "Konclude scheduler / WASM kernel (CTaskHandleLimitedReserveMemoryPoolAllocationManager, KoncludeReasoner)"
date: 2026-10-11
problem_type: performance_issue
component: background_job
severity: high
symptoms:
  - "One Roberts-family realization left ~1.7 GB live heap after the call"
  - "reset() freed nothing; live heap grew 1748 -> 3001 -> 3898 MB over three sequential calls"
  - "4 GiB WASM heap exhausted: 'invokeEntryPoint: thread crashed: memory access out of bounds' (mimalloc trap), then ReasonerStalledError: kernel stalled"
  - "Roberts suite files (entailment-coverage, explanation-persistence) failed in the full vitest run"
root_cause: memory_leak
resolution_type: code_fix
tags: [memory, wasm, scheduler, memory-pool, heap-profiling, sequential-calls, patches, jemalloc]
---

# Per-call memory retention: scheduler free-pool reserves and overtaken task data

## Problem
Upstream Konclude is a one-shot process: it classifies, answers, exits. Several allocators assume the OS reclaims everything at exit. In a long-lived process (our WASM Worker, or the native `konclude_repro` harness) the retained memory of one call (~1.7 GB for Roberts) stays, the next call adds to it, and the 4 GiB wasm32 heap runs out.

## Symptoms
- `REPRO_MEM=1 konclude_repro --seq` (mallinfo2 live MB): before-reset == after-reset (reset frees nothing); live after op over three `m:roberts` calls 1748 / 3001 / 3898 MB.
- WASM: `invokeEntryPoint: thread crashed: memory access out of bounds`, stack in `operator new -> mi_malloc -> ... attempt_allocate` (4 GiB heap exhausted while the previous ontology is alive), followed by `ReasonerStalledError`.
- Counters after call 1 (patch 024): 8945 tasks created = completed, only 22 "kept"; `containersReleased` 15474, but pools allocated 36562 (1624 MB) vs freed 3708 (177 MB): 1447 MB of the 1748 MB live sat in pools handed back but never freed.

## What Didn't Work
- **Core-dump-style comparison alone.** Dumps show bytes without allocation sites or types. An allocation profile with call stacks answered "what" and "when" much better.
- **Assuming the overtaken saturation/consistence data was the bulk.** Patch 023 frees only ~320 MB of ~1.5 GB per call.
- **Heap profile owner stacks alone.** They pointed at task pools, not at why those were still allocated. Counting pool alloc/free vs task lifecycle (patch 024) found it.
- **graphify on `Source/Reasoner` only.** The pool providers live in `Source/Utilities` and `Source/Scheduler`, so graphify had no edges for them; those had to be indexed separately and merged (`graphify merge-graphs`). Code reading still decided.
- **Reserve limit 64.** Step 1 took >300 s instead of 40 s (pool churn through the allocator). 1024 is fine.
- **Several Roberts processes in parallel.** They starve each other's CPU and trip the harness watchdog.
- **TS-side Worker recycle on heap size.** Only treats the symptom and is gated on changed content, so repeated calls on the same content never recycle.

## Solution
Four patches (`patches/023-026`).

**Root cause, 025:** task processor threads keep up to 80000 (single-thread unit: 30000) free ~44 KB pools each, up to ~3.5 GB per thread:

```cpp
// CTaskProcessorThread.cpp, CTaskProcessorSchedulerThread.cpp, CTaskProcessorCompletorThread.cpp
mMemoryAllocator = new CTaskHandleLimitedReserveMemoryPoolAllocationManager(mMemoryPoolProvider, 80000, 30);
//                                                                                              ^^^^^^ -> 1024
// CSingleThreadTaskProcessorUnit.cpp: 30000 -> 1024
```

**Return the reserve after a call, 026:** free lists belong to their owner thread (no locking), so each thread frees its own list when it sees a new flush generation:

```cpp
// src/compat/KonPoolStats.h
inline std::atomic<long long> gFlushGen{0};
inline void requestPoolFlush() { gFlushGen.fetch_add(1, std::memory_order_release); }

// CTaskProcessorThreadBase::processingLoop (the loop wakes at least every 100 ms)
if (mSeenPoolFlushGen != KonPoolStats::gFlushGen.load(std::memory_order_acquire)) {
    mSeenPoolFlushGen = KonPoolStats::gFlushGen.load(std::memory_order_acquire);
    if (auto* poolMan = dynamic_cast<CMemoryPoolAllocationManager*>(mMemoryAllocator))
        poolMan->flushFreePools();
}

// src/KoncludeReasoner.cpp, end of runPipeline()
KonPoolStats::requestPoolFlush();
```

**Task data, 023:** `CSaturationTaskData` / `CConsistenceTaskData::overtakeData()` mark the task chain `setMemoryReleaseable(false)`, but their destructors were empty. They now release the chain's pools if `mOvertaken`. `CTotallyOntologyPrecomputationItem` deletes every saturation data entry except `mLastSaturData` (owned by `CPrecomputation`); consistence data is owned by `CConsistence`, so the item must not delete it (double free).

**Counters, 024:** `KonPoolStats` (tasks created/completed/kept, containers released, pools alloc/free) printed by `REPRO_MEM=1` as `POOLS` lines.

Results (Roberts, seed 5, live MB after op, calls 1/2/3): before 1748/3001/3898; with 025 1067/1838/2185; with 025+026 after flush 682/1487/1842. Full vitest suite 573 passed, 0 failed (the two Roberts failures are gone).

## Why This Works
`CLimitedReserveMemoryPoolAllocationManager::releaseTemporaryMemoryPool` puts each finished task's pool on a per-thread free list and only shrinks it above `freeReserveLimit`. With 80000 pools that is gigabytes kept "for reuse", invisible in a one-shot process and fatal in a persistent one. A small cap bounds it; the flush returns the rest when threads are idle. What remains after the flush (~680 MB per call: ABox completion graph of the kept consistency task, saturation data, ontology) is valid data kept for the two-generation ontology chain, freed when its generation dies.

## Prevention
- **Memory census per step.** `REPRO_MEM=1 [REPRO_FLUSH=1] setarch -R ./build-native/konclude_repro --seq "m:R,m:R,m:R"`: look at before-reset vs after-reset and growth per call. A reset step that frees nothing, or growth well above one ontology generation per call, is a regression.
- **Counters before profilers.** If pool bytes allocated minus freed is far above what live tasks need, pools are stuck in reserve lists again.
- **Heap profile recipe.** `LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=prof:true,lg_prof_sample:16`, `mallctl("prof.dump")` from the harness at chosen points, symbolize with `addr2line -f -C` in a batch (one call per binary; per-address calls are far too slow), diff aggregated owner stacks.
- **Rule for vendor changes.** Any reserve, cache or free list in vendor code needs a bounded size and a return path for persistent use; ask "did this assume process exit?" Signal owner-thread data with a generation counter instead of cross-thread access.
- **Run one Roberts process at a time** and use `REPRO_HASH_SEED=5 setarch -R` for a fast, reproducible order.
- **Applying patches:** `apply-patches.sh` skips new patches when the sentinel exists; use `make reset-patches` (full rebuild) or `patch -p1` by hand plus an incremental `make`.

## Related
- [self-invalidating-reasoner-api-2026-10-10.md](../architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md): Worker recycle is now a backstop, this is the primary fix.
- [sequential-call-object-lifecycle.md](../debugging/sequential-call-object-lifecycle.md) and the "keep while valid, free on change" lifecycle paradigm.
- [wasm-threading-model-invariants.md](../architecture-patterns/wasm-threading-model-invariants.md): per-thread flush respects owner-thread rules.
- Sibling leak class (missing destructors): `docs/plans/2026-10-01-001-fix-realizer-combined-neighbour-role-destructor-leaks-plan.md`.
- Known and pre-existing, not caused by this fix: order-dependent step time (one Roberts step took 190 s once, 43 s on repeat) and `isRelationOf` canonical differences between sequential native steps.
