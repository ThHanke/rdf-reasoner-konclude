---
status: completed
created: 2026-05-15
completed: 2026-05-18
---

# Fix Port Operation Correctness — Iterative Loop

## Problem Frame

Native Konclude exposes four operations: consistency, classification (TBox), realization (ABox), and satisfiability. The WASM port (`classify()`, `checkConsistency()`) was built against these but several correctness gaps exist. This plan defines a systematic loop — one phase per operation — where each phase ends with a green test suite and a commit, establishing clean ground before moving to the next.

**Memory audit note:** Several memory entries may be outdated. Key ones to verify at Phase 0:
- `project_reasoner_inference_deps.md` — "equiv not emitted" is likely stale; code at `KoncludeReasoner.cpp:830-847` already emits equivalentClass. "7 missing *OfRobert" may still be live.
- `project_abox_realization_gap.md` — "ABox never extracted" is likely stale; code at `KoncludeReasoner.cpp:1075-1258` extracts rdf:type and role assertions. Verify with tests.

## Ground Truth

Source: `docs/native-logs/roberts-*-verbose.log` (roberts-family fixture, 63 classes, 84 obj props, 405 individuals). See `memory/project_native_operation_mechanisms.md`.

| Operation | TBox saturation | KPSet class | KPSet role | Realizer |
|-----------|----------------|-------------|------------|---------|
| Consistency | 0 concepts | No | No | No |
| Classification | 130 concepts | 62 sat-tests | No | No |
| Realization | 130 concepts | 62+81 tests | Yes | 1752ms |
| Satisfiability | 0 concepts | No | No | No |

Known correct inferences (from native log, roberts-family):
- `AuntOfRobert ⊑ Aunt` (hasValue + sisterOf + isParentOf chain)
- `FemaleAncestor ⊑ Woman`
- `GreatAuntOfRobert ⊑ GreatAunt`, `CousinOfRobert ⊑ Cousin`, etc. (7 `*OfRobert` nominal classes)
- Equivalences: native classifies 86/91 subsumers; some classes have `equivalentClass` pairs

## Scope Boundary

**In**: consistency + classification + realization output correctness on roberts-family fixture.
**Out**: satisfiability query API (not yet exposed), property hierarchy (`rdfs:subPropertyOf`) output, data property assertions, owl:sameAs, incremental reasoning.
**Out**: browser-environment tests, performance optimization.

---

## Loop Structure

Each phase: **Baseline → Add tests → Run → Fix → Commit**.

Only fix what the tests catch. No speculative refactoring.

---

## Phase 0 — Baseline Audit (not committed separately)

**Goal**: know current pass/fail state before writing any new tests.

Steps:
1. Run `npm test` — capture which tests pass/fail.
2. Compare `roberts-family.test.ts` results against native log: does `AuntOfRobert ⊑ Aunt` pass?
3. Check `abox-realization.test.ts` and `roberts-minimal-realization.test.ts` — do they pass?
4. Update or delete stale memory entries once verified.

No commit. Output: a list of currently failing assertions.

---

## Phase 1 — Consistency

**Native behavior**: `checkConsistency()` runs preprocessing + BackendAssCache 2-phase + OPSCONSISTENCY. No KPSet. Result: `isOntologyConsistent()`.

**WASM port**: `isConsistent()` reads `CConsistence::isOntologyConsistent()`, populated by `prepareOntology()` via `checkConsistency()` call path in `ts/worker.ts`.

**Tests to add** — file: `tests/integration/consistency.test.ts` (existing file, add to it):

| # | Input | Expected |
|---|-------|----------|
| 1 | `inconsistent.nt` fixture | `false` |
| 2 | Simple subClassOf chain (no contradictions) | `true` |
| 3 | Empty ontology | `true` |
| 4 | Roberts-family (complex OWL-DL, consistent) | `true` |

Tests 1-3 already exist. Add test 4 (roberts-family consistency check).

**Acceptance**: all 4 tests green.

**Commit message**: `test(consistency): add roberts-family consistency baseline`

---

## Phase 2 — TBox Classification

**Native behavior**: 130 TBox concepts saturated → KPSet (62 sat-tests, 42 calculated, 86/91 subsumers) → taxonomy with subClassOf + equivalentClass.

**Known correct inferences** (must be present in WASM output):
- `AuntOfRobert ⊑ Aunt`
- `GreatAuntOfRobert ⊑ GreatAunt`
- `CousinOfRobert ⊑ Cousin`
- `FemaleAncestor ⊑ Woman`
- `FemaleAncestor ⊑ Ancestor` (via intersection)
- Equivalences: if native produces any `equivalentClass` pairs for this ontology, verify at least one

**Tests to add** — file: `tests/integration/roberts-family.test.ts` (existing file, add to it):

| # | Assertion | Why |
|---|-----------|-----|
| 5 | `AuntOfRobert ⊑ Aunt` | hasValue+subrole chain (historically broken) |
| 6 | `GreatAuntOfRobert ⊑ GreatAunt` | same pattern |
| 7 | `CousinOfRobert ⊑ Cousin` | nominal class chain |
| 8 | Output has ≥ N subClassOf triples (N from native count) | regression guard on triple count |

Tests 3-4 from existing file already cover `AuntOfRobert ⊑ Aunt` and `FemaleAncestor ⊑ Woman`. Verify they still pass; add the others.

