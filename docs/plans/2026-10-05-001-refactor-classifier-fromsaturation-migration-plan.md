---
title: "refactor: Migrate WASM classifier to KPSet + FromSaturationData path"
type: refactor
status: active
date: 2026-10-05
---

# refactor: Migrate WASM classifier to KPSet + FromSaturationData path

## Overview

The WASM build currently forces all ontologies through KPSet + `FromBuildData` via two artificial config overrides. Native Konclude uses KPSet + `FromSaturationData` for ontologies with saturation data — a richer path that correctly produces 138 PMDco subClassOf edges (WASM produces 136). This plan migrates the WASM classifier to the native code path in three ordered steps, each independently verifiable.

## Problem Frame

Two subClassOf edges are always missing from PMDco output:
- `PMD_0020243 → PMD_0023003`
- `PMD_0080022 → PMD_0023003`

Root cause: WASM forces `KPSet + FromBuildData` via `SaturationSubsumerExtraction=false`. `FromBuildData` lacks the selective saturation extraction logic (`ResultSatisfiableDerivated=true`) that `FromSaturationData` applies to complete concepts — making KPSet skip the tableau for those concepts and extract subsumers directly from saturation, which finds the 2 missing pairs.

Native Konclude for PMDco uses `KPSet + FromSaturationData` (PMDco fails the "sufficiently saturated" check in `CConfigDependedSubsumptionClassifierFactory`). When WASM sets `SaturationSubsumerExtraction=true`, PMDco passes the sufficiency check and routes to `OptimizedClassExtracted` instead — which also misses the 2 edges AND breaks unsat detection and justifications (9 test failures observed 2026-10-05).

The correct WASM target: all ontologies → `KPSet + FromSaturationData`. This requires:
1. Disabling `OptimizedClassExtracted` via `AutomatedOptimizedClassifierSelection=false`
2. Removing the `SaturationSubsumerExtraction=false` override → KPSet uses `FromSaturationData`

## Requirements Trace

- R1. ~~PMDco produces 138 subClassOf edges matching native Konclude~~ **INVALIDATED**: the 2 "missing" edges (PMD_0020243→PMD_0023003, PMD_0080022→PMD_0023003) are explicitly asserted in the ontology. WASM outputs inferred-only → 136 is correct. Native outputs full taxonomy (asserted + inferred) → 138. Gap is by design.
- R2. Full test suite remains at 565/565 (or better) after each step
- R3. Unsat detection (isSatisfiable, getUnsatisfiableClasses, validate warnings) works correctly
- R4. Justification coverage: every inferred triple that was justified before migration remains justified after
- R5. Roberts-family subsumptions (ForefatherOfRobert ⊑ AncestorOfRobert etc.) remain correct
- R6. Results are deterministic across multiple runs

## Scope Boundaries

- Steps execute in order; do not start Step 2 until Step 1 passes 565/565
- Do NOT port `FromSaturationData` selective re-enable into `FromBuildData` — that path is being retired
- Do NOT discuss or modify `patches/ENABLED` without prior discussion

### Deferred to Separate Tasks

