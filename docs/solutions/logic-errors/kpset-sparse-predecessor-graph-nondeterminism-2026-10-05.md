---
module: classifier
tags: [kpset, nondeterminism, ordering, saturation, roberts-family]
problem_type: logic-error
date: 2026-10-05
status: resolved
patches: [008, 009, 012, 017, 018]
---

# KPSet Sparse Predecessor Graph — Nondeterministic subClassOf Counts

## Problem

PMDco ontology gave nondeterministic `rdfs:subClassOf` edge counts across WASM runs: 145–158 edges (correct native answer: 138). Over-inference AND variance per run.

## Root Cause

`SatExtraction=false` (Roberts-family fix in `src/KoncludeReasoner.cpp:270-283`) forces `createObviousSubsumptionSatisfiableTestingOrderFromBuildData()` for all classification. This function builds the KPSet test predecessor graph from ASSERTED axioms only.

**Structural problem**: asserted axioms capture only direct `SubClassOf` declarations — not transitive/inferred superclasses. The predecessor graph is sparse. Most concepts have no known predecessors and land in `nextItemList` simultaneously. Which concept gets tested first becomes a race determined by thread scheduling → wrong results when a subclass is tested before its superclass.

Native Konclude avoids this via `SatExtraction=true`: saturation provides rich transitive subsumer sets → near-complete predecessor graph → correct topological ordering.

## Fix (patch 018)

Restructured `createObviousSubsumptionSatisfiableTestingOrderFromBuildData()` into two passes:

**PASS 1** — create all test items and register ref-linking for every concept. Required before PASS 2 because `tellConceptSupsumption()` (called by `extractSubsumers`) looks up `classifierReferenceLinkingData` for each subsumer; all must be registered first.

**PASS 2** — for each concept, call `precSatSubsumerExtractor->extractSubsumers()` to populate `getSubsumingConceptItemList()` with the full transitive predecessor set from saturation. Wire `addSuccessorSatisfiableTestItem` + `incUnprocessedPredecessorItems` from that list. Falls back to `getSubsumerSetFromBuildData()` when `getConceptFlags()` returns false.

**Roberts-family fix preserved**: `ResultSatisfiableDerivated` is NEVER set. Full KPSet tableau always runs for every concept. `extractSubsumers()` only calls `tellConceptSupsumption()` → `addSubsumingConceptItem()` (populates list, no result flags).

## Results

| Metric | Before | After |
|---|---|---|
| WASM counts (5 runs) | 145, 158, 151, 156, 145 | 136, 136, 136, 136, 136 |
| Unstable edges | 27 | 0 |
| Extra edges | up to 28 | 0 |
| Missing vs native | 0 | 2 |
| Test suite | 565/565 | 565/565 |

## Remaining gap (2 missing edges)

`PMD_0020243 → PMD_0023003` and `PMD_0080022 → PMD_0023003` are always missing. Both require complex reasoning (owl:intersectionOf + owl:someValuesFrom). Saturation computes them as DEFINITIVE subsumptions → no `TELLCLASSINITIALIZEPOSSIBLESUBSUM` generated → KPSet never tests those pairs → subsumptions lost.

Possible fix: targeted re-enable of saturation extraction for concepts where saturation reports complete (`!incompleteProcessedFlag && !insufficientFlag && !possibleSubsumerFlag`). Requires verifying Roberts-family affected concepts don't hit that condition.

## Supporting patches

- **008**: Hasse sort tie-breaker (stable_sort + concept-tag — needed for deterministic Hasse output)
- **009**: Scheduler sort tie-breakers + `getTestingConcept()` const fix (required for emcc 3.1.73+)
- **012**: TELL_INIT buffering+sort — buffers `TELLCLASSINITIALIZEPOSSIBLESUBSUM` during saturation pthread completion, flushes sorted by concept tag at phase transition
- **017**: CBOXSET sort in FromBuildData outer loop — superseded by patch 018 PASS 1 (may be removable)

## Key code locations

- `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
  - `createObviousSubsumptionSatisfiableTestingOrderFromBuildData()` — patched (018)
  - `createNextSubsumtionTest()` — scheduler tiers (patched by 009)
- `vendor/konclude/Source/Reasoner/Classifier/CPrecomputedSaturationSubsumerExtractor.cpp`
  - `extractSubsumers()` — called in PASS 2; only calls `tellConceptSupsumption`, no result flags
- `src/KoncludeReasoner.cpp:270-283` — Roberts-family fix (`SatExtraction=false`)
