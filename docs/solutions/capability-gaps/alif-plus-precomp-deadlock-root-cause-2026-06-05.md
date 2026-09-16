---
module: capability-gaps
tags:
  [
    wasm-regression,
    precomputing-deadlock,
    alif-plus,
    functional-property,
    inverse-functional-property,
    singleton-thread-reuse,
    backend-asscache,
  ]
problem_type: deadlock-root-cause
date: 2026-06-05
---

# ALIF+ Precomputing Deadlock Root Cause — 2026-06-05

## Problem

`materialize()` hung indefinitely on any ontology containing
`owl:FunctionalProperty` or `owl:InverseFunctionalProperty` with ABox individuals
in WASM, even with a single filler that native Konclude v0.7.0 completes in ~19ms.

The hang was a WASM regression (not a native Konclude bug): Fixture A (FP 1-filler)
completes natively but hung in WASM. Fixture B (FP 2-fillers) hangs natively too
(upstream Konclude v0.7.0 bug) and continues to be skipped.

## Investigation Method

See `alif-plus-delta-debug-fixtures-2026-06-04.md` for fixture pairs and verbose
log observations. The `WASM_PRECOMP_VERBOSE` logging in
`CTotallyPrecomputationThread::createNextTest()` (patches/032, 033) confirmed:

- Non-FP warmup: full precompute trace including `FINISH_ONTOLOGY_PRECOMPUTATION`
- FP Fixture A: `precompute-event` log fired but `createNextTest: entry` never fired

This pointed to `canProcessMoreTests()` returning false (H3: stale counter).

## Root Cause: Three Interacting Bugs

### Bug 1: Stale `mCurrRunningTestParallelCount`

**Location:** `CPrecomputationThread::processCustomsEvents`, `CPrecomputeOntologyEvent` handler

**Cause:** The WASM build reuses a single `CTotallyPrecomputationThread` across all
calls (see `CPrecomputationManager.cpp` override). In native Konclude, each call
gets a fresh thread with `mCurrRunningTestParallelCount = 0`. In WASM, late-arriving
callbacks from call N can leave the counter at 1 when call N+1's precompute event
arrives. `canProcessMoreTests()` returns `1 < 1 = false`; `createNextTest()` is
never called; the thread idles forever.

**Fix (patches/034-precomp-counter-reset.patch):** Reset `mCurrRunningTestParallelCount = 0`
when a brand-new ontology item is created. Guard decrements to prevent going negative.

### Bug 2: BackendAssCache Stale State

**Location:** `src/KoncludeReasoner.cpp` `reset()`, BackendAssCache internals

**Cause:** After each call, `mOntologyIdentifierDataHash` and related maps in the
BackendAssCache accumulate entries for the old ontology. On the next ALIF+ call,
the saturation algorithm finds stale cache data for the new ontology's ID (because
the WASM singleton persists all state) and hangs waiting for a retrieval that never
completes.

**Fix (patches/035-backendasscache-reset.patch + KoncludeReasoner.cpp):** Call
`resetOntologyData()` in `KoncludeReasoner::reset()` to clear stale BackendAssCache
entries before each new reasoning call.

### Bug 3: All-Assertion Individual Infinite Loop

**Location:** Approximated saturation path for ALIF+ expressiveness,
`CTotallyPrecomputationThread`

**Cause:** The ALIF+ saturation creates a synthetic "all-assertion individual" node
to model universal property constraints. In WASM, processing this node's FP role
assertions causes a self-referential saturation job submission that loops infinitely
(the job keeps adding the same node back to the work queue).

**Fix (patches/036-alif-plus-allassertion-role-skip.patch):** Skip the all-assertion
individual's saturation job submission in WASM; the universal constraint is already
encoded in the TBox saturation.

## Result

After all three fixes:
- Fixture A (FP 1-filler): completes in WASM
- Fixture C (IFP 1-subject): completes in WASM
- Fixture B (FP 2-fillers): still hangs (native Konclude v0.7.0 upstream bug) — skipped
- Fixture D (IFP 2-subjects): still hangs (native Konclude v0.7.0 upstream bug) — skipped
- Full test suite: 324 passing, 2 skipped

## Patches Applied

- `patches/034-precomp-counter-reset.patch`
- `patches/035-backendasscache-reset.patch`
- `patches/036-alif-plus-allassertion-role-skip.patch`

## Relation to Plan-042

Plan-042 (BackendAssCache isolation + FP/IFP C++ migration) can now proceed:
- The FP/IFP WASM hang is fixed for 1-filler cases
- The JS FP/IFP workaround strip can be removed (plan-042)
- C++ sameAs inference can be added for the 1-filler case (plan-042)
- The 2-filler case remains as a confirmed upstream Konclude limitation (skip)
