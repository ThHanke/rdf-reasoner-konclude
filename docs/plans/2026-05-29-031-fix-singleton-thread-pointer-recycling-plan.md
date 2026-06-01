---
title: "fix: prevent stale-item and stale-callback failures from recycled ontology pointers in singleton threads"
type: fix
status: partial — RC1+RC2 applied; n=3 sameAs failure is BackendAssCache state issue (separate root cause; Unit 4 blocked)
date: 2026-05-29
origin: docs/plans/2026-05-29-030-fix-backendasscache-sameas-detection-plan.md
---

# fix: singleton thread pointer recycling — stale hash items and stale callbacks

## Overview

Sequential reasoning calls on a single `KoncludeReasoner` instance cause two distinct
failures from C++ pointer recycling when singleton threads are used (plan-029 threading fix).
Both cause `OPSPRECOMPUTESATURATION` to report failure (`sat=0`), suppressing all realization
output. This plan adds ontology-ID guards to hash lookups (RC1) and a generation counter to
`CRequirementProcessedCallbackEvent` (RC2) to make both failure modes impossible.

## Problem Frame

### RC1 — Stale hash items in singleton thread `mOntItemHash`

`CPrecomputationThread` and `CPreprocessingThread` use `QHash<CConcreteOntology*, Item*>` keyed
by raw ontology pointer. When call N's ontology is freed (`delete mPreviousOntology` in `reset()`)
and call N+2's fresh ontology is allocated at the same address, the hash returns the stale "already
complete" item from call N. Processing is skipped; the preprocessing/precomputation callback fires
immediately with a success status that was set against call N's step data — not call N+2's. The
manager checks `isRequirementSatisfied()` on call N+2's fresh ontology, finds nothing set, and
marks all 10 preprocessing requirements failed → `mRequirementFailed = true` → precomputer never
dispatched → `sat=0`.

`CSubsumptionClassifierThread` has the same pattern: `isOntologyClassificationScheduled(onto)`
uses `ontItemHash.contains(onto)`. A stale hit causes `rescheduleOntologyClassification` instead
of fresh scheduling, corrupting classification for the new call.

**Status:** ID-guard fix already in vendor working tree for `CPrecomputationThread` and
`CPreprocessingThread`. Not yet formalized as patches. Not yet applied to `CSubsumptionClassifierThread`.

### RC2 — Stale callbacks via double-recycled raw pointers

`CRequirementProcessedCallbackEvent` stores `CRequirementPreparingData* mReqPrepData` (raw pointer).
After call N completes, `reqData` is deleted (line 653 of `CReasonerManagerThread.cpp`). Call N+1
allocates a fresh `reqData` at the same address. A late KPSet saturation callback from call N fires
`doCallback()` → the `atomic<CThread*>` exchange succeeds (manager thread still alive) → event
posted to manager → `continueRequirementProcessing(call_N+1_reqData, call_N_ontology)`. The
`mCheckingReqList` in call N+1's `ontReqPrepData` (set when the preprocessor was dispatched)
contains the dangling requirement pointers from call N+1's already-deleted `reqList` (deleted at
line 707 AFTER `waitSynchronization()` but BEFORE the stale callback fires). Accessing those
dangling pointers → `isRequirementSatisfied()` reads garbage → all requirements fail → `sat=0`.

This only triggers when BOTH `reqData` AND `ontology` pointer are recycled simultaneously across
consecutive calls, which explains why it appears specifically with the n=3 ABox + classify trigger.

## Requirements Trace

- R1. `sat=1` for call 5+ on a singleton precomputer/preprocessor/classifier thread
- R2. `npm test` shows 198 passing + 1 expected-fail (regression it.fails unchanged until R4)
- R3. No hang after 3× ABox + full TBox classify (Dog/Mammal/Animal)
- R4. Regression test promoted: `it.fails` → `it`, fresh-reasoner workarounds removed, 199/199 pass
- R5. All diagnostic vendor patches and source changes cleaned up

## Scope Boundaries

- Fix only pointer-recycling failures in singleton thread hashes and requirement callbacks
- Do not rearchitect the singleton manager pattern from plan-029
- Do not change the public TypeScript API or wire format
- Do not address the `mNextIndiUpdateId` / `mSlotUpdateWaitingIncreaseCount` BackendAssCache
  state accumulation (separate deferred investigation)

