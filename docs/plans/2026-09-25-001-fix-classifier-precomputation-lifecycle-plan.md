---
title: "fix: Heap lifecycle patches 052-054 — classifier items, precomputation testing items, indexers"
type: fix
status: active
date: 2026-09-25
---

# fix: Heap lifecycle patches 052-054

## Overview

Three patches eliminating the remaining per-call heap leaks in the Konclude WASM kernel:
all classifier ontology items (#4–6, #12–13), precomputation testing items (#7), and
preprocessing indexers (#9). All leaks confirmed by graphify audit on 2026-09-25.
Follows the "keep while valid, free on change" paradigm established in patches 045–051.

## Problem Frame

After patches 045–051 fixed precomputation/preprocessing/realizer item leaks and the
BackendAssCache, the remaining dominant per-call leaks are:

- **Classifier items** (#4–6, #12–13): 5 concrete `CSubsumptionClassifierThread` subclasses
  each append one new `COntologyClassificationItem*` to `ontItemList` per call and insert
  into `ontItemHash`. Neither list nor hash ever evicts or deletes. Items own taxonomies,
  testing-item containers, and (for #5) a full `CConcreteOntology` clone + role hierarchy.
- **Precomputation testing items** (#7): 4 subclass types created one-shot and fired via
  `precomputationTested()`. Neither overload ever calls `delete preTestItem`.
- **Indexers** (#9): Two `CRedlandStoredTriplesIndividualAssertionConvertionIndexer` objects
  created as local variables in preprocessing; local variable goes out of scope with no delete.

## Requirements Trace

- R1. All 5 classifier `ontItemList` / `ontItemHash` accumulations are bounded: stale items
  deleted at the start of the next call, reused on cache hit.
- R2. `mTmpRoleClassificationOnt` (and transitively: temp individuals, `CRolePropertiesHierarchy`)
  is freed when the role classifier item is deleted.
- R3. Both `precomputationTested()` overloads delete `preTestItem` after processing.
- R4. Both indexer allocations in preprocessing are freed after use.
- R5. 569/570 test pass rate maintained (no regression on memory-rss-regression test).

## Scope Boundaries

- Item #8 (`CRedlandNodeProcessingData` via mapper) excluded — mapper creation site in
  preprocessing is commented out; active sites are Revision/Persistence paths not reached
  during classify(). Needs separate path-reachability verification before fixing.
- Shutdown-only leaks (`mCompConsCache`, `mBackendAssCache`, `mOccStatsCache`,
  `mAnswererManager`) excluded — not per-call accumulation.
- SPARQL-only leaks (`COptimizedComplexVariableCompositionItemVariableIndexMapping`) excluded
  — classify()/realize() never enters that path.

## Context & Research

### Relevant Code and Patterns

- **Stale-list pattern**: `scripts/mods/mod_048_precomputation_inactive_cleanup.py` and
  `scripts/mods/mod_047_realizer_leak.py` — canonical template for Step A (hash remove +
  stale push) and Step B (bulk-delete at next-call start).
- **Base thread field extension**: `patches/045-*` through `050-*` — how `mInactiveOntItemSet`
  was added to base class headers and used by subclasses.
- **Classifier thread hierarchy**: `CSubsumptionClassifierThread` is the common base; 5
  concrete subclasses each override `scheduleOntologyClassification()` and own an `ontItemHash`
  + `ontItemList`. `finishOntologyClassification()` may be inherited (e.g., #13 inherits
  from #4) — verify with graphify during implementation.
- **Mod script infrastructure**: `scripts/new-vendor-patch.py <NNN> <desc> <mod.py>` —
  fetches exact file content via `git show HEAD:path`, calls `modify(path, content)`, diffs,
  writes patch. `make reset-patches` re-applies all patches cleanly.
- **Key HANDOVER constraint**: never delete items at `finish*()` time — only at START of
  next call. Deleting in finish triggered a UAF in `buildInferredTripleBuffer()` (lessons
  from patches 045-050 first version).

### Institutional Learnings

- `feedback_konclude_item_lifecycle_paradigm.md` — "keep while valid, free on change"; delete
  at START of next call, never at finish.
- `feedback_never_patch_without_logging.md` — vitest captures LOG output automatically.
- `feedback_build_from_known_good.md` — never build HEAD with untested patches; rebuild from
  last known-good state.
- `feedback_graphify_before_saturation_patches.md` — use graphify before every patch mod
  script to verify call chains and ownership.

## Key Technical Decisions

- **One mod script for patch 052, 8 files**: all classifier changes share the same paradigm
  and are conceptually one atomic fix. A single patch keeps the change bisectable as a unit
  and simpler to manage than 6 separate patches.
- **Helper method `deleteStaleClassItems()` in base `CSubsumptionClassifierThread`**: Step B
  (bulk-delete loop) is identical across all 5 concrete threads. Adding it as a protected
  helper in the base class eliminates duplication; each concrete override calls it once at
  the top of `scheduleOntologyClassification()`.
- **`mStaleClassItems` typed as `std::vector<COntologyClassificationItem*>`**: matches the
  paradigm from patches 048-050 (`mInactiveOntItemSet`) and is safe because all concrete item
  types are subclasses of `COntologyClassificationItem`.
- **Role destructor in same patch 052**: `~COptimizedKPSetRoleOntologyClassificationItem()`
  deleting `mTmpRoleClassificationOnt` is coupled to item #5's stale-list fix; separating
  them risks a window where item is deleted but owned ontology is not freed.
- **Patch 053 requires graphify pre-check** before writing the mod script: must confirm no
  caller accesses `preTestItem` after `precomputationTested()` returns.

## Open Questions

### Resolved During Planning

- *Does #13 (`CIncrementalKPSetClassOntologyClassificationItem`) inherit `finishOntologyClassification`
  from #4?* Per graphify agent: yes, inherited from `COptimizedKPSetClassSubsumptionClassifierThread`.
  **Resolution**: Step A only needs to be added to #4's `finishOntologyClassification` — it
  covers #13 automatically. Step B must still be added to #13's own
  `scheduleOntologyClassification()` override. Verify this inheritance chain with graphify
  before writing the mod script.

### Deferred to Implementation

- Exact line numbers and surrounding context for each `finishOntologyClassification()` and
  `scheduleOntologyClassification()` override — determined by reading the patched files and
  confirmed by graphify.
- Whether graphify reveals any other caller of `preTestItem` after `precomputationTested()`
  returns (patch 053 pre-check).
- Whether the temp individuals (`tmpIndiProp`, `tmpIndiMarker`) are freed transitively when
  `mTmpRoleClassificationOnt` is deleted — verify by tracing the ontology's ABox destructor.

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
Patch 052 — Stale-list pattern, same as patches 045-050:

  scheduleOntologyClassification() [each of 5 concrete overrides]:
    deleteStaleClassItems()         ← Step B: bulk-delete at call start
    ontClassItem = new XOntologyClassificationItem(...)
    ontItemHash.insert({ont, callGen}, ontClassItem)
    ontItemList.append(ontClassItem)

  finishOntologyClassification() [each concrete override, or inherited]:
    ...existing finish logic...
    processingOntItemList.removeFirst()
    ontItemHash.remove({ontClassItem->getOntology(), callGen})  ← Step A
    mStaleClassItems.push_back(ontClassItem)                    ← Step A

  ~COptimizedKPSetRoleOntologyClassificationItem():
    delete mTmpRoleClassificationOnt    ← frees ABox, temp individuals,
                                           CRolePropertiesHierarchy transitively

Patch 053 — One-shot delete in callback:

  precomputationTested(preTestItem, ...) [both overloads]:
    ...existing processing...
    delete preTestItem    ← after all use of preTestItem is complete

Patch 054 — Immediate delete after use:

  CRequirementConfigPreprocessingThread::processX():
    triplesMapper = new CRedlandStoredTriplesIndividualAssertionConvertionIndexer()
    triplesMapper->mapXxx(...)
    delete triplesMapper    ← after use (at both call sites 208/215)
```

## Implementation Units

- [ ] **Unit 1: Graphify pre-check for patch 052 classifier ownership**

**Goal:** Confirm the inheritance chain and finishOntologyClassification override map for all
5 concrete classifier threads before writing the mod script.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Read-only investigation; no file changes

**Approach:**
- Run `graphify explain` on each of the 5 concrete thread classes
- Run `graphify path` from each concrete thread to `finishOntologyClassification` and
  `scheduleOntologyClassification` to confirm whether each is overridden or inherited
- Confirm that `mTmpRoleClassificationOnt` destruction transitively frees temp individuals
  and `CRolePropertiesHierarchy`
- Record exact method signatures and surrounding context lines for mod script patterns

**Test scenarios:**
- Test expectation: none — investigation unit, no code changes

**Verification:**
- Inheritance map is documented before mod script is written; no assumptions remain


- [ ] **Unit 2: Patch 052 mod script — all classifier item lifecycle fixes**

**Goal:** Single mod script touching 8 files implements the stale-list pattern across all 5
concrete classifier threads and fixes the role item destructor.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (graphify findings)

**Files:**
- Create: `scripts/mods/mod_052_classifier_lifecycle.py`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.h`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetRoleSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/COptimizedSubClassSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/COptimizedClassExtractedSaturationSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/CIncrementalKPSetClassSubsumptionClassifierThread.cpp`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetRoleOntologyClassificationItem.h` or `.cpp`
- Test: `tests/memory-rss-regression.test.ts`

**Approach:**
- `CSubsumptionClassifierThread.h`: add `std::vector<COntologyClassificationItem*> mStaleClassItems;`
  (protected field); add `void deleteStaleClassItems()` protected method declaration
- `CSubsumptionClassifierThread.cpp`: implement `deleteStaleClassItems()` — loop + clear
- Each of 5 concrete `.cpp` files: in `scheduleOntologyClassification()` override, call
  `deleteStaleClassItems()` before the `new` expression; in `finishOntologyClassification()`
  override (or the one override that covers multiple threads via inheritance), add
  `ontItemHash.remove(...)` + `mStaleClassItems.push_back(ontClassItem)` after
  `processingOntItemList.removeFirst()`
- Role item `.h` or `.cpp`: add `delete mTmpRoleClassificationOnt;` to destructor body
- All string matches in `modify()` must be exact (tabs, EOL) — follow `mod_047_realizer_leak.py`
  as template; use `assert old in content` guards

**Patterns to follow:**
- `scripts/mods/mod_047_realizer_leak.py` — Step A pattern (hash remove after finish)
- `scripts/mods/mod_048_precomputation_inactive_cleanup.py` — Step B pattern (bulk-delete before new)

**Test scenarios:**
- Happy path: memory-rss-regression test (3 classify calls) RSS delta call 1→2 and 2→3 both
  within existing thresholds; test passes
- Happy path: full vitest suite 569/570 pass; no new failures
- Edge case: classify called with same ontology data twice (cache hit path) — item is reused,
  not re-created; RSS stays flat on repeated identical calls
- Integration: classify → getInferredNTriples → classify cycle completes without segfault
  (verifies role destructor doesn't double-free the temp ontology)

**Verification:**
- `make reset-patches && make build-wasm` succeeds
- `npx vitest run 2>&1 > /tmp/vitest-full-output.txt; tail -30 /tmp/vitest-full-output.txt`
  shows 569/570 (or better) pass
- No segfaults or address sanitizer hits on the classify() cycle


- [ ] **Unit 3: Graphify pre-check for patch 053 — precomputationTested safety**

**Goal:** Confirm that neither `precomputationTested()` overload has any code path accessing
`preTestItem` after the callback processing block ends.

**Requirements:** R3

**Dependencies:** None (can run in parallel with Units 1-2)

**Files:**
- Read-only investigation; no file changes

**Approach:**
- `graphify path` from `CTotallyPrecomputationThread::precomputationTested` (both overloads)
  to any downstream callers that receive or store `preTestItem`
- Read the two overload bodies (L2260 and L2545 in `CTotallyPrecomputationThread.cpp`) to
  confirm the item pointer is not captured by any lambda, stored in a field, or passed to
  another thread after the processing block
- Check whether the caller of `precomputationTested()` uses the pointer after the call

**Test scenarios:**
- Test expectation: none — investigation unit

**Verification:**
- Written confirmation that `delete preTestItem` is safe at the end of each overload's
  processing block before writing the mod script


- [ ] **Unit 4: Patch 053 mod script — precomputationTested delete**

**Goal:** Add `delete preTestItem` in both `precomputationTested()` overloads at
`CTotallyPrecomputationThread.cpp`.

**Requirements:** R3

**Dependencies:** Unit 3 (graphify safety confirmation)

**Files:**
- Create: `scripts/mods/mod_053_precomputation_testing_item_delete.py`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
- Test: `tests/memory-rss-regression.test.ts`

**Approach:**
- One file in `FILES`
- `modify()` targets both overload bodies — locate the unique closing block of each overload's
  processing section and insert `delete preTestItem;` immediately before exit
- Use separate `content.replace(..., 1)` calls for each overload; assert each pattern found

**Patterns to follow:**
- `scripts/mods/mod_048_precomputation_inactive_cleanup.py`

**Test scenarios:**
- Happy path: vitest suite 569/570 pass after rebuild
- Happy path: precomputation-heavy ontology (LUBM-scale) shows reduced per-call RSS delta
- Error path: if graphify check (Unit 3) finds any post-callback access to preTestItem,
  do NOT implement this patch — raise as blocker

**Verification:**
- `make reset-patches && make build-wasm` succeeds
- Full suite passes; no segfaults on any precomputation test


- [ ] **Unit 5: Patch 054 mod script — indexer delete (trivial)**

**Goal:** Add `delete triplesMapper;` after each of the two indexer allocations in
preprocessing.

**Requirements:** R4

**Dependencies:** None (can run in parallel with other units)

**Files:**
- Create: `scripts/mods/mod_054_indexer_delete.py`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Preprocess/CRequirementConfigPreprocessingThread.cpp`
- Test: `tests/memory-rss-regression.test.ts`

**Approach:**
- One file in `FILES`
- Two `content.replace(..., 1)` calls — one per allocation site (lines 208 and 215 in
  the unpatched file; actual line numbers in patched state may differ slightly)
- Pattern: find the unique line immediately after each `new CRedlandStoredTriplesIndividual...`
  usage block and insert `delete triplesMapper;`

**Patterns to follow:**
- `scripts/mods/mod_048_precomputation_inactive_cleanup.py` (single-file, single-insert template)

**Test scenarios:**
- Happy path: vitest suite passes after rebuild
- Edge case: verify the indexer objects are not stored anywhere that would make a later
  access a UAF — graphify confirm before writing (quick check, low risk given they are
  local-scope one-shot objects)

**Verification:**
- `make reset-patches && make build-wasm` succeeds
- Full suite 569/570 pass; no segfault on preprocessing path


- [ ] **Unit 6: Update HANDOVER.md**

**Goal:** Mark items #4–6, #7, #9, #12, #13 as ✅ FIXED with patch numbers; update next
tasks section; update binary provenance.

**Requirements:** All

**Dependencies:** Units 2, 4, 5 complete and passing

**Files:**
- Modify: `HANDOVER.md`

**Approach:**
- Update table rows for #4–6, #12–13: status `✅ FIXED (patch 052)`, delete slot = stale-list
- Update row #7: status `✅ FIXED (patch 053)`, delete slot = `precomputationTested()` both overloads
- Update row #9: status `✅ FIXED (patch 054)`, delete slot = `delete triplesMapper` after each use
- Update "Binary rebuilt at" commit SHA
- Update "Next tasks" to reflect remaining open items (#8 verify, publish)

**Test scenarios:**
- Test expectation: none — documentation only

**Verification:**
- HANDOVER.md reflects actual patch state; no stale task entries

## System-Wide Impact

- **Interaction graph**: Deleting classifier items on the stale-list fires their destructors.
  All owned sub-objects (`CPartialPruningTaxonomy`, `CClassifierStatistics`,
  `CRolePropertiesHierarchy`, temp ontology + individuals) are freed transitively only if
  their destructors are non-empty or they are held by containers with owning semantics.
  Verify the ownership chain for each before assuming transitivity.
- **State lifecycle risks**: Cache hit path (same `{ont, callGen}`) must NOT push to stale
  list — the existing item is reused. `deleteStaleClassItems()` must only fire on cache miss
  (before `new`), not in the finish path of a hit.
- **Unchanged invariants**: The `mStaleClassItems` field must never be touched between
  `scheduleOntologyClassification()` and the next call to `deleteStaleClassItems()` on a
  different thread. Each concrete thread has its own member — no cross-thread sharing.
- **Integration coverage**: A classify → reset → classify sequence must not segfault (verifies
  no dangling pointer through the taxonomy or temp ontology after item deletion).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Transitivity assumption wrong — taxonomy or role hierarchy destructor chain is empty | Unit 1 graphify check; if broken, add explicit deletes to destructors in same patch 052 |
| `precomputationTested()` has a hidden post-callback access to `preTestItem` | Unit 3 graphify safety check is mandatory before writing patch 053 mod script |
| `assert old in content` fails due to earlier patches changing surrounding context | Read the patched-state file content after `make reset-patches`, not the raw vendor file |
| Incremental classify (#13) `finishOntologyClassification` is not truly inherited — has its own override | Confirmed by graphify in Unit 1; adjust Step A placement if wrong |
| Rebuilding WASM takes ~20-30 min — slow feedback loop | Run all 3 patches into one `make reset-patches && make build-wasm` if confident in mod scripts, or stage them one at a time if risk is high |

## Sources & References

- `HANDOVER.md` — heap object lifecycle table, fix strategies, paradigm constraints
- `scripts/mods/mod_047_realizer_leak.py` — Step A template
- `scripts/mods/mod_048_precomputation_inactive_cleanup.py` — Step B template
- Graphify graph: `vendor/konclude/Source/Reasoner/graphify-out/graph.json`
- Graphify audit findings: 2026-09-25 session (agents ae50634b, a5eb803f, a58f043bd7)
