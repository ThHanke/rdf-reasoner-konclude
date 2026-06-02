---
title: "fix: diagnose and fix BackendAssCache sameAs detection failure after n=3 ABox+classify"
type: fix
status: complete
date: 2026-05-29
---

# fix: BackendAssCache sameAs detection failure after n=3 ABox + classify

## Overview

`materialize()` returns 0 `owl:sameAs` triples when a fresh `KoncludeReasoner` processes:
3× `materialize(ABOX)` with an Alice-knows-Bob object-property assertion, then
`classify(TBOX)` with a 2-subclass hierarchy (Dog ⊑ Mammal ⊑ Animal), then
`materialize(SAMEAS)`. The failure is silent — no crash, no error, just missing output.

## Problem Frame

After plan-029 fixed pthread-pool exhaustion and introduced a singleton precomputation/
classifier/preprocessor pattern, the sameAs call no longer hangs but still returns 0 triples.
The root cause is in `CBackendRepresentativeMemoryCache::installDeterministicSameAsAssociationUpdates`:
Eve's `DeterministicMergedSameConsideredLabelCacheEntry` is never set with Alice's ID, so the
Round-2 check at line 1299 always fails.

Known trigger constraints:
- Object-property assertions (Alice knows Bob) in ABox calls required
- Full TBox classify (≥2 subclass axioms) required — simpler TBox does NOT trigger
- n=3 ABox calls required — n=2 does NOT trigger
- n=3 ABox + 0 classify → sameAs PASSES
- n=3 ABox + classify + 1 extra ABox → sameAs PASSES

The singleton-manager approach (plan-029 threading fix) left label items in BackendAssCache's
permanent context across calls, accumulating extension data that likely affects the sameAs
detection path.

## Requirements Trace

- R1. `materialize()` with `owl:sameAs` assertions returns correct output regardless of prior call history
- R2. Regression test `it.fails` in `tests/integration/abox-realization.test.ts` is converted to a normal passing test
- R3. Fresh-reasoner workarounds for sameAs and data-prop tests are removed (tests use the shared reasoner)
- R4. No regression in existing 198/199 tests

## Scope Boundaries

- Fix only the BackendAssCache sameAs detection failure; do not rearchitect the singleton-manager pattern
- Do not attempt to fix additional sameAs detection bugs beyond the n=3 trigger
- Do not change the WASM public API or wire format

### Deferred to Separate Tasks

- Investigating whether `mOntoClassifierHash` singleton causes incorrect classification results
  for other ontology combinations: separate investigation if R2 is not achieved by Units 1–3
- Removing `docs/plans/2026-05-28-028-feat-axiom-work-api-phase2-plan.md` (unrelated pending plan)

## Context & Research

### Relevant Code and Patterns

- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
  - `installDeterministicSameAsAssociationUpdates()` ~lines 1257–1338: checks Eve's considered label (~line 1299)
  - `installAssociationUpdate()` ~lines 1540+: per-individual update handler
  - **`existDetSameHandlIdLabel` block ~lines 1809–1858** (prime suspect): aborts `detSameNeighbourCompletion`
    when old label's IDs are not a subset of the new proposed DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL
  - `incompatibleChanges` check ~line 1662: `getAssociationDataUpdateId() != usedUpdateId`
  - `detSameNeighbourCompletion` block ~lines 2674–2695: sets `DeterministicMergedSameConsideredLabelCacheEntry`
  - `completeDeterministicSameAsMergingInformation()` ~line 2938: propagates merged sameAs labels, sets representativeSameIndividualId
  - `checkAssociationComplete()` ~line 5280: writes `mFixedOntologyIdentifierDataHash[ontologyID]`
  - `createOntologyFixedCacheReader()` ~line 520: realizer reads from `mFixedOntologyIdentifierDataHash`
  - `prepareOntologyDataUpdate()` ~line 360: upserts `mOntologyIdentifierDataHash`; ~line 410 copies prior OntologyData
  - `mStatDetSame*` counters (~lines 124–130, 3909–3910): aggregate failure reasons
  - `mNextIndiUpdateId` (field, init=1, never reset): time-ordering counter for association data
  - `mSlotUpdateWaitingIncreaseCount` (field, init=1, mitigated by WasmConfigProvider max=0)
  - `mFixedOntologyIdentifierDataHash` (never evicted, accumulates one entry per completed call)
