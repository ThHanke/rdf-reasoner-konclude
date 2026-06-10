---
title: "fix: BackendAssCache per-call isolation and FP/IFP sameAs C++ migration"
type: fix
status: active
date: 2026-06-05
depends_on: docs/plans/2026-06-05-043-fix-alif-plus-precomp-deadlock-plan.md
---

# fix: BackendAssCache per-call isolation and FP/IFP sameAs C++ migration

## Overview

Two related improvements to `KoncludeReasoner`:

1. **State isolation**: The BackendAssCache (`CBackendRepresentativeMemoryCache`) accumulates
   per-ontology entries in `mFixedOntologyIdentifierDataHash` that are never evicted. After a
   specific call sequence (ABox materialize × 2 → TBox classify → ABox materialize with sameAs
   expected), the stale entries corrupt the sameAs detection path and silently return zero triples
   (the n=3 bug). Fix: flush cache entries for the evicted ontology ID at the moment the ontology
   is deleted in `Impl::reset()`.

2. **FP/IFP sameAs in C++**: The `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` sameAs
   computation currently lives in TypeScript (`ts/index.ts`). Moving it to `src/KoncludeReasoner.cpp`
   eliminates the TypeScript workaround code, covers the `_materializeInline()` gap (used by
   `isEntailed()` / `whatIf()`), and keeps the inference logic co-located with the triple
   serialization layer where it belongs.

Both fixes require one WASM rebuild and leave the public TypeScript API unchanged.

**Sequencing note:** Unit 2 (FP/IFP C++ migration) and Unit 3 (remove JS workaround) depend on
plan-043 (ALIF+ deadlock fix) landing first. Unit 1 (BackendAssCache) is independent and can
land any time. Do not execute Units 2–3 until plan-043 is complete and FP 1-filler passes in
WASM.

## Problem Frame

**n=3 BackendAssCache corruption:** `mFixedOntologyIdentifierDataHash` is a `QHash<cint64, ...>`
inside `CBackendRepresentativeMemoryCache` that stores completed realization data keyed by ontology
ID. It is a manager-thread singleton that persists across calls; entries for prior ontologies are
never removed. After a sequence involving `NEIGHBOUR_INSTANTIATED_ROLE_SET_COMBINATION_LABEL`
writes from ABox calls followed by a TBox classify, the `mSlotUpdateWaitingIncreaseCount` state
and stale hash entries interact to corrupt `DeterministicMergedSameConsideredLabelCacheEntry` for
the next ABox realization. The symptom: `owl:sameAs` triples silently disappear from results.
Current workaround: allocate a fresh `RdfReasoner` per test that expects sameAs, documented in
four tests. Root-cause analysis in
`docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`.

**FP/IFP in TypeScript:** The ALIF+ precomputing deadlock (native Konclude v0.7.0 bug, WASM makes
it worse) prevents passing `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` declarations
through the Konclude reasoning kernel when the ABox contains multiple fillers. The current fix
(plan-041, commit `66c5584`) strips the declarations before calling WASM and computes sameAs in
TypeScript. This logic belongs in the C++ wrapper layer, not in the TypeScript API layer: it is a
semantic inference that all entry points (`_materializeOnStore`, `_materializeOnQuads`,
`_materializeInline`) should share — but `_materializeInline` (used by `isEntailed()` / `whatIf()`)
was not covered by the TypeScript fix.

## Requirements Trace

- R1. After any sequence of reasoning calls on a shared `RdfReasoner` instance, `owl:sameAs`
  triples that were correct on the first call are still emitted correctly on subsequent calls
  without requiring a fresh instance
- R2. `isEntailed()` and `whatIf()` with FP/IFP multi-filler ontologies produce sameAs results
  (currently a gap)
- R3. All 322 currently-passing tests continue to pass after each fix unit
- R4. A new shared-instance regression test for the n=3 sequence is written and passes; the
  existing fresh-instance FP/IFP and NPA tests are audited and converted to shared-instance
  where the fresh instance was solely a workaround for the BackendAssCache bug