- Browser pthread deadlock (`PROXY_TO_PTHREAD`): separate issue, not touched here
- `FromBuildData` code removal after migration is confirmed stable: post-Step 3 cleanup
- Async cache CThreads audit: pre-existing deferred item

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` — `WasmConfigProvider` constructor: config overrides, lines ~269–318
- `vendor/konclude/Source/Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.cpp` — `createClassifier()` and `isClassificationBySaturationCalculationSufficient()` (lines 39–107): controls which classifier thread is instantiated
- `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`:
  - `createObviousSubsumptionSatisfiableTestingOrder()` line ~187: dispatches to `FromSaturationData` vs `FromBuildData`
  - `FromSaturationData` lines ~203–388: selective re-enable at lines ~348–351 (`ResultSatisfiableDerivated=true` for complete concepts)
  - `createNextSubsumtionTest()` line ~1308: short-circuits tableau when `ResultSatisfiableDerivated=true`
- `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` — lines ~1658, ~1731: populates `JustificationCache` from KPSet tableau dep-chain during tableau runs
- `src/JustificationCache.h` — thread-safe singleton cache, key = `(subTag, superTag, EntailmentType)`, value = dep-tag vector
- `src/KoncludeReasoner.cpp:614–695` — `getSubClassJustification()`: looks up `JustificationCache` then falls back to BFS; returns bare subsumption triple when entry exists
- `vendor/konclude/Source/Reasoner/Classifier/CPrecomputedSaturationSubsumerExtractor.cpp` — `extractSubsumers()`: called in `FromSaturationData` and `FromBuildData` PASS 2; only calls `tellConceptSupsumption()`, no dep-chain data surfaced to callers
- Tests:
  - `tests/integration/hierarchy-determinism.test.ts` — PMDco determinism + count (asserts stability, not specific count)
  - `tests/integration/diff-diagnostic.test.ts` — 5-instance edge count check
  - `tests/integration/justification-matrix.test.ts` — every inferred triple must have justification
  - `tests/integration/owl-dl-capabilities.test.ts` — isSatisfiable + getUnsatisfiableClasses
  - `tests/integration/consistency.test.ts` — validate warnings for unsatisfiable classes
  - `tests/integration/probe-unsat-native.test.ts` — unsat justification
  - `tests/integration/entailment-coverage.test.ts` — roberts-family subsumptions

### Institutional Learnings

- `docs/solutions/logic-errors/kpset-sparse-predecessor-graph-nondeterminism-2026-10-05.md` — full root cause of the 2 missing edges and why `FromBuildData` can't solve them without `ResultSatisfiableDerivated`
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md` — original reason `SaturationSubsumerExtraction=false` was added
- Memory: [[classification-path-migration-plan]] — architectural analysis session 2026-10-05

### Key Classifier Dispatch (reference)

```
CConfigDependedSubsumptionClassifierFactory::createClassifier():
  if AutomatedOptimizedClassifierSelection=true (default):
    if isClassificationBySaturationCalculationSufficient():
      → OptimizedClassExtractedSaturationSubsumptionClassifierThread  ← broken for WASM
    else:
      → KPSet (default)
  KPSet → createObviousSubsumptionSatisfiableTestingOrder():
    if saturationData AND SaturationSubsumerExtraction=true:
      → FromSaturationData  ← native PMDco path, 138 edges
    else:
      → FromBuildData  ← current WASM path, 136 edges
```

## Key Technical Decisions

- **`AutomatedOptimizedClassifierSelection=false` over patching the factory**: avoids vendor C++ patch, keeps the change in `src/KoncludeReasoner.cpp` alongside other WASM-specific config overrides. Cleaner rollback.
- **Step-by-step verification before proceeding**: each step requires a full test run to 565/565 before the next step begins. Avoids accumulating unknown regressions.
- **Justification for saturation-derived subsumptions via taxonomy fallback (Step 2 design TBD)**: when `ResultSatisfiableDerivated=true`, no KPSet tableau runs → no dep-chain → `JustificationCache` has no entry. `getSubClassJustification()` must still return a non-empty result. Exact approach (synthesize entry from saturation dep chain vs. taxonomy BFS fallback) is an implementation-time decision.
- **Nondeterminism audit last (Step 3)**: `FromSaturationData` ordering under `unordered_map` is unknown. Cannot fully scope until Step 1+2 show which ordering constructs are exercised.

## Open Questions

### Resolved During Planning

- **Why does PMDco pass sufficiency check in WASM but fail in native?** WASM saturation is more complete: `!isInsufficientNodeOccured() && !isProblematicEQCandidateOccured()` AND `eqConceptNonCandSet` is empty. Native PMDco fails at least one. `AutomatedOptimizedClassifierSelection=false` sidesteps this difference entirely.
- **Do Roberts-family subsumptions survive `FromSaturationData`?** Tested 2026-10-05 with `SaturationSubsumerExtraction=true` — all Roberts subsumption tests passed. `FromSaturationData` runs full KPSet tableau for concepts without complete saturation results (i.e. those without `ResultSatisfiableDerivated=true`), so role-chain subsumptions still get discovered.
- **Unsat detection broken with `OptimizedClassExtracted` — will it work with `FromSaturationData`?** `OptimizedClassExtracted` skips KPSet entirely → no satisfiability tests → unsatisfiable classes not detected. `FromSaturationData` only short-circuits "complete" concepts; unsatisfiable concepts likely have `insufficientFlag=true` or `possibleSubsumerFlag=true` and are NOT given `ResultSatisfiableDerivated=true` → KPSet tableau still runs for them → unsat detection should work. Confirmed by Step 1 test run.