**If tests fail**: The known root cause is `WasmConfigProvider` disabling `SaturationSubsumerExtraction` (forces KPSet). If KPSet sat-tests diverge from native (62), trace via `{dbg}` stderr output. Check `COntologyProcessingStepData::OPSCLASSCLASSIFY` flag in `classify()` return value.

**Acceptance**: all assertions green; `mImpl->mClassified == true` verified via `classify()` return value in test.

**Commit message**: `test(classification): add roberts-family TBox correctness assertions`

---

## Phase 3 — ABox Realization

**Native behavior**: KPSet role classifier (81 sat-tests) + Realizer thread (concept 1752ms, role assertions). Output: rdf:type per individual + object property assertions.

**Known correct inferences** (roberts-family, 405 individuals):
- Every individual typed as at least `owl:NamedIndividual` (implicitly) and their direct class
- Family relationship role assertions (hasMother, hasFather, etc.) echoed back
- `john_william_folland rdf:type Person` (directly asserted, echoed back)
- `robert_david_bright_1965` appears as subject or object of role assertions

**Tests to add** — file: `tests/integration/roberts-family.test.ts`:

| # | Assertion | Why |
|---|-----------|-----|
| 9 | `john_william_folland rdf:type Person` in output | direct type echoed back |
| 10 | At least one role assertion present (subject = any individual, predicate = family property) | role realization ran |
| 11 | `mImpl->mRealized == true` (check via classify() and query inferred.some(q => q.predicate.value === RDF_TYPE)) | realization stage completed |
| 12 | No crash on second sequential call (same reasoner, new ontology) | STPU reset stability |

For test 12: call `classify()` twice on the same `RdfReasoner` instance, second call on a different ontology. Both must return valid quads. (Tests the 958db93 fix regression.)

**If tests fail**: Check `mImpl->mRealized` flag. Trace `stopAndClearRealizers()` call in `Impl::reset()`. Verify `OPSCONCEPTREALIZE` step data is `PSCOMPLETELYYPROCESSED` after `prepareOntology()`.

**Acceptance**: all assertions green; second sequential call stable.

**Commit message**: `test(realization): add roberts-family ABox + sequential stability assertions`

---

## Phase 4 — Fix Any Failing Tests

After Phases 1-3 establish the full test baseline:

1. Run full suite: `npm test`
2. For each failure, trace root cause using `{dbg}` stderr logs in the WASM binary
3. Fix in `src/KoncludeReasoner.cpp` or `src/compat/overrides/` as appropriate
4. Re-run tests after each fix
5. Commit each logical fix separately

**Known candidates** (verify at Phase 0 if still broken):
- hasValue+subrole subsumption (`*OfRobert` classes) — may require checking `WasmConfigProvider` config flags
- Sequential call stability — see fix below

**Known crash — abox-realization tests 2-4 timeout (root cause identified 2026-05-16)**:

Crash site: `COptimizedRepresentativeKPSetOntologyRealizingThread.cpp` lines 4535-4537.  
A late `CRealizingCalculatedCallbackEvent` (already dequeued before `shouldStop`) processes after `callbackData` is freed, reading a garbage `CCallbackData*` from freed heap → vtable crash → thread dies → next `prepareOntology()` deadlocks.

**Fix** (3 parts, do in order):

1. **Patch `COntologyRealizingDynamicRequirmentCallbackData.h`** — change `CCallbackData* mCallback` to `std::atomic<CCallbackData*> mCallback`; add `#include <atomic>`; declare `CCallbackData* takeCallback()`.

2. **Create `src/compat/overrides/COntologyRealizingDynamicRequirmentCallbackData.cpp`** — implement `takeCallback()` as `return mCallback.exchange(nullptr, std::memory_order_acq_rel)`. Add CMakeLists.txt exclusion for vendor original `.cpp`.

3. **Patch `COptimizedRepresentativeKPSetOntologyRealizingThread.cpp` lines 4535-4537** — change to:
   ```cpp
   CCallbackData* callback = callbackData->takeCallback();
   if (callback) callback->doCallback();
   delete callbackData;
   ```

**Note**: patch 011 (atomic exchange on `CRequirementProcessedCallbackEvent::recThread`) targets the wrong object — harmless but does not fix this crash. Keep it.

**Commit message per fix**: e.g. `fix(realization): prevent UAF in late CRealizingCalculatedCallbackEvent`, `fix(classification): resolve hasValue+subrole chain subsumption`

---

## Phase 5 — Clean Commit

After all tests green:

1. Delete unused test files (already done: `multi-call-stability.test.ts`)
2. Delete stale plan docs (already done)
3. Verify `npm test` clean
4. Final commit: `chore: clean test suite baseline after operation correctness loop`

---

## Files Touched

| File | Change |
|------|--------|
| `tests/integration/roberts-family.test.ts` | Add TBox + ABox + sequential stability tests |
| `tests/integration/consistency.test.ts` | Add roberts-family consistency test |
| `src/KoncludeReasoner.cpp` | Fix any correctness bugs found |
| `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` | If STPU reset still broken |

## Risk

- Roberts-family realization takes ~1787ms native; WASM may be slower. Set test timeout ≥ 60s.
- `*OfRobert` nominal classes depend on BackendAssCache being fully populated before KPSet runs. If BackendAssCache "0 remaining" never logged in WASM stderr, trace `WasmReasonerManagerThread::threadStopped()` cache join logic.
- Memory entries `project_reasoner_inference_deps.md` and `project_abox_realization_gap.md` describe state that may already be fixed — verify at Phase 0 before acting on them.