- R5. No change to the public TypeScript API surface (`RdfReasoner`, `ReasoningOptions`,
  `ReasoningResult`)

## Scope Boundaries

- The ALIF+ precomputing deadlock in `CTotallyPrecomputationThread` is NOT fixed here — the C++
  migration keeps the same strip-before-WASM approach, just in a different layer
- `mCompConsCache` and `mOccStatsCache` accumulation is not addressed — those have not been
  observed to cause failures; scope to BackendAssCache only
- No changes to the public npm package API

### Deferred to Separate Tasks

- Fixing the root ALIF+ precomputing deadlock: handled in plan-043 (prerequisite for Units 2–3)
- `mOntologyIdentifierDataHash` (dynamic CCACHINGHASH) flush: deferred unless Unit 1 n=3
  regression test still fails after flushing `mFixedOntologyIdentifierDataHash` only

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` — `Impl::reset()` (ontology rotation + stopAndClearRealizers),
  `WasmReasonerManagerThread::threadStopped()` (owns mBackendAssCache lifetime),
  `loadTripleBuffer()` (binary buffer → librdf model), `buildInferredTripleBuffer()` (WASM results
  → binary wire format, contains existing `emitTriple` + `InternTable` + dedup pattern)
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.h/.cpp` —
  `mFixedOntologyIdentifierDataHash` (QHash, never evicted),
  `installAssociationUpdates()`, `completeDeterministicSameAsMergingInformation()` — target functions
  for the flush call
- `ts/index.ts` — `_materializeOnStore()` FP/IFP block (lines ~782–891),
  `_materializeOnQuads()` FP/IFP block (lines ~938–1098), `_materializeInline()` (gap — no FP/IFP
  handling)
- `patches/030-saturation-clash-combined.patch` — patch structure and placement pattern
- `patches/032-precomp-verbose-logging.patch` — `#ifdef WASM_PRECOMP_VERBOSE` guard pattern for
  any diagnostic instrumentation added

### Institutional Learnings

- `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md` —
  full n=3 failure trace; `mFixedOntologyIdentifierDataHash` and
  `completeDeterministicSameAsMergingInformation` identified as the write-failure site; confirms
  `mOntologyIdentifierDataHash` (dynamic) is less likely to be the culprit
- Memory `project_ontology_lifetime_singleton_cache.md` — two-cycle ontology lifetime guarantee;
  `mPreviousPreviousOntology` must remain alive for 2 full cycles to prevent pointer-recycling hits
  in singleton thread `mOntItemHash` caches; the flush must happen at deletion time, not earlier
- Memory `project_realization_classify_dependency.md` — `stopAndClearRealizers()` must be called
  BEFORE `delete mPreviousPreviousOntology` in every reset path
- Memory `project_sequential_call_fix.md` — `waitSynchronization()` barrier must be respected;
  any new Manager-targeted events for cleanup must be posted before the barrier, not after
- `docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md` — confirms
  Fixture A (1 filler FP) hangs in WASM before `before-while`; WASM is worse than native; the
  strip-before-WASM approach is the only viable path for now

## Key Technical Decisions

- **Flush at deletion time, not at reset entry**: Flush `mFixedOntologyIdentifierDataHash` for
  `mPreviousPreviousOntology->getOntologyID()` immediately before `delete mPreviousPreviousOntology`
  in `Impl::reset()`. This preserves the two-cycle lifetime (pointer-recycling safety) while
  preventing unlimited accumulation. The oldest ontology's entries are gone by the time the third
  call completes.

- **Method on WasmReasonerManagerThread, not direct access**: Add
  `flushBackendCacheForOntology(cint64)` to `WasmReasonerManagerThread` (in `src/KoncludeReasoner.cpp`)
  and a corresponding `clearOntologyData(cint64)` method to `CBackendRepresentativeMemoryCache`
  (via a new patch). The `clearOntologyData()` patch must: (1) acquire
  `mFixedOntologyIdentifierDataHashLock.lockForWrite()`, (2) fetch the `OntologyData` pointer,
  (3) call `decUsageCount()` + check zero + release memory pools + delete if zero (matching the
  existing deletion protocol at lines 485–494 of `CBackendRepresentativeMemoryCache.cpp`),
  (4) call `mFixedOntologyIdentifierDataHash.remove(id)`, (5) unlock. A bare `QHash::remove()`
  without this protocol leaks the `OntologyData` allocation.

