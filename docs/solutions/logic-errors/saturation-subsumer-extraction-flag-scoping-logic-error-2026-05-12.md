---
title: SaturationSubsumerExtraction flag silently disables SubClass classifier ordering
date: 2026-05-12
category: logic-errors
module: wasm-reasoner-config
problem_type: logic_error
component: classifier
symptoms:
  - LUBM AssistantProfessor reports subClassOf Employee instead of Professor
  - Wrong taxonomy parents in WASM output vs native Konclude
  - Reasoner produces fewer inferred triples than expected (44 vs 46 in LUBM)
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [classifier, saturation, subsumption, lubm, wasm-config, ordering]
---

# SaturationSubsumerExtraction flag silently disables SubClass classifier ordering

## Problem

Setting `Konclude.Calculation.Classification.SaturationSubsumerExtraction=false` in the WASM config (required to prevent Roberts Family regressions) unintentionally disabled the saturation-based ordering path in `COptimizedSubClassSubsumptionClassifierThread`, causing incorrect taxonomy parents. LUBM `AssistantProfessor subClassOf Employee` instead of the correct `AssistantProfessor subClassOf Professor`.

## Symptoms

- LUBM WASM output: `AssistantProfessor subClassOf Employee` (wrong parent)
- WASM output contained 46 triples vs native Konclude's 44 (two spurious inferences)
- Diff between WASM and native showed wrong ancestry chain for `AssistantProfessor`
- Roberts and Galen ontologies unaffected — only LUBM triggered the wrong path

## What Didn't Work

- **insertMulti investigation** (session history): Early hypothesis that `QHash::insertMulti` vs `unordered_map` single-insert semantics caused lost subsumptions. Ruled out — `insertMulti` was not called on the critical path.
- **KPSet classifier investigation**: Suspected `COptimizedKPSetClassSubsumptionClassifierThread` was responsible. Wrong — LUBM uses `COptimizedSubClassSubsumptionClassifierThread` (deterministic ontology). (session history)
- **Idle semaphore / thread ordering approach**: Investigated whether cooperative single-thread dispatch could replace pthreads and incidentally fix ordering. Abandoned — KPSet deadlock is structural, cannot be fixed cooperatively. (session history)
- **Saturation node content inspection**: Confirmed AssistantProfessor's saturation node ends at Employee (correct by design — substitute chain optimization). This was not the bug; the bug was in how the classifier consumed this data.

## Solution

In `vendor/konclude/Source/Reasoner/Classifier/COptimizedSubClassSubsumptionClassifierThread.cpp`, the condition guarding saturation-based ordering incorrectly required both saturation data AND the `subsumerSaturationExtraction` config flag:

```cpp
// Before (wrong): flag guard disables ordering when SaturationSubsumerExtraction=false
if (saturationData && subsumerSaturationExtraction) {
    createObviousSubsumptionSatisfiableTestingOrderFromSaturationData(...);
} else {
    createObviousSubsumptionSatisfiableTestingOrderFromBuildData(...);
}

// After (correct): ordering uses saturation data regardless of extraction flag
if (saturationData) {
    createObviousSubsumptionSatisfiableTestingOrderFromSaturationData(...);
} else {
    createObviousSubsumptionSatisfiableTestingOrderFromBuildData(...);
}
```

The fix is in `patches/001-all-wasm-changes.patch` (applied at CMake configure time).

## Why This Works

`SaturationSubsumerExtraction` has two separate effects in the original code:

1. **Factory selection**: Which classifier is instantiated for a given ontology
2. **SubClass classifier internal ordering**: Whether `createObviousSubsumptionSatisfiableTestingOrderFromSaturationData` or `createObviousSubsumptionSatisfiableTestingOrderFromBuildData` is called

Effect (2) was unintended coupling. The saturation-based ordering path calls `CPrecomputedSaturationSubsumerExtractor::extractSubsumers`, which walks the substitute chain to find intermediate subsumers (AssistantProfessor → Professor → Faculty → Employee). Without this, the fallback `BuildData` path falls through to full tableau, whose saturation cache contains only the terminal node's content ({Employee, Person, Thing}) — missing the intermediate concepts Professor and Faculty.

Setting `SaturationSubsumerExtraction=false` was required to prevent Roberts from using the saturation-only classifier (which misses hasValue+subrole subsumptions). The fix decouples the two effects: ordering always uses saturation data when available; only factory selection respects the flag.

## Prevention

- **Config flags with dual effects**: When a Konclude config flag appears in both factory/selection logic AND internal algorithm logic, verify that WASM overrides of one effect don't silently disable the other. Document both effects in `WasmConfigProvider`.
- **Cross-ontology regression tests**: After any classifier config change, run all three fixture ontologies (LUBM, Galen, Roberts). They exercise different classifier paths and catch different classes of regressions.
- **Fixture comparison**: The `tests/fixtures/*-wasm-out.nt` files are the ground truth. Diffs vs native output expose taxonomy errors that smoke tests may miss.
- **Patch audit on flag changes**: When `SaturationSubsumerExtraction` or similar flags are changed in `WasmConfigProvider`, grep the SubClass and KPSet classifier source for uses of the same flag variable to check for unexpected coupling.

## Related Issues

- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md` — why `SaturationSubsumerExtraction=false` was introduced (Roberts/KPSet deadlock fix)
- `docs/plans/2026-05-06-002-fix-feat-wasm-correctness-pthreads-plan.md` — correctness plan; LUBM wrong-parent bug was a second issue beyond what the plan originally described