### Deferred to Separate Tasks

- Investigating whether BackendAssCache sameAs detection has additional correctness issues
  beyond the `sat=0` pipeline failures addressed here

## Context & Research

### Relevant Code and Patterns

**RC1 targets — singleton thread hash lookups:**
- `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp` ~line 189:
  `COntologyPrecomputationItem* item = mOntItemHash.value(ontology)` — **ID guard already added,
  not yet a formal patch**
- `vendor/konclude/Source/Reasoner/Preprocess/CPreprocessingThread.cpp` ~line 153:
  `COntologyPreprocessingItem* item = mOntItemHash.value(ontology)` — **ID guard already added,
  not yet a formal patch**
- `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.cpp` ~line 199:
  `if (!isOntologyClassificationScheduled(onto))` → `ontItemHash.contains(onto)` — **not yet fixed**

**RC2 target — callback generation guard:**
- `vendor/konclude/Source/Reasoner/Kernel/Manager/Events/CRequirementProcessedCallbackEvent.h`
  — already has `atomic<CThread*> recThread` from patch-011; needs `mExpectedGeneration`
- `vendor/konclude/Source/Reasoner/Kernel/Manager/Events/CRequirementProcessedCallbackEvent.cpp`
  — `doCallback()` needs generation check before `postEvent`
- `vendor/konclude/Source/Reasoner/Kernel/Manager/CRequirementPreparingData.h`
  — needs `cint64 mGeneration` member
- `vendor/konclude/Source/Reasoner/Kernel/Manager/CRequirementPreparingData.cpp`
  — constructor initializes `mGeneration` from a static atomic counter