### Deferred to Implementation

- **Which PMDco concepts get `ResultSatisfiableDerivated=true` in `FromSaturationData`?** Runtime discovery after Step 1 WASM build — add log output in `FromSaturationData` lines 348–351.
- **Exact justification strategy for `ResultSatisfiableDerivated=true` concepts**: depends on what saturation dep-chain data is accessible from `CPrecomputedSaturationSubsumerExtractor` at the point where subsumptions are recorded. Scope after Step 1.
- **Whether patch 008 TELL_INIT buffering / Hasse sort are still needed under `FromSaturationData`**: assess after Step 1 determinism run. `FromSaturationData` does not use the two-pass `FromBuildData` logic, but global KPSet fixes (Hasse sort, TELL_INIT) still apply.
- **Whether `FromBuildData`-specific two-pass portion of patch 008 becomes dead code**: only after migration is confirmed stable across all three steps.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
Step 1 — Config only (src/KoncludeReasoner.cpp):
  WasmConfigProvider adds:  AutomatedOptimizedClassifierSelection = false
  WasmConfigProvider removes: SaturationSubsumerExtraction = false

  Result for all ontologies:
    factory → !automatedClassifierSelection → KPSet
    KPSet   → saturationData && SatExtr=true → FromSaturationData
    FromSaturationData: concepts with complete saturation → ResultSatisfiableDerivated=true
                        others (including unsat) → full tableau

Step 2 — Justification tracing (src/ layer only, no WASM rebuild if possible):
  When ResultSatisfiableDerivated=true, JustificationCache has no entry for that pair.
  Two candidate approaches (choose at implementation time):
    A. Synthesize JustificationCache entry from saturation dep-chain data at the point
       FromSaturationData marks the concept (lines 348–351) — requires dep-chain access
       from CPrecomputedSaturationSubsumerExtractor.
    B. Taxonomy fallback: getSubClassJustification() BFS through taxonomy for pairs
       with no JustificationCache entry — returns direct triple edge as justification.
       Simpler but less informative.