- `src/KoncludeReasoner.cpp` `reset()` ~lines 394–405: does NOT reset `mBackendAssCache` or any singleton
- `src/KoncludeReasoner.cpp` `WasmConfigProvider::WasmConfigProvider()` ~line 264–277: sets
  `SlotUpdateWaitingIncreaseMaximumCount=0` (forces immediate slot publication)
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` `startProcessing()`: STPU stale-signal drain
- `tests/integration/abox-realization.test.ts`: `it.fails` regression test (lines 198–234)
- `patches/` directory: existing patch format; next available number is 021
- `src/compat/overrides/CPrecomputationManager.cpp`: singleton reuse pattern (plan-029 threading fix)

### Institutional Learnings

- `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`:
  mechanism is dynamic hash map (not fixed slot array); exact failure path still open as of plan-029
- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`:
  STPU stale-semaphore fix pattern
- `docs/solutions/architecture-patterns/wasm-manager-thread-singleton-pattern.md`:
  singleton manager thread pattern

### Key Diagnostic Facts

The failure chain (confirmed by plan-029 investigation):
1. Alice writes to BackendAssCache with `DETERMINISTIC_SAME_INDIVIDUAL_ID = Eve`
2. BackendAssCache checks `Eve->getDeterministicMergedSameConsideredLabelCacheEntry()`
3. **Label is null or missing Alice** → failure path (line 1306)
4. Eve is re-queued (line 1329)
5. Eve processes in Round 2 — but Eve's considered label is still not set with Alice's ID
6. Result: `installDeterministicSameAsAssociationUpdate()` never succeeds → 0 sameAs output

The trigger combination (3 ABox with knows/Bob + full TBox classify) suggests:
- 3 ABox calls accumulate NEIGHBOUR_INSTANTIATED_ROLE_SET_COMBINATION_LABEL extension data
  for Alice (pointing to Bob via `knows`) in the BackendAssCache permanent context
- The full TBox classify (via singleton `CTotallyPrecomputationThread`) creates additional
  slot updates and label state that causes Eve's Round 2 processing to skip setting the
  considered label

The `mStatDetSame*` counters at line 3909 would reveal which specific failure branch fires.
`printErr` filtering (`{bacc}` prefix) can expose this without a configuration change.

## Key Technical Decisions

- **Diagnostic-first approach**: instrument BackendAssCache with targeted `fprintf` via a vendor patch,
  capture runtime counter values, then fix the specific failure branch. Avoids guessing at the exact
  code path after extensive static analysis that has not converged.
- **Patch for diagnostics then separate fix patch**: keep diagnostic patch temporary (numbered 021,
  removed after diagnosis); the actual fix becomes a permanent patch (022). Patches 017–020 are taken
  by RC1/RC2 fixes from plan-031.
- **printErr filter already in place**: `ts/worker.ts` printErr silences all WASM output; the
  diagnostic patch adds `{bacc}` prefix lines that can be selectively enabled via a one-line
  worker.ts change (already tested in plan-029 investigation).
- **Do not delete singleton managers**: the singleton pattern from plan-029 stays; the fix targets
  the BackendAssCache behavior directly.