- **FP/IFP detection in `loadTripleBuffer()`, emission in `buildInferredTripleBuffer()`**: The
  input triples (from the binary buffer) are available during load; the `InternTable` + `emitTriple`
  pattern is available during build. Store detected sameAs pairs as `Impl` member fields between
  the two calls. This mirrors the existing data flow for ABox data: loaded into the ontology model
  by `loadTripleBuffer`, serialized out by `buildInferredTripleBuffer`.

- **Strip FP/IFP declarations when multi-filler detected (keep existing semantics)**: Only strip
  `?prop rdf:type owl:FunctionalProperty` / `InverseFunctionalProperty` triples for properties
  that have 2+ fillers/subjects — same selective logic as the TypeScript workaround. Single-filler
  FP/IFP triples are still passed to the reasoner (they do not trigger the ALIF+ hang).

- **Vendor patch for `clearOntologyData`**: The BackendAssCache is in vendor code. Add
  `patches/033-backendasscache-per-call-flush.patch` rather than a full override — the change is
  a small method addition.

## Implementation Units

---

- [ ] **Unit 1: Patch BackendAssCache and call per-ontology flush in Impl::reset()**

**Goal:** Flush `mFixedOntologyIdentifierDataHash` entries for the expiring ontology ID at the
start of each `Impl::reset()`, eliminating stale-cache-induced sameAs failures across sequential
calls.

**Requirements:** R1, R3, R4.

**Dependencies:** None.

**Files:**
- Create: `patches/033-backendasscache-per-call-flush.patch`
- Modify: `src/KoncludeReasoner.cpp` — `WasmReasonerManagerThread::flushBackendCacheForOntology()` (new method) + `Impl::reset()` flush call
- Modify: `tests/integration/owl2dl-parity.test.ts` — convert `it.fails` regression test to passing `it(` test; remove fresh-instance isolation from the 2 NPA and FP tests that used `new RdfReasoner()` only to avoid this bug (verify each — some fresh instances may serve other purposes)
- Modify: `tests/integration/property-characteristics.test.ts` — same fresh-instance audit

**Approach:**
- Apply all patches: `rm -f vendor/konclude/.patches-applied && bash scripts/apply-patches.sh`
- In `CBackendRepresentativeMemoryCache.cpp/.h`: add `clearOntologyData(cint64 ontologyId)` that
  calls `mFixedOntologyIdentifierDataHash.remove(ontologyId)` (and
  `mOntologyIdentifierDataHash.remove(ontologyId)` if the dynamic hash has a compatible remove
  API — check at implementation time; if not, defer)
- Generate patch: `git -C vendor/konclude diff > patches/033-backendasscache-per-call-flush.patch`
- In `src/KoncludeReasoner.cpp`, `WasmReasonerManagerThread`: add
  `flushBackendCacheForOntology(cint64 id)` that calls `mBackendAssCache->clearOntologyData(id)`
  if `mBackendAssCache` is non-null
- In `Impl::reset()`, before the existing `delete mPreviousPreviousOntology` (or the equivalent
  rotation that frees the oldest slot): capture the ID, call
  `mReasonerManager->flushBackendCacheForOntology(id)`
- Rebuild WASM: `rm -f vendor/konclude/.patches-applied && docker compose run --rm build`;
  `npm run patch-wasm && npm run build`
- Write a new shared-instance regression test for the n=3 sequence: use the module-level
  `reasoner` in `tests/integration/abox-realization.test.ts` (NOT a fresh instance), run
  `materialize(ABox alice knows bob)` × 2 → `classify(TBox)` → `materialize(sameAs ABox)` and
  assert `eve owl:sameAs carol` is present on the 5th call. This is the passing criterion.
