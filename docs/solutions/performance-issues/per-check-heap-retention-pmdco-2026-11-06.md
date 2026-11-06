---
title: Per-check heap retention on PMDco consistency checks (patches 005/006/007, freeOntology)
date: 2026-11-06
category: performance-issues
module: vendor/konclude classifier + triples, src/KoncludeReasoner.cpp
problem_type: performance_issue
component: memory-lifecycle
severity: high
root_cause: missing_destructor
resolution_type: code_fix
tags: [memory-leak, wasm-heap, memory-pool, redland, konclude, explain, repair, native-harness, jemalloc]
---

# Per-check heap retention on PMDco consistency checks

## Problem

explain/repair issue 150-600 consistency checks per call, each on different content, so each check rebuilds the whole ontology. The wasm32 heap grew with every check and was never returned; PMDco explain trapped at call ~193 ("memory access out of bounds"). The only mitigation was the TS Worker recycle (heap > 2 GiB).

Native harness, PMDco 17k triples, 10 distinct-content `consistency()` steps, live heap after flush:

| Series | Before | After 005 + 006 + freeOntology | After 007 too |
| --- | --- | --- | --- |
| consistent sets | +91 MB/check (pools +71) | +20 | +5.4 |
| inconsistent sets | +22 MB/check | +16.5 | +2 |

Product path (`seq-sync`, `syncBuffers` -> `ensureBuilt`) and the harness `loadNTriplesStr` path behave the same.

## Root causes

1. **Leak B (pools, consistent sets only).** `COptimizedKPSet{Class,Role}OntologyClassificationItem` collects pseudo-model pools in `mMemoryPoolContainer` (`addMemoryPools(tempMemoryPoolConAllocMan.takeMemoryPools())`). `CMemoryPoolContainer`'s destructor is empty and the item destructors never released the pools. Patch 005 releases them in both destructors through a temporary `CNewAllocationMemoryPoolProvider` (same pattern as `releaseTaskChainPools`, patch 023 lineage).
2. **Leak A (load/build, every check).** `~COntologyTriplesData` does not exist: the `CTriplesData` objects (Redland world, storage, model) it lists are never deleted. `Impl::freeOntology()` in `src/KoncludeReasoner.cpp` now deletes the ontology, then its owned `CRedlandStoredTriplesData` (skipped when `mRevisionChain` is non-empty, because revisions share data). Patch 006: `~CRedlandStoredTriplesData` frees leftover statement-linker copies (the indexer frees and clears them itself once it ran).

3. **The pin (patch 007).** `CConcreteOntologyRedlandTriplesDataExpressionMapper::mapTriples` opened a `librdf_model_find_statements` stream plus partial statement only as an existence probe and never freed them, and `getOWLClassInstanceNodesStream()->forEach(...)` (line ~74) never called `releaseRedlandNodeStreamWrapper`. An open librdf stream holds a reference to the model's storage, so `librdf_free_model/storage` ran (gdb showed it) but the hashes stayed alive: `librdf_new_hash` 14 vs `librdf_free_hash` 4 over 2 steps, stream new/free off by 4. This explained why a standalone C program with the same Redland calls freed everything while the process did not.

## What did not work / misleading

- The first suspects (kept consistency / saturation task chains, patch 023 path) were small: `RELCHAIN` instrumentation showed ~12 MB/call released, not the 71 MB.
- Parked free-list pools were not the cause (15 of 316 MB).
- The pool-site registry (`KON_POOLSITE`) records the stack of the FIRST allocation only. Pools recycle through free lists, so the "owner" stack (`executeORBranching`, `createSatisfiableCalculationTask`) was misleading; restamping the stack on every re-acquire exposed the real consumers (`handleTask`, KPSet `calculateSatisfiable`).
- gdb breakpoints on dtors (`~CConsistenceTaskData`, `~CConsistence`, `~CSaturationTaskData`) confirmed the task data WAS destroyed each call, which ruled out the task chain.

## Verification

- WASM rebuild (patches 000-006), vitest: 622 passed, 6 skipped (unchanged). With patch 007 only the PMDco determinism test and the repair trace were re-run (full suite not re-run).
- PMDco `repair()` (`tests/bench/repair-case.mjs . tests/fixtures/pmdco.nt bfo`): 83 checks, 0 Worker recycles, max heap 1201 MB (005/006) -> 1024 MB = initial heap, never grew (with 007), 29 s, same justifications [3,3] and repairs [1,1,2], verified consistent, store untouched.
- Patch stack 000-006 verified to apply from a clean `git archive` of the submodule.

## Open

- Remaining native growth is small (+2 / +5 MB/check); not investigated further.
- Optional: consistency-only pipeline requirement list in `runPipeline` (skip precompute-saturation / class classification on a pure consistency check).

## Method (reusable)

- `REPRO_MEM=1 REPRO_FLUSH=1 [REPRO_CONTINUE=1] setarch -R build-native/konclude_repro --seq "k:f.nt~drop100,k:f.nt~drop200,..."`: `~dropK` removes line K so each step has new content; `pmdco-bad.nt` = fixture + two disjoint type assertions (needs `REPRO_CONTINUE=1`).
- jemalloc profiles need an unsized-delete shim (`operator delete(void*, size_t)` -> `free`) because of latent wrong-size deletes; then `scripts/heap-diff.py` between two `heap.N.prof`.
- Stale native tree (2000+ files "outdated" after git operations): `find build-native -name '*.o' -exec touch {} +` then incremental `cmake --build` (~2 min per changed file); a full rebuild is ~2 h.
- Count librdf objects with gdb (`break librdf_new_stream/free_stream/new_hash/free_hash`, silent+continue, `info breakpoints`): an unbalanced pair points at a leaked handle that pins a whole structure even though the owner's free function ran.
- Always check the retention claim by counting dtor hits in gdb (`break Class::~Class` with silent/continue) before assuming a lifetime bug.

## Prevention

- Any class holding a `CMemoryPoolContainer` needs a destructor that releases its pools; audit the remaining holders (`CBackendAssociationCacheHandler`, `CSaturationNodeExpansionCacheHandler`, `CComputedConsequencesCacheHandler`, `CSatisfiableExpanderCacheHandler`, `CReuseCompletionGraphCacheHandler` all have `mMemPoolCon` and no visible release in their destructors).
- Keep the per-check growth series (10 distinct-content steps, consistent and inconsistent) as the regression measurement for any lifecycle patch.

Related: `scheduler-free-pool-memory-retention-2026-10-11.md`, `docs/solutions/best-practices/native-debug-pipeline-playbook.md`.