Step 3 — Nondeterminism (vendor patch if needed):
  Run 5× PMDco, compare edge sets.
  If unstable: add sort tie-breakers to FromSaturationData iteration (analogous to
  patch 008 CBOXSET sort in FromBuildData, but for FromSaturationData's concept lists).
```

## Implementation Units

- [x] **Unit 1: Config changes in WasmConfigProvider → KPSet + FromSaturationData**

**Goal:** Route all WASM ontologies to `KPSet + FromSaturationData` by removing the `SaturationSubsumerExtraction=false` override and adding `AutomatedOptimizedClassifierSelection=false`.

**Requirements:** R1, R2, R3, R5

**Dependencies:** None — first step

**Files:**
- Modify: `src/KoncludeReasoner.cpp`

**Approach:**
- In `WasmConfigProvider` constructor: remove the entire `SaturationSubsumerExtraction` config block (lines ~305–314 in current HEAD)
- Add a new config block for `Konclude.Calculation.Classification.AutomatedOptimizedClassifierSelection` set to `false`
- Update the comment above the removed block to document the new intent
- Full WASM rebuild required (`make reset-patches && make build-wasm`), then `npm run patch-wasm && npm run build`

**Test scenarios:**
- Happy path: PMDco classify() produces 138 subClassOf edges (check via `diff-diagnostic.test.ts` stdout or standalone script)
- Happy path: Full test suite 565/565 pass (`npx vitest run` → save to file → tail for summary)
- Happy path: Roberts-family ForefatherOfRobert ⊑ AncestorOfRobert still entailed (`entailment-coverage.test.ts`)
- Happy path: `isSatisfiable(EmptyClass)` returns false (`owl-dl-capabilities.test.ts`)
- Happy path: `getUnsatisfiableClasses()` returns EmptyClass (`owl-dl-capabilities.test.ts`)
- Happy path: `validate()` returns EmptyClass in warnings (`consistency.test.ts`)
- Error path: unsat class dep-chain justification still found (`probe-unsat-native.test.ts`)
- Integration: WASM log must NOT contain "sufficiently saturated" — confirms OptimizedClassExtracted not used

**Verification:**
- `Tests N failed` line shows 0 failures
- PMDco edge count stdout shows 138
- "sufficiently saturated" absent from WASM log output during any classify() call

---

- [x] **Unit 2: Justification coverage for saturation-derived subsumptions**

**Goal:** Ensure every subsumption derived via `ResultSatisfiableDerivated=true` (concepts that bypass KPSet tableau in `FromSaturationData`) has a non-empty justification returned by `explainEntailment()`.

**Requirements:** R4

**Dependencies:** Unit 1 must pass 565/565

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (likely `getSubClassJustification()` or the `FromSaturationData` hook path)
- Possibly modify: `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` (if dep-chain synthesis approach is chosen)
- Possibly modify: `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp` (if a hook at lines 348–351 is chosen — requires vendor patch via `scripts/new-multi-file-patch.sh`)
- Test: `tests/integration/justification-matrix.test.ts`

**Approach:**
- First, run Step 1 suite and identify exactly which tests fail in `justification-matrix.test.ts` and which triples are "entailed but missing justification"
- Determine which concepts get `ResultSatisfiableDerivated=true` for roberts-family and class-collections ontologies
- Evaluate two approaches:
  - **Approach A (preferred if feasible):** At the point `FromSaturationData` sets `ResultSatisfiableDerivated=true` (lines ~348–351), hook into saturation dep-chain data to synthesize a `JustificationCache` entry with the relevant concept tags. Requires understanding what `CPrecomputedSaturationSubsumerExtractor` exposes.
  - **Approach B (fallback):** In `getSubClassJustification()`, when `JustificationCache` has no entry for a pair that IS in the taxonomy, return the direct subsumption triple as a minimal justification (the axiom is self-evidencing from the taxonomy). This requires no C++ patch.
- Approach B can be implemented purely in `src/KoncludeReasoner.cpp` without a WASM rebuild if the taxonomy BFS already covers these cases — check after Step 1

**Test scenarios:**
- Happy path: `justification-matrix > roberts-family` — every inferred triple has justification.length ≥ 1
- Happy path: `justification-matrix > class-collections` — every inferred triple has justification.length ≥ 1
- Happy path: `explainEntailment(PMD_0020243, subClassOf, PMD_0023003)` returns non-empty justification (new direct test if fixture available)
- Edge case: subsumption triple that WAS in JustificationCache before migration still returns correct justification
- Integration: justification axioms reference real axioms from the ontology (not empty or synthetic stubs)

**Verification:**
- `justification-matrix.test.ts` all pass
- Full suite still 565/565

---

- [x] **Unit 3: Nondeterminism audit for FromSaturationData path**

**Goal:** Confirm that `KPSet + FromSaturationData` produces identical subClassOf edge sets across 5 successive runs and across 3 independent WASM instances.

**Requirements:** R6

**Dependencies:** Units 1 and 2 must pass 565/565

**Files:**
- Possibly modify: `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp` (if sort tie-breakers needed in `FromSaturationData` — via `scripts/new-multi-file-patch.sh`)
- Possibly update: `patches/ENABLED` (only after discussion)
- Test: `tests/integration/hierarchy-determinism.test.ts`
- Test: `tests/integration/diff-diagnostic.test.ts`

**Approach:**
- Run `hierarchy-determinism.test.ts` and `diff-diagnostic.test.ts` five times independently after Unit 2 is stable
- If edge counts or sets differ across runs: trace which part of `FromSaturationData` iterates in non-deterministic order
  - Primary candidates: `QList<COptimizedKPSetClassTestingItem*>` populated by `extractSubsumers()` (ordering of `getSubsumingConceptItemList()`)
  - `QSet` / `unordered_map` iteration in concept loops within `FromSaturationData`
- Apply sort tie-breakers analogous to patch 008 CBOXSET sort (concept-tag based) to any iteration that proves non-deterministic
- The `FromBuildData`-specific two-pass logic in patch 008 is not exercised under `FromSaturationData` — assess if that portion of patch 008 can be removed (defer to post-Step 3 cleanup task)

**Test scenarios:**
- Happy path: 5 sequential PMDco classify() calls produce identical edge counts (`diff-diagnostic.test.ts`)
- Happy path: 3 independent WASM instances produce identical PMDco edge counts and exact sets (`hierarchy-determinism.test.ts`)
- Happy path: Roberts-family 5× runs produce identical inferred triples
- Edge case: if any sort is added, verify it doesn't change edge count relative to Unit 1 result

**Verification:**
- `hierarchy-determinism.test.ts` passes (counts + exact sets identical)
- `diff-diagnostic.test.ts` passes (all 5 instances same count)
- Full suite 565/565

---

- [ ] **Unit 4 (conditional): Trim FromBuildData-specific patch 008 dead code**

> NOTE (2026-10-05): R1 INVALIDATED — see above. PMD_0020243→PMD_0023003 and PMD_0080022→PMD_0023003 are asserted triples, correctly absent from the inferred-only result graph. 136 = correct WASM output. Units 1–3 all pass 565/565 and determinism is verified.

**Goal:** If the two-pass `FromBuildData` portion of patch 008 is confirmed dead (never called under `FromSaturationData`), remove it to reduce patch maintenance surface.

**Requirements:** R2 (suite still passes)

**Dependencies:** Units 1, 2, 3 all passing; explicit discussion before touching `patches/ENABLED`

**Files:**
- Modify: `patches/008-kpset-ordering-determinism.patch` (regenerate without the `FromBuildData` two-pass section)
- Modify: `patches/ENABLED` (only after discussion)
- Modify: `docs/solutions/logic-errors/kpset-sparse-predecessor-graph-nondeterminism-2026-10-05.md` (update status)

**Approach:**
- Confirm `FromBuildData` is never entered during any test run (add temporary log or check WASM log output)
- Identify which sub-patches within 008 are `FromBuildData`-specific (two-pass PASS 1+2) vs. global (Hasse sort, TELL_INIT, scheduler)
- Regenerate patch 008 retaining only global fixes
- Full WASM rebuild + full test suite

**Test scenarios:**
- Happy path: Full suite 565/565 with trimmed patch 008
- Integration: PMDco still 138 edges
- Integration: determinism tests still pass (3× and 5×)

**Verification:**
- No regression in any test category
- Patch 008 is smaller and clearly scoped to global KPSet fixes only

## System-Wide Impact

- **Interaction graph:** `CConfigDependedSubsumptionClassifierFactory` is the only entry point where classifier thread type is selected. `WasmConfigProvider` is the only WASM-specific config source. Changes are self-contained to these two files plus the KPSet thread itself.
- **Error propagation:** If `FromSaturationData` encounters a concept where saturation data is incomplete/corrupt, it falls through to full KPSet tableau — same safety net as before.
- **State lifecycle risks:** `JustificationCache` is cleared at the start of each `classify()` call. Under `FromSaturationData`, concepts with `ResultSatisfiableDerivated=true` produce no JustificationCache entries on the first call — Unit 2 must address this before justification tests can pass.
- **API surface parity:** `explainEntailment()`, `validate()`, `getUnsatisfiableClasses()`, `isSatisfiable()` all depend on correct KPSet execution. `FromSaturationData` must not break any of these.
- **Unchanged invariants:** Roberts-family role-chain subsumptions (role-subproperty+hasValue patterns) must remain correctly inferred. `FromSaturationData` still runs full KPSet tableau for concepts without complete saturation results — role-chain concepts should be in that category.
- **Integration coverage:** `justification-matrix.test.ts` is the key cross-layer test — it verifies the full pipeline from WASM classification through JustificationCache through TS explanation API.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `FromSaturationData` introduces nondeterminism in `unordered_map` iteration | Step 3 explicitly audits this; sort tie-breakers applied if needed |
| Justification for `ResultSatisfiableDerivated=true` concepts requires vendor C++ patch (complex) | Approach B (taxonomy BFS fallback in `src/`) may be sufficient and avoids rebuild |
| Roberts-family role-chain subsumptions silently regress | Full entailment-coverage + justification-matrix tests catch this; Step 1 required to pass all roberts tests |
| WASM rebuild takes 20–30 min; build fails if patches don't apply cleanly | `make reset-patches` before every build; check `patches/ENABLED` carefully |
| Unit 4 accidentally removes a still-needed portion of patch 008 | Explicit discussion gate; confirm `FromBuildData` dead before modifying |

## Sources & References

- Memory: `project_classification_path_migration_plan` (architectural analysis 2026-10-05)
- `docs/solutions/logic-errors/kpset-sparse-predecessor-graph-nondeterminism-2026-10-05.md`
- Classifier factory: `vendor/konclude/Source/Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.cpp`
- KPSet thread: `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