- Audit existing fresh-instance tests in FP/IFP and NPA suites; remove fresh-instance isolation
  only where the fresh instance was added solely to avoid the BackendAssCache bug

**Test scenarios:**
- Happy path: n=3 sequence — `materialize(ABox with alice knows bob)` × 2 → `classify(TBox)` →
  `materialize(sameAs ABox)` on same shared `reasoner` instance → `eve owl:sameAs carol` emitted
  correctly on the 5th call (the new shared-instance regression test)
- Happy path: single `materialize()` with sameAs on shared instance → still works
- Happy path: 10 sequential `materialize()` calls on shared instance → no degradation
- Edge case: first call (no `mPreviousPreviousOntology`) → flush is a no-op, no crash
- Regression: pointer-recycling fix (N>5 calls, RC1/RC2 guards) — sequential calls still return
  correct results
- Regression: all 322 currently-passing tests pass after WASM rebuild

**Verification:**
- `npm test` shows 323+ passing (new shared-instance n=3 regression test adds 1), 2 skipped
- New shared-instance test exists in `abox-realization.test.ts` and passes
- Fresh-instance workarounds that were solely for the BackendAssCache bug are removed

---

- [ ] **Unit 2: Move FP/IFP strip and sameAs detection to C++ in KoncludeReasoner**

**Goal:** Implement FP/IFP sameAs inference entirely in `src/KoncludeReasoner.cpp`, covering all
three materialize entry points including `_materializeInline()`.

**Requirements:** R2, R3.

**Dependencies:** plan-043 (ALIF+ deadlock fix landed; FP 1-filler passes in WASM).

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `loadTripleBuffer()` (detect FP/IFP, store sameAs pairs,
  skip FP/IFP declarations from librdf model), `buildInferredTripleBuffer()` (emit stored sameAs
  pairs), new `Impl` fields for the intermediate data
- Modify: `src/KoncludeReasoner.h` — add Impl field declarations if Impl is declared in header

**Approach:**
- In `loadTripleBuffer()`, during the triple-insertion loop over the binary buffer: recognize
  `owl:FunctionalProperty` and `owl:InverseFunctionalProperty` predicate IRIs; skip those
  declaration triples from `librdf_model_add_statement` and separately accumulate
  property→fillers maps for FP (keyed by subject IRI) and IFP (keyed by object IRI). After the
  FULL loop completes (triple order is not guaranteed — FP declaration may come after ABox
  assertions), scan the maps: for each property with 2+ named-node fillers compute pairwise
  sameAs string pairs and store in `mImpl->mFpIfpSameAsPairs`. For the 1-filler case (plan-043
  fix enables reasoning), no pairs are computed and the declaration IS stripped — so WASM
  reasons normally without the ALIF+ path triggering. For the 2-filler case (still a native
  upstream bug), pairs are pre-computed in C++ and WASM gets the stripped ontology.
- In `buildInferredTripleBuffer()`, after the existing `owl:sameAs` section, iterate
  `mImpl->mFpIfpSameAsPairs` and emit both directions using the existing
  `emitTriple(intern.intern(a), pSameAs, intern.intern(b))` + dedup pattern; clear
  `mFpIfpSameAsPairs` after emission
- The string IRIs of `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` / `owl:sameAs` can
  be defined as file-local `constexpr` constants in `src/KoncludeReasoner.cpp` alongside the
  existing IRI constants
- `mFpIfpSameAsPairs` must be cleared in `Impl::reset()` alongside `mResultBuffer` to prevent
  stale pairs from a previous call appearing in the next

**Patterns to follow:**
- `buildInferredTripleBuffer()` `owl:sameAs` block — existing `emitTriple` + dedup pattern
- `loadTripleBuffer()` — existing triple-insertion loop structure
- `ts/index.ts` FP/IFP blocks — exact detection logic to replicate; only named-node subjects/objects
  participate in sameAs (blank nodes excluded). Blank nodes in the binary buffer intern table use
  `_:` prefix — check the IRI string prefix at the C++ layer to replicate the TS `termType ===
  'NamedNode'` guard.