**Diagnostic code to remove:**
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp` — 6 fprintf
- `vendor/konclude/Source/Reasoner/Kernel/Manager/CReasonerManagerThread.cpp` — 4 fprintf
- `vendor/konclude/Source/Reasoner/Kernel/Manager/COntologyRequirementPreparingData.cpp` — 1 fprintf
- `src/KoncludeReasoner.cpp` — `sCallN` counter + 2 fprintf diagnostic blocks
- `ts/worker.ts` — `printErr` filter expanded to pass `{bacc}` and `{diag2}`

**Patch naming and format:**
- Existing patches: `patches/001` through `patches/016`; next available is `patches/017`
- Format: `git -C vendor/konclude diff HEAD [path] > patches/NNN-description.patch`
- Apply at CMake configure time via `scripts/apply-patches.sh`; idempotent via sentinel

### Institutional Learnings

- `docs/plans/2026-05-29-030-fix-backendasscache-sameas-detection-plan.md` — plan this supersedes;
  RC1 diagnosis progressed there
- `docs/solutions/architecture-patterns/wasm-manager-thread-singleton-pattern.md` — singleton
  manager pattern context
- `patches/011-once-fire-callback.patch` — existing `atomic<CThread*>` pattern for callbacks;
  RC2 generation counter follows same spirit but guards the reqData identity

## Key Technical Decisions

- **ID guard uses `getOntologyID()` not pointer equality**: Ontology IDs are random 64-bit values
  assigned in `buildFreshOntology()` — collision probability negligible (2^-63 per call).
  Comparing IDs is O(1) and doesn't require any structural changes to the hash.
- **Generation counter in reqData, not a set membership check**: `mProcessingRequirementsSet`
  contains call N+1's fresh reqData (at recycled address), so a set-contains check would pass
  falsely. A monotonically incrementing generation counter is unique per allocation and survives
  address recycling.
- **Static atomic counter for generation**: `static std::atomic<cint64> sNextGeneration` in
  `CRequirementPreparingData`. Each new reqData increments it. Unique across entire process
  lifetime even for reused addresses.
- **Discard in `doCallback()`, not in manager handler**: Stale detection belongs in the callback
  itself (before posting the event) so the manager thread sees no spurious events. This keeps
  `continueRequirementProcessing()` clean.
- **Formalize RC1 as patches, not just vendor working-tree changes**: Direct vendor edits are
  lost on `git submodule update`. Patches survive and are re-applied idempotently at configure time.

## Open Questions

### Resolved During Planning

- **Does RC2 affect non-singleton use (native server mode)?**: No. The generation counter is a
  no-op when reqData is never recycled — fresh allocations always increment, stale callbacks
  from a prior call would have a different reqData address entirely. Zero false positives.
- **Are there other singleton threads with `mOntItemHash`?**: Investigation confirmed
  `CPrecomputationThread`, `CPreprocessingThread`, and `CSubsumptionClassifierThread`. No other
  singleton threads have this hash pattern.
- **Does the realizer thread also need RC2?**: No. Realizers are already handled via
  `stopAndClearRealizers()` after each call. The stale callback is specifically from KPSet
  precomputation workers.

### Deferred to Implementation

- Whether the classifier's stale hash entry causes observable correctness issues beyond `sat=0`
  (e.g., wrong class hierarchy) — verify by checking if n=3+classify classification output is
  correct after the fix.

## Implementation Units

---

- [x] **Unit 1: Remove all diagnostic vendor patches and source artifacts**

**Goal:** Restore clean buildable state before formalizing fixes as patches.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
  (remove 6 `fprintf` + `fflush` blocks at installDeterministicSameAs function entry, FAIL path, INCOMPAT path, STATS path, checkAssociationComplete path)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/CReasonerManagerThread.cpp`
  (remove 3 `fprintf` blocks: CHECK, CHECK_REQ, DISPATCH; keep the REQFAIL diagnostic — or remove all and keep only the functional path)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/COntologyRequirementPreparingData.cpp`
  (remove 1 `fprintf` at `mFailedReqList.append`)
- Modify: `src/KoncludeReasoner.cpp`
  (remove `static int sCallN`, two `fprintf` diagnostic blocks)
- Modify: `ts/worker.ts`
  (revert `printErr` to `() => {}`)

**Approach:**
- Remove only diagnostic lines; do NOT touch the RC1 ID-guard in `CPrecomputationThread.cpp`
  or `CPreprocessingThread.cpp` — those are the fixes to preserve and formalize.
- After cleanup, run `npm run build` (TypeScript only — no WASM rebuild needed for ts changes).

**Test scenarios:**
- Test expectation: none — pure cleanup, no behavioral change.

**Verification:**
- `ts/worker.ts` has `printErr: () => {}`
- `src/KoncludeReasoner.cpp` has no `sCallN` or `{diag2}` strings
- Vendor files have no `{bacc}` strings (grep confirms)
- `npm run build` succeeds

---

- [x] **Unit 2: Formalize RC1 ID-guard as patches 017 and 018; add patch 019 for classifier**

**Goal:** Extract the in-tree RC1 fixes into reproducible patch files; add the missing classifier fix.

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**
- Create: `patches/017-precomputer-id-guard.patch`
- Create: `patches/018-preprocessor-id-guard.patch`
- Create: `patches/019-classifier-id-guard.patch`
- Modify: `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.cpp`
  (add ID guard before `isOntologyClassificationScheduled` check at ~line 199)

**Approach:**

For patches 017 and 018: the ID guard is already in the vendor working tree. Generate patches
from the current vendor diff for those two files, save to `patches/`. Example approach:
`git -C vendor/konclude diff HEAD -- [path] > patches/017-...`

For patch 019 (classifier fix): add the same ID-guard pattern to `CSubsumptionClassifierThread.cpp`
before the `isOntologyClassificationScheduled(onto)` call. Remove any stale `ontItemHash` entry
for `onto` if the stored item's ontology ID differs:
```
if (ontItemHash.contains(onto)) {
    ontClassItem = ontItemHash.value(onto);
    if (ontClassItem && ontClassItem->getOntology() != onto) {  // recycled pointer
        ontItemHash.remove(onto);   // evict stale entry
        // fall through to scheduleOntologyClassification
    }
}
if (!isOntologyClassificationScheduled(onto)) {
    scheduleOntologyClassification(onto, nullptr, config);
    ...
```
Note: `CSubsumptionClassifierThread` uses `CConcreteOntology*` for the hash key but
`COntologyClassificationItem::getOntology()` returns the stored ontology pointer. Compare
`ontClassItem->getOntology()` (stored pointer) vs `onto` (current pointer). If they differ, stale.
This is a pointer-equality check (same address = same call, since we never pass the same ontology
object twice). Unlike the precomputer/preprocessor, we don't have `getOntologyID()` easily accessible
on `COntologyClassificationItem`. Verify whether `getOntology()` is available; if not, use the ID
via `onto->getOntologyID()` vs stored `getOntology()->getOntologyID()`.

After creating patches 017–019, reset the vendor working tree for those files and re-apply all
patches to confirm they apply cleanly. Rebuild WASM. Run `npm test`.

**Patterns to follow:**
- `patches/011-once-fire-callback.patch` — patch format example
- Existing ID-guard code in `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp`

**Test scenarios:**
- Happy path: n=1,2,3 ABOX + classify → all ABOX passes (sat=1 for all calls)
- Happy path: 8 successive ABOX materializations on single instance → all pass
- Integration: `npm test` 198/199 (regression test still `it.fails`)

**Verification:**
- `git -C vendor/konclude diff HEAD` shows no diff for patched files (clean working tree)
- `npm test` 198 passing + 1 expected fail

---

- [x] **Unit 3: Implement RC2 — generation counter in `CRequirementPreparingData` + `CRequirementProcessedCallbackEvent`** *(patch 020 applied; n=3 sameAs still fails — BackendAssCache state issue, not pointer recycling)*

**Goal:** Prevent stale KPSet callbacks from firing against recycled `reqData`, eliminating the
double-recycled-pointer `sat=0` failure.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 2

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/CRequirementPreparingData.h`
  (add `cint64 mGeneration;` public member)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/CRequirementPreparingData.cpp`
  (initialize `mGeneration` from static atomic counter in constructor)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/Events/CRequirementProcessedCallbackEvent.h`
  (add `cint64 mExpectedGeneration;` member; extend constructor to accept and store generation)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/Events/CRequirementProcessedCallbackEvent.cpp`
  (in `doCallback()`: after `recThread.exchange(nullptr)` returns a non-null thread, check
  `mReqPrepData->mGeneration == mExpectedGeneration`; if not equal, discard without posting)
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Manager/CReasonerManagerThread.cpp`
  (pass `reqData->mGeneration` when constructing `CRequirementProcessedCallbackEvent` at all
  call sites: preprocessor, precomputer, class classifier, obj-prop classifier, data-prop
  classifier, realizer dispatches — search for `new CRequirementProcessedCallbackEvent`)
- Create: `patches/020-reqdata-generation-counter.patch`

**Approach:**

The generation counter in `CRequirementPreparingData`:
- Add `static std::atomic<cint64> sNextGeneration` (initialize to 0) in the .cpp file
- In constructor: `mGeneration = ++sNextGeneration`
- `mGeneration` is public so `CRequirementProcessedCallbackEvent` can read it during `doCallback()`

The `CRequirementProcessedCallbackEvent` changes:
- Constructor signature gains `cint64 expectedGeneration` parameter
- Stores as `mExpectedGeneration`
- In `doCallback()`: existing atomic exchange pattern (patch-011) already guards against
  double-fire; add after `if (t)`: `if (mReqPrepData->mGeneration != mExpectedGeneration) return;`
  to discard stale callbacks where reqData was recycled

Call sites in `CReasonerManagerThread.cpp` (lines ~538, ~552, ~566, ~580, ~594, ~604, etc.):
```cpp
new CRequirementProcessedCallbackEvent(this, ontology, reqData, processorType, reqData->mGeneration)
```

All `new CRequirementProcessedCallbackEvent(...)` calls in the manager thread need the generation
added. Search for `CRequirementProcessedCallbackEvent` in `CReasonerManagerThread.cpp` to find all
call sites. There should be 5–7 sites (one per processor type dispatched in
`continueRequirementProcessing()`).

After implementing, generate `patches/020-reqdata-generation-counter.patch`, reset vendor files, re-apply all patches, rebuild WASM.

**Patterns to follow:**
- `patches/011-once-fire-callback.patch` — existing atomic guard in `doCallback()`
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — WASM-specific guard comment style

**Test scenarios:**
- Happy path: 3× ABox(Alice-knows-Bob) + full TBox classify(Dog/Mammal/Animal) → sameAs materialize
  completes without hang AND returns ≥1 owl:sameAs triple
- Happy path: n=1 through n=8 ABox + classify → sameAs all produce correct output
- Edge case: n=0 ABox + classify → sameAs still works (baseline)
- Integration: `npm test` 198/199 (regression test still `it.fails` until Unit 4)

**Verification:**
- Direct test: 3× ABox + classify + sameAs → result ≥1 sameAs triple (no hang, no 0 triples)
- `npm test` 198 passing + 1 expected fail
- `git -C vendor/konclude diff HEAD` shows no diff (patches applied cleanly)

---

- [ ] **Unit 4: Promote regression test; remove fresh-reasoner workarounds; update solutions doc**

**Goal:** Convert `it.fails` to a normal passing test. Remove the workaround `fresh RdfReasoner`
instances for sameAs and data-property tests. Record the root causes and fixes.

**Requirements:** R4

**Dependencies:** Unit 3

**Files:**
- Modify: `tests/integration/abox-realization.test.ts`
- Modify: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`

**Approach:**

In `tests/integration/abox-realization.test.ts`:
- Remove `.fails` from the regression test at the `it.fails(...)` call; update description to
  "regression — fixed by plan-031 (pointer recycling guards)"
- For "owl:sameAs pair appears in materialize() output" and "data property literal triple": replace
  the `fresh = new RdfReasoner()` workaround with the shared `reasoner` (same pattern as the first
  three tests in the describe block)

In the solutions doc:
- Update `status:` frontmatter to `resolved 2026-05-29`
- Add section "Fix (plan-031)": summarize RC1 (ID guard in precomputer/preprocessor/classifier hash
  lookups) and RC2 (generation counter in CRequirementPreparingData + CRequirementProcessedCallbackEvent)
- Update the problem description to note the actual failure path was `sat=0` from pointer recycling,
  not a BackendAssCache internal detection bug

**Test scenarios:**
- Happy path: regression test passes — 3× ABox(Alice-knows-Bob) + full classify + sameAs returns ≥1 sameAs triple using shared reasoner
- Happy path: sameAs test passes with shared reasoner (Alice↔Eve pair detected)
- Happy path: data property test passes with shared reasoner (Alice age 30)
- No-regression: all 199 tests pass; 0 expected-fails

**Verification:**
- `npx vitest run tests/integration/abox-realization.test.ts` → 7/7 pass
- `npm test` → **199/199 pass, 0 expected-fails**

## System-Wide Impact

- **Affected threads:** `CTotallyPrecomputationThread`, `CPrecomputationThread`,
  `CPreprocessingThread`, `CSubsumptionClassifierThread`, `CRequirementProcessedCallbackEvent`
- **Unchanged invariants:** public TypeScript API, WASM binary interface, wire format unchanged.
  Singleton manager pattern from plan-029 unchanged. BackendAssCache logic unchanged.
- **Memory growth:** `mOntItemHash` entries from prior calls remain (items are never removed
  unless evicted by the ID guard). Memory grows bounded by call count — acceptable for test
  workloads. Long-running server use cases may need explicit cleanup (deferred).
- **Thread safety:** The generation counter uses `std::atomic<cint64>` — safe for concurrent
  reqData allocation in different threads (not applicable in our single-manager-thread setup but
  correct regardless).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Patch generation captures more than intended diff | Review each patch file before committing; use file-scoped `git diff` |
| RC2 constructor signature change breaks other callers | Grep all `new CRequirementProcessedCallbackEvent` — should be only in `CReasonerManagerThread.cpp` |
| ID guard breaks incremental reasoning (same ontology re-submitted) | Our use case never re-submits the same ontology object; fresh object per call always |
| Additional pointer-recycling paths exist beyond these three | Run n-pattern sweep (n=0..10) after Unit 3; confirms broad coverage |

## Sources & References

- Origin plan: `docs/plans/2026-05-29-030-fix-backendasscache-sameas-detection-plan.md`
- RC1 pattern in tree: `vendor/konclude/Source/Reasoner/Consistiser/CPrecomputationThread.cpp` lines 189–196
- RC2 existing guard pattern: `patches/011-once-fire-callback.patch`
- Solutions doc: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
- Regression test: `tests/integration/abox-realization.test.ts` (it.fails block)