- **Prime suspect (2026-06-01 update)**: The `existDetSameHandlIdLabel` check at
  `installAssociationUpdate` lines 1809–1858 is now the leading hypothesis. If a prior call
  (classify's saturation) left a non-null `DeterministicMergedSameConsideredLabelCacheEntry` on
  Alice/Bob's association data, the check aborts `detSameNeighbourCompletion` when the old label's
  IDs are not a subset of the new sameAs call's proposed `DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL`.
  This is the "Scenario B" path from Unit 2. The diagnostic must capture this path explicitly.
- **`mNextIndiUpdateId` accumulates but is secondary**: this counter is never reset across calls.
  After n=3 ABox + classify, individual update IDs are large, which can cause `incompatibleChanges`
  at line 1662. However, `mSlotUpdateWaitingIncreaseCount` is already clamped to 0 via
  WasmConfigProvider (immediate slot publication). `mNextIndiUpdateId` may still contribute.
- **`mFixedOntologyIdentifierDataHash` never evicts**: accumulates one entry per completed call.
  With random ontology IDs (post-plan-029) there is no ID collision, but the realizer reads the
  fixed snapshot AFTER `checkAssociationComplete` fires. If sameAs neighbour completion was aborted
  before that point, the snapshot is written without Eve's merge marker.

## Open Questions

### Resolved During Planning

- **Is the failure a hang or wrong result?** Wrong result (0 triples) — confirmed by plan-029 testing
- **Is Eve's considered label ever set?** No — the Round-2 path that sets it (line 2687) is not reached
- **Is the STPU involved?** No — saturation completes (sat=1 confirmed in diagnostics); the failure
  is within BackendAssCache's individual-association processing
- **Does n=2 ABox + classify fail?** No — only n=3

### Resolved During Research (2026-06-01)

- **Which fields accumulate and never reset?**
  `mNextIndiUpdateId` (init=1, never reset — incremented on every association touch).
  `mSlotUpdateWaitingIncreaseCount` (init=1, never reset, but already clamped to 0 via config).
  `mFixedOntologyIdentifierDataHash` (accumulates one entry per completed call, never evicted).
  `mOntologyIdentifierDataHash` (accumulates per-ontology OntologyData, never evicted).
  `mReaderLinker` (all created readers remain forever). These persist across every `reset()`.
- **Is `DeterministicMergedSameConsideredLabelCacheEntry` persistent?**
  The per-individual field `setDeterministicMergedSameConsideredLabelCacheEntry` lives in each
  individual's `CBackendRepresentativeMemoryCacheIndividualAssociationData`, which lives inside
  the `CBackendRepresentativeMemoryCacheOntologyData`. If the OntologyData for a prior call's
  ontology ID persists (it does — in `mOntologyIdentifierDataHash`), then its individual
  association entries also persist — including this field. When a new call's saturation
  processes Alice/Bob, it finds this stale field set, causing the `existDetSameHandlIdLabel`
  check to abort sameAs completion.
- **Does `prepareOntologyDataUpdate` copy prior data forward?**
  Line 410–413: `if (prevOntologyData) { copy association vector from prev → new OntologyData }`.
  With random IDs there should be no `prevOntologyData` match for a brand-new ID (no prior entry).
  However, the prior call's OntologyData remains in `mOntologyIdentifierDataHash` forever, and its
  individual association data (with stale `DeterministicMergedSameConsideredLabelCacheEntry`) is
  accessible via the old ontology ID key.

### Deferred to Implementation

- **Exact `mStatDetSame*` counter values for the failing call** — obtainable only from runtime diagnostics
- **Whether `incompatibleChanges=true` is set for Eve in Round 2 (line 1662)** — determines whether
  the fix is in the neighbour-completion threshold or label-comparison path
- **Whether the `existDetSameHandlIdLabel` stale-label check (lines 1809–1858) is the primary gate**
  — diagnostic must log when this block aborts `detSameNeighbourCompletion`
- **Whether the singleton classifier contributes** — can be ruled out by swapping to a fresh
  classifier per call in the diagnostic build and re-testing

## Implementation Units

- [ ] **Unit 1: Add targeted BackendAssCache diagnostic patch and capture runtime failure reason**

**Goal:** Get exact runtime data on which `mStatDetSame*` branch fires and whether
`incompatibleChanges=true` is set for Eve's Round 2 write.

**Requirements:** R1 (prerequisite investigation)

**Dependencies:** None

**Files:**
- Create: `patches/021-backendasscache-sameas-diag.patch`
- Modify: `ts/worker.ts` (enable `{bacc}` prefix in printErr — one-line temporary change)

**Approach:**

Add `fprintf(stderr, "{bacc} ...")` + `fflush(stderr)` at four locations in
`vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`:

1. **At line 1306** (entry to the `installDeterministicSameAsAssociationUpdates` failure block):
   log `individualID`, `sameAsIndividualId`,
   `detSameAsAssociationData->hasRepresentativeSameIndividualMerging()`,
   `detSameAsAssociationData->isCompletelyHandled()`,
   and the pointer value of `detSameHandledLabel` (null check).

2. **At line 3909** (the stat log): replace the silent `LOG(INFO, ...)` call with a `fprintf`
   that prints `mStatDetSameAssociationInstallCount`, `mStatDetSameAssociationFailedCount`,
   and the three sub-counters (incompleteHandled, differentUpdateId, repMerged).

3. **At line 1662** (entry to `installAssociationUpdates` incompatibility block): log
   `individualID`, `getAssociationDataUpdateId()`, `usedUpdateId`, and `getAssociatedIndividualId()`
   when the condition is true.

4. **At lines 1809–1858** (the `existDetSameHandlIdLabel` block — prime suspect for the stale-label
   abort): add a log when `existDetSameHandlIdLabel != nullptr` AND
   `detSameNeighbourCompletion` is being set to false because the old label's IDs are not a
   subset of the new proposed label. Log: `individualID`, pointer values of old and new labels,
   and which ID in the old label failed the subset check. This is the newly identified suspect path
   (2026-06-01 research); it must be covered even if the stat counters in (2) don't fire.

The patch must match `vendor/konclude` state exactly (patches are applied via `git apply`).
Use `git -C vendor/konclude diff HEAD` to generate the patch after making changes.

Enable printErr in `ts/worker.ts`: `printErr: (s) => { if (s.includes('{bacc}')) process.stderr.write(s + '\n'); }`

Rebuild WASM, run the exact regression sequence (n=3 ABox + full TBox classify + sameAs) with
stderr visible, and record all `{bacc}` lines.

**Test scenarios:**
- Test expectation: none — this unit produces diagnostic output, not a behavioral change

**Verification:**
- `{bacc}` lines appear in the regression test output
- At least one failure-branch log line and the stat log line appear
- From the stat log, exactly one of the three `mStatDetSame*` failure sub-counters is non-zero

---

- [ ] **Unit 2: Analyze diagnostic output and identify the exact fix location**

**Goal:** From the Unit 1 output, determine the specific condition that prevents Eve's
considered label from being set with Alice's ID.

**Requirements:** R1 (prerequisite investigation)

**Dependencies:** Unit 1

**Files:**
- Modify: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`

**Approach:**

Three expected diagnostic outcomes and their corresponding fixes:

**Scenario A — `mStatDetSameAssociationIncompleteHandledDestFailedCount > 0`** (Eve not
completely handled at the time of Alice's check):
- Round 2 fires but Eve is still incomplete when Round 3 checks
- Fix target: why `storeIndividualIncompletelyMarked` for Eve doesn't resolve before Round 3

**Scenario B — `existDetSameHandlIdLabel` stale-label abort (lines 1809–1858)** (prime suspect):
- Alice/Bob's `DeterministicMergedSameConsideredLabelCacheEntry` was set by the classify call's
  saturation. When the sameAs call's saturation fires `detSameNeighbourCompletion` for Alice/Bob,
  the check finds `existDetSameHandlIdLabel != nullptr` and verifies that every ID in the OLD label
  is in the NEW proposed `DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL`. If any ID from the classify
  saturation's label is absent in the sameAs saturation's label, `detSameNeighbourCompletion = false`.
- Fix option 1 (preferred if the stale label belongs to a prior ontology): add a guard that
  discards `existDetSameHandlIdLabel` when it was set for a different ontology. The label's
  ontology ID is available via the ontology context; if it differs from the current call's
  ontology ID, treat the field as absent.
- Fix option 2 (broader but safer): after `incompatibleChanges=true` from line 1662, reset
  `DeterministicMergedSameConsideredLabelCacheEntry` to null so the next round sees a clean state.
- Config option: set `mConfInterpretUnchangedLabelsAsCompatible = true` via WasmConfigProvider
  (no vendor patch) — this may bypass the ID mismatch at line 1662 but does not directly address
  the `existDetSameHandlIdLabel` stale-label subset check.

**Scenario B2 — `incompatibleChanges=true` logged for Eve in Round 2 (line 1662)**:
- Eve's `getAssociationDataUpdateId() != usedUpdateId`
- Cause: `mNextIndiUpdateId` advances between saturation's read and write — the singleton threads
  (precomputer, preprocessor from prior calls) touched Eve's association data, incrementing her ID
- Fix: `mConfInterpretUnchangedLabelsAsCompatible = true` via WasmConfigProvider (if scenario B
  doesn't fire); or narrow the update-ID check at line 1662

**Scenario C — `mStatDetSameAssociationDifferentUpdateIdFailedCount > 0` or
`mStatDetSameAssociationDifferentDestIdFailedCount > 0`**:
- The installation data hash condition at line 1228 rejected Alice (not added to
  `mDeterministicSameHandlingInstallationDataHash[Eve's ID]`)
- Eve's Round 2 write has no Alice in its installation set → considered label not set
- Fix target: line 1228 condition or what populates the hash

Once the scenario is confirmed, update the solutions doc with the precise mechanism.

**Test scenarios:**
- Test expectation: none — this unit is analysis, not behavioral change

**Verification:**
- Solutions doc updated with the exact failure path and the intended fix approach

---

- [ ] **Unit 3: Implement the fix**

**Goal:** Apply a targeted fix to `CBackendRepresentativeMemoryCache.cpp` via the
appropriate mechanism (patch or WASM-specific config) so that the sameAs detection succeeds
after n=3 ABox + classify.

**Requirements:** R1, R4

**Dependencies:** Unit 2 (fix location known)

**Files:**
- Create: `patches/022-backendasscache-sameas-fix.patch` (if vendor code change)
  OR modify `src/KoncludeReasoner.cpp` (if config-level fix suffices)
- Remove: `patches/021-backendasscache-sameas-diag.patch` (diagnostic patch)
- Revert: `ts/worker.ts` printErr back to `() => {}`

**Approach — fix options by scenario (select after Unit 2):**

**If Scenario A** (incompletely handled destination):
- Investigate whether `mConfMaxIncompletelyHandledIndividualsRetrievalCount` forces premature
  completion. If so: raise the limit via WasmConfigProvider config setting (no vendor patch needed).
- Alternative: ensure `markRepresentativeReferencedIndividualAssociationIncompletelyHandled`
  from line 1329 properly triggers a new retrieval round.

**If Scenario B** (incompatibleChanges=true for Eve due to update-ID mismatch):
- Option 1: set `mConfInterpretUnchangedLabelsAsCompatible = true` via WasmConfigProvider
  (config-level fix, no vendor patch). This enables the label-compatibility check at line 1667
  that may resolve Eve as compatible even when her update ID advanced.
- Option 2: patch line 1662 to narrow the condition so stale ID advances from prior calls
  don't trigger incompatibleChanges.

**If Scenario C** (Alice missing from installation hash):
- The condition at line 1228 uses `associationData->getAssociationDataUpdateId() == usedUpdateId`.
  If Eve's Round 2 write's `usedUpdateId` for Alice doesn't match Alice's current update ID,
  Alice is skipped. Fix: patch line 1228 to also accept Alice when she has already been
  marked completely handled (`associationData->hasDeterministicSameIndividualMerging()`).

Prefer a config-level fix (WasmConfigProvider) over a vendor patch. If a vendor patch is
required, follow the `patches/` convention: `git -C vendor/konclude diff HEAD > patches/018-...patch`.

After fix is applied, remove the diagnostic patch (017) from `patches/` and revert `worker.ts`.

**Test scenarios:**
- Happy path: n=3 ABox + full TBox classify → sameAs returns ≥1 owl:sameAs triple
- Regression: all 198 existing tests still pass
- Boundary: n=1 and n=2 ABox + classify → sameAs still pass
- Boundary: n=3 ABox + classify + 10 more materializations → no degradation

**Verification:**
- `npx vitest run tests/integration/abox-realization.test.ts` shows the regression test
  is still in `it.fails` state (failing as expected) — it will be promoted in Unit 4 only
  after the fix is confirmed working via this unit's direct invocation test
- `npm test` shows 198/198 pass + 1 expected fail (regression test still has `it.fails`
  while we validate the fix)

---

- [ ] **Unit 4: Promote regression test and remove fresh-reasoner workarounds**

**Goal:** Convert `it.fails` to a normal passing test; remove the fresh-reasoner
workarounds from the sameAs and data-prop tests now that the shared reasoner is reliable.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 3 (fix confirmed working)

**Files:**
- Modify: `tests/integration/abox-realization.test.ts`
- Modify: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`

**Approach:**
- Remove `.fails` from the regression test name at line 198; update the test description
  to say "regression — fixed by plan-030"
- For the "owl:sameAs pair appears in materialize() output" test: replace the `fresh`
  RdfReasoner with the shared `reasoner`
- For "data property literal triple appears in materialize() output": same — replace `fresh`
  with shared `reasoner`
- Update the solutions doc: add `status: resolved YYYY-MM-DD`, replace the open investigation
  note with the confirmed root cause and fix mechanism

**Test scenarios:**
- Happy path: regression test passes (≥1 owl:sameAs triple from shared reasoner at call N)
- Happy path: sameAs test passes with shared reasoner (no fresh instance)
- Happy path: data property test passes with shared reasoner
- No-regression: all 198 tests still pass; 0 expected fails (all it.fails removed)

**Verification:**
- `npm test` shows **199/199 pass**, 0 expected fails
- `npx vitest run tests/integration/abox-realization.test.ts` shows 7/7 pass

## System-Wide Impact

- **Affected surface:** `CBackendRepresentativeMemoryCache::installDeterministicSameAsAssociationUpdates`
  and/or `installAssociationUpdates` — individual-association write path only
- **Unchanged invariants:** public TypeScript API (`materialize`, `classify`, `checkConsistency`,
  `classifyProperties`), WASM binary interface, wire format, npm package API all unchanged
- **Singleton manager pattern:** not changed — fix is within BackendAssCache processing
- **Thread lifecycle:** STPU, ReasonerManagerThread, BackendAssCache thread all unchanged
- **Memory growth:** `mOntoClassifierHash` and `mOntoPrecomputatorHash` still accumulate entries
  per ontology (singleton objects, no deletion) — memory growth is bounded by call count, not fixed

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Diagnostic patch context doesn't apply cleanly | Generate patch against exact current vendor state using `git -C vendor/konclude diff HEAD` |
| Fix changes BackendAssCache behavior for non-sameAs paths | Unit 3 verification covers 198+ tests; add targeted boundary tests in Unit 3 |
| Singleton classifier causes additional correctness issues | Confirm Unit 3 fix passes broader n-pattern sweep (n=0..8) before promoting in Unit 4 |
| `mConfInterpretUnchangedLabelsAsCompatible=true` causes incorrect results | Test with existing consistency and issue#13 test suite before declaring Unit 3 done |

## Sources & References

- Symptom documentation: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
- Threading fix context: commit `7d8d718` (plan-029 threading fix)
- Cache write path: `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp` lines 1257–1340, 2674–2695
- Stat log: same file line 3909
- Regression test: `tests/integration/abox-realization.test.ts` lines 198–234
- Existing patch format: `patches/011-once-fire-callback.patch`