**Test scenarios:**
- Happy path FP: `alice hasMother eve` + `alice hasMother carol` + `hasMother FP` →
  `eve owl:sameAs carol` AND `carol owl:sameAs eve` in output (bidirectional)
- Happy path IFP: `alice hasDNA seq1` + `bob hasDNA seq1` + `hasDNA IFP` →
  `alice owl:sameAs bob` AND `bob owl:sameAs alice` in output (bidirectional)
- Happy path single filler: `alice hasMother eve` + `hasMother FP` (no second filler) →
  no sameAs emitted, no hang
- Edge case blank node: FP with one named-node object and one blank-node object → named-node/bnode
  pair does NOT produce sameAs (OWL sameAs applies to named individuals only)
- Integration: `isEntailed(fpQuads, sameAsTriple)` where `fpQuads` has FP + 2 fillers → returns
  `true` (previously a gap — `_materializeInline` was uncovered)
- Integration: `whatIf(fpQuads, additionalQuad)` → does not hang
- Regression: all 5 FP/IFP tests activated in plan-041 still pass
- Regression: Roberts-family test (uses `hasMother` FP with 1 filler) — no sameAs emitted, no
  regression in class-membership results

**Verification:**
- `npm test` passes with same or higher count as after Unit 1
- `isEntailed()` and `whatIf()` tests with FP/IFP multi-filler input pass

---

- [ ] **Unit 3: Remove JS FP/IFP workaround from ts/index.ts**

**Goal:** Delete the FP/IFP detection and sameAs computation code from TypeScript now that C++
handles it.

**Requirements:** R3, R5.

**Dependencies:** Unit 2 (C++ path verified working).

**Files:**
- Modify: `ts/index.ts` — remove FP/IFP detection blocks from `_materializeOnStore()` and
  `_materializeOnQuads()`; remove `OWL_FUNCTIONAL_PROPERTY`, `OWL_INVERSE_FUNCTIONAL_PROPERTY`
  constants if unused elsewhere; keep `OWL_SAME_AS` if still needed by other code
- Test: `tests/integration/owl2dl-parity.test.ts` — no changes expected; all FP/IFP tests should
  pass unchanged via C++ path
- Test: `tests/integration/property-characteristics.test.ts` — same

**Approach:**
- Delete the FP/IFP detection and stripping blocks in both `_materializeOnStore()` and
  `_materializeOnQuads()` (identified by `fpProps`, `ifpProps`, `fpPropsToStrip`,
  `ifpPropsToStrip`, `fpSameAsQuads`, `ifpSameAsQuads` variable names)
- Run `npm run build` (TypeScript only, no WASM rebuild) — verify no TS errors
- Run `npm test` — all FP/IFP tests must still pass

**Test scenarios:**
- Regression: all 5 FP/IFP tests activated in plan-041 pass via C++ path
- Regression: all 322 currently-passing tests pass
- No behavioral change — this unit is pure deletion

**Verification:**
- `npm run build` succeeds with no TypeScript errors
- `npm test` shows same passing count as after Unit 2
- `git diff ts/index.ts` shows only deletions in the FP/IFP blocks

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not code
> to reproduce.*

**Unit 1 — flush timeline across three calls:**

```
Call 1 (materialize ABox):
  reset() →  mPrevPrev=null, mPrev=null, mOnt=new(id=A)
  … reasoning …
  BackendAssCache: { A: {...NEIGHBOUR_ROLE entries...} }

Call 2 (materialize ABox):
  reset() →  flush(null=no-op); mPrevPrev=null; mPrev=A; mOnt=new(id=B)
  … reasoning …
  BackendAssCache: { A: {…}, B: {…} }

Call 3 (classify TBox):
  reset() →  flush(null=no-op); mPrevPrev=A; mPrev=B; mOnt=new(id=C)
  … reasoning …
  BackendAssCache: { A: {…}, B: {…}, C: {…} }

Call 4 (materialize with sameAs):
  reset() →  flush(id=A) ← evicts stale entries; delete A
             mPrevPrev=B; mPrev=C; mOnt=new(id=D)
  BackendAssCache: { B: {…}, C: {…} }   ← A is gone
  … reasoning → sameAs detected correctly ✓
```

**Unit 2 — data flow across load/build boundary:**

```
loadTripleBuffer(buf):
  scan triples → detect FP/IFP multi-filler patterns
  → Impl.mFpIfpSameAsPairs = [(iriA, iriB), (iriB, iriA), ...]
  → skip FP/IFP declaration triples from librdf model (no ALIF+ hang)

  Konclude reasoning (no FP/IFP visible → no ALIF+ → completes)

buildInferredTripleBuffer():
  emitTriple(WASM sameAs results...)
  for each (a, b) in Impl.mFpIfpSameAsPairs:
    emitTriple(intern(a), pSameAs, intern(b))  ← dedup applies
  clear mFpIfpSameAsPairs

Impl::reset():
  mFpIfpSameAsPairs.clear()  ← guard: no stale pairs from prior call
```

## System-Wide Impact

- **`_materializeInline()`**: Covered by Unit 2 automatically — it calls `loadTripleBuffer()` +
  `buildInferredTripleBuffer()`. No TypeScript change needed.
- **`classifyProperties()` / `checkConsistency()`**: Not affected — neither calls
  `buildInferredTripleBuffer()` (property path) or involves realization state.
- **`mPreviousPreviousOntology` lifetime**: Unit 1 flush happens at deletion time, not earlier —
  the two-cycle pointer-recycling guarantee is preserved.
- **Thread safety of flush**: `flushBackendCacheForOntology()` is called from `Impl::reset()`,
  which runs on the JS/WASM main thread. `CBackendRepresentativeMemoryCache` internal methods
  may use locks; verify at implementation time that `clearOntologyData()` is safe to call from
  outside the manager thread. If locking is required, post a cleanup event to the manager thread
  before `waitSynchronization()` instead.
- **`mFpIfpSameAsPairs` lifetime**: Must be cleared in both `buildInferredTripleBuffer()` (after
  emission) and `Impl::reset()` (in case build is never called, e.g., after an error). Double-clear
  is harmless on an empty vector.
- **`mCompConsCache` / `mOccStatsCache`**: Not touched. Their accumulation is not observed to cause
  failures; out of scope.
- **Unchanged invariants**: Public TypeScript API (`RdfReasoner`, `ReasoningOptions`,
  `ReasoningResult`) is unchanged. Wire format is unchanged. No npm package API surface changes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `CBackendRepresentativeMemoryCache::clearOntologyData()` races with manager-thread cache writes | Verify locking model; if not safe to call cross-thread, route flush via a manager event posted before `waitSynchronization()` |
| `mOntologyIdentifierDataHash` (dynamic CCACHINGHASH) also accumulates entries that contribute to the n=3 bug | Unit 1 `it.fails` test is authoritative; if it still fails after flushing only the fixed hash, add `mOntologyIdentifierDataHash` to the flush as well |
| WASM rebuild takes 20–30 min | Units 1 and 2 can share a single WASM build if developed sequentially in the same Docker session |
| Flushing the wrong ontology ID corrupts a live realization | Flush only happens for `mPreviousPreviousOntology`, which is already 2 calls old and whose thread callbacks have completed |
| `_materializeInline` FP/IFP coverage (Unit 2) is not tested by existing tests | Add an `isEntailed()` test with FP multi-filler as a new scenario in Unit 2 |

## Sources & References

- Root-cause doc: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
- ALIF+ hang investigation: `docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md`
- Plan-041 (FP/IFP JS workaround): `docs/plans/2026-06-04-041-fix-upstream-limitation-parity-recheck-plan.md`
- Memory: `project_ontology_lifetime_singleton_cache.md`, `project_sequential_call_fix.md`,
  `project_realization_classify_dependency.md`
- Patch pattern: `patches/030-saturation-clash-combined.patch`
- C++ serialization pattern: `src/KoncludeReasoner.cpp` `buildInferredTripleBuffer()`
