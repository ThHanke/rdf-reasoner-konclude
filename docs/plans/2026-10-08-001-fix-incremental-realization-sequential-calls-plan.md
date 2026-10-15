---
title: "fix: Incremental realization — sequential call crashes, hangs, and true reuse"
type: fix
status: active
date: 2026-10-08
---

# fix: Incremental realization — sequential call crashes, hangs, and true reuse

## Overview

Sequential calls on a shared `KoncludeReasoner` crash at call 4 (native) or hang at call 7
(WASM) due to two interlocked bugs. Additionally, every call re-classifies the TBox from
scratch even when the ontology is identical to the prior call. This plan fixes the crashes and
hangs in **Phase A** (shippable independently), then builds toward true TBox-aware incremental
realization in **Phase B** (separate follow-on once Phase A is validated). The native debug
pipeline (`build-native/konclude_debug` + state dump JSON) proves each fix at each step.

**Phase A ships alone.** Phase B begins only after Phase A produces green 565/565 WASM tests.

## Problem Frame

`docs/solutions/debugging/sequential-call-object-lifecycle.md` documents root causes from
GDB core dump + state dumps:

1. **Upstream KPSet iterator bug** (`COptimizedKPSetClassSubsumptionClassifierThread.cpp:2078`):
   Drain loop of `flushPendingInitMessages()` reads `itDownPoss.value()` (past-end) instead
   of `itPoss.value()`. SIGSEGV at call 4 whenever second realization follows first realization.

2. **Stale processing sets** (`CReasonerManagerThread::mProcessingEndMessageSet` /
   `mProcessingStartMessageSet`): grow +5–6 entries per call, never cleared across `reset()`.
   Mimalloc pointer reuse causes stale entry match → completion callback suppressed →
   `waitSynchronization()` hangs. (WASM call 7; native crashes first via UB at call 4.)

3. **No TBox reuse**: after both bugs are fixed, every `realization()` still re-runs the full
   KPSet classifier regardless of whether the TBox changed.

## Requirements Trace

**Phase A:**
- R1. `build-native/konclude_debug tests/fixtures` completes all 8 calls without crash or hang
- R2. State dumps show `processing_end_set_size = 0` after every `after-reset` phase
- R3. 565/565 WASM tests pass after Phase A patches

**Phase B:**
- R4. Second realization with identical TBox skips classification stage (proven via state
  dump: `processing_end_set_size` grows by 1 not 6 for same-TBox calls)
- R5. Inferred triples from skip-classify call are identical to full-classify call (correctness)
- R6. Debug pipeline timing shows call 4 faster than call 3 when TBox unchanged

## Scope Boundaries

- No change to public TypeScript `RdfReasoner` API
- BackendAssCache Update1→Update2 ordering must remain intact (INV-5)
- ABox delta tracking (only re-realizing changed individuals) is out of scope
- `mSatExpCache` / `mSatNodeExpCache` remain disabled

### Deferred to Separate Tasks

- sameAs n=3 corruption — separate plan
- Browser pthread deadlock / `PROXY_TO_PTHREAD` — separate issue

## Context & Research

### Relevant Code

- `src/KoncludeReasoner.cpp` — `Impl::reset()` (525–558), `runPipeline()` (2023),
  `WasmReasonerManagerThread::debugProcessingSetSizes()` (202–205), `dumpState()` (3679–3713)
- `vendor/konclude/Source/Reasoner/Kernel/Manager/CReasonerManagerThread.cpp` lines 465–630 —
  `continueRequirementProcessing()`; processing sets populated here; line 673 is patch-009
  insertion point
- `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`
  lines 2050–2090 — crash site (`flushPendingInitMessages` drain loop)
- `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.h` lines 131–134 —
  `ontItemHash` keyed on `{CConcreteOntology*, callGeneration}` (safe from pointer reuse)
- `patches/009-processing-set-clear.patch` — 2-line fix, currently disabled
- `patches/010-kpset-counter-fix.patch` — existing untracked patch (counter reset in
  `scheduleOntologyClassification()`), touches same file as Unit 1's fix at **different lines**;
  drain-loop fix must be numbered **011+** to avoid conflict
- `native/CMakeLists.txt` — missing `vendor/konclude/Source/Concurrent/Events/*.cpp` glob

### Institutional Learnings

- **ID-GUARD pattern**: `ontItemHash` already uses `{ptr, callGeneration}` composite key —
  do not break this invariant when implementing Phase B item reuse
- **BackendAssCache INV-5**: never reset per-ontology BackendAssCache state between
  precomputer and realizer within a single `prepareOntology()` call
- **Patch-009 regression history**: prior regression came from `clearAllLinkedReaders` in a
  different patch, not from patch-009's 2-line change itself — safe to re-enable
- **Konclude lifecycle paradigm**: "keep while valid, free on change" — this is the exact
  principle behind Phase B (keep class hierarchy while TBox valid, free realization items)

## Key Technical Decisions

**Phase A:**
- Fix line 2078 before re-enabling patch-009: crash masks hang; call 7 never reached if
  call 4 crashes. Fix in order: crash first, then hang.
- Patch-009 insertion point stays at `continueRequirementProcessing()`: clearing in `reset()`
  would race with still-in-flight events from the prior pipeline. Safe because manager thread
  owns both read and write of these sets.
- Drain-loop patch is **011** (not 009 or 010): patch-009 = processing-set-clear already
  exists; patch-010 = kpset-counter-fix already exists as untracked file. Numbering must not
  collide.

**Phase B:**
- **TBox fingerprint = hash of raw NTriples input string** (not concept+role count): concept
  and role *counts* can match two different TBoxes (e.g., changing a domain restriction
  without adding/removing a concept). A hash collision on counts would produce silently wrong
  inferences with no diagnostic. NTriples string hash has collision probability ~2^-64 and
  is computed once from the already-in-memory input buffer.
- **COntologyClassificationItem reuse via `Impl::mCachedClassItem`**: `ontItemHash` is keyed
  by `{CConcreteOntology*, callGeneration}`. After `reset()`, the new call has a different
  ontology pointer, so the prior item's key no longer matches. Fix: when `mTBoxSameAsPrev=true`,
  store a raw pointer to the prior call's item in `Impl::mCachedClassItem` before `reset()`
  rotates the ontology. On skip-classify path, pass `mCachedClassItem` directly to the
  realizer stage without re-running `scheduleOntologyClassification()`.
- **Skip-classify mechanism = early return in `scheduleOntologyClassification()`**: rather than
  not posting the classify event (which risks changing `waitSynchronization()` semantics), make
  the scheduler detect the skip flag and return the cached item immediately. This keeps the
  event/sync protocol unchanged.
- **`waitSynchronization()` semantics must be confirmed** before Phase B implementation: the
  manager thread processes a FIFO event queue; the sync event is processed after all prior
  events. If classify is skipped, no classify-complete event is ever posted — the manager
  simply processes the sync event immediately after the realize events. This should work, but
  confirm by reading `CReasonerManagerThread::processCustomsEvents` to verify no fixed-count
  "wait for N completions" logic exists.

## Open Questions

### Resolved During Planning

- **`ontItemHash` false-hit risk from pointer reuse?** Protected by `callGeneration` composite
  key — no false hits even if pointers collide.
- **Was patch-009 regression caused by patch-009?** No — separate patch (`clearAllLinkedReaders`)
  was the cause. Patch-009's 2-line change is safe.
- **Does patch 010 conflict with the drain-loop fix?** Patch 010 modifies line 151 of
  `COptimizedKPSetClassSubsumptionClassifierThread.cpp`; drain-loop fix targets line 2078.
  Different functions, no conflict. But numbering must not reuse 010.

### Deferred to Implementation (Phase B)

- **`waitSynchronization()` count semantics**: read `processCustomsEvents` in
  `CReasonerManagerThread` to confirm no fixed-count wait before implementing skip-classify.
- **`Impl::mCachedClassItem` lifetime**: the prior item is deleted by `mStaleClassItems` at
  the next `scheduleOntologyClassification()`. Since skip-classify bypasses `schedule...()`,
  the stale item is never cleaned. Add explicit cleanup in `reset()` when `mTBoxSameAsPrev`
  transitions from `true` to `false`.
- **Realizer entry point for cached item**: confirm which method the realizer calls to obtain
  the `COntologyClassificationItem` and whether passing `mCachedClassItem` directly is
  sufficient or requires a registration step.

## High-Level Technical Design

> *Directional guidance, not implementation specification.*

```
── Phase A: sequential call safety ──────────────────────────────────────

reset()
  → clear per-call flags; rotate ontology
  [mProcessingEndMessageSet NOT cleared here — cleared in continueRequirementProcessing]

prepareOntology() → continueRequirementProcessing():
  mProcessingEndMessageSet.clear()   ← patch-009
  mProcessingStartMessageSet.clear() ← patch-009
  classify → flushPendingInitMessages():
    drain loop: possData = itPoss.value()  ← patch-011 (was itDownPoss)
  realize → ...
  waitSynchronization() ← resolves correctly (FIFO queue, sync event last)

State proof after Phase A:
  after-reset:   processing_end_set_size = 0  (patch-009)
  after-reason:  processing_end_set_size = 5-6  (normal)
  all 8 calls complete without crash or hang

── Phase B: incremental realization ─────────────────────────────────────

loadNTriples(input):
  hash(input) → mCurrentTBoxHash
  mTBoxSameAsPrev = (mCurrentTBoxHash == mPrevTBoxHash)
  if mTBoxSameAsPrev: mCachedClassItem = <prior call's COntologyClassificationItem*>
  update mPrevTBoxHash

realization() → runPipeline(skipClassify = mTBoxSameAsPrev):
  if skipClassify:
    scheduleOntologyClassification() returns mCachedClassItem immediately (no event posted)
  realize against class hierarchy (from BackendAssCache, populated by prior classify)

State proof after Phase B:
  after-reason (same TBox): processing_end_set_size = 1 (realizer only)
  after-reason (TBox changed): processing_end_set_size = 6 (full pipeline)
  inferred triples: identical for same-TBox calls (correctness check)
```

---

## PHASE A — Bug Fixes (ship independently)

- [ ] **Unit 1: Fix native build link failure (unblock debug pipeline)**

**Goal:** Restore `build-native/konclude_debug` binary. Currently fails to link due to missing
`Concurrent/Events/*.cpp` source files.

**Requirements:** R1 (native pipeline must work to verify Units 2+3)

**Dependencies:** None

**Files:**
- Modify: `native/CMakeLists.txt`

**Approach:**
- `Concurrent/Events/` contains `CCustomEvent.cpp`, `CCustomCallbackEvent.cpp` etc. which are
  not included in any glob. Add `file(GLOB CONC_EV_SOURCES ".../Concurrent/Events/*.cpp")` and
  append to `KERNEL_SOURCES`, matching the existing `CONC_CB_SOURCES` pattern.
- Verify `Source/Concurrent/Callback/*.cpp` is already included (has dedicated `CONC_CB_SOURCES`
  glob + append).

**Test scenarios:**
- `cmake --build build-native -j4` exits 0
- `ls -lh build-native/konclude_debug` shows binary ≥ 200 MB

**Verification:**
- Binary exists and runs: `./build-native/konclude_debug --help 2>&1 | head -1` doesn't segfault

---

- [ ] **Unit 2: Fix upstream KPSet drain-loop iterator bug (crash at call 4)**

**Goal:** Eliminate SIGSEGV at call 4 — second realization after a first realization that
changed the class hierarchy.

**Requirements:** R1

**Dependencies:** Unit 1 (binary must build to test)

**Files:**
- Create mod script: `scripts/mod_011_kpset_drain_loop_fix.py`
- Create patch: `patches/011-kpset-drain-loop-fix.patch`
- Modify: `patches/ENABLED` (add `011`)

**Approach:**
- In `flushPendingInitMessages()`, trailing drain loop (lines 2077–2090): change line 2078
  from `itDownPoss.value()` to `itPoss.value()`.
- Patch number **011** — patches 009 (processing-set-clear) and 010 (kpset-counter-fix) are
  already claimed. Patch 011 must go after 010 in `patches/ENABLED`.
- The mod script targets only the `while (itPoss != itPossEnd)` block after the merge loop.
  Use surrounding context (the `itDownPossEnd` comparison in the prior loop) to uniquely
  locate the edit site.
- Use `scripts/new-multi-file-patch.sh` (mandatory for all vendor patches).

**Patterns to follow:**
- `patches/008-kpset-classifier.patch` as style reference
- `scripts/mod_009_processing_set_clear.py` as mod script template

**Test scenarios:**
- Happy path: `./build-native/konclude_debug tests/fixtures` reaches at least call 5 without
  SIGSEGV. File `/tmp/konclude-state-4-after-reason.json` is written.
- Expected partial hang: call 7 still times out (processing set bug not yet fixed) — watchdog
  prints queue-depth messages then aborts at 30s. This is expected and confirms crash is gone.
- GDB post-mortem on new core (if any): crash site must NOT be `flushPendingInitMessages:2078`.

**Verification:**
- `ls /tmp/konclude-state-4-after-reason.json` exists
- `grep -c "Segmentation\|SIGSEGV" /tmp/harness.log` = 0

---

- [ ] **Unit 3: Re-enable patch-009 (clear processing sets — fix call-7 hang)**

**Goal:** Eliminate `waitSynchronization()` hang at call 7 (WASM) / call 7+ watchdog abort
(native) by clearing stale `mProcessingEndMessageSet`/`mProcessingStartMessageSet` per pipeline.

**Requirements:** R1, R2

**Dependencies:** Unit 2 (crash gone — call 7 now reachable)

**Files:**
- Patch file: `patches/009-processing-set-clear.patch` (already exists, content confirmed correct)
- Modify: `patches/ENABLED` (re-enable `009`)

**Approach:**
- Patch-009 inserts 2 lines before `continueRequirementProcessing()` in
  `CReasonerManagerThread.cpp`. Verify the context in the patch file still matches after
  patches 001–011 have shifted line numbers — use `make reset-patches` and check for
  rejection errors.
- The patch must apply cleanly after 001–008 and 011 (009 is re-enabled; 010 kpset-counter
  is NOT yet in ENABLED — verify whether it should be, since it's an existing untracked patch
  with a related fix).

**Test scenarios:**
- Happy path: `./build-native/konclude_debug tests/fixtures 2>/tmp/harness.log` completes all
  8 calls. All 24 state dump files (`{1..8}-{after-reset,after-load,after-reason}`) exist.
- Processing set zeroed: `jq .processing_end_set_size /tmp/konclude-state-*-after-reset.json`
  all return `0`.
- Integration: full WASM suite — `npx vitest run --reporter=verbose 2>&1 > /tmp/vitest-full-output.txt`
  — 565/565 pass.

**Verification:**
- All 24 state dump files exist
- `jq -s 'map(.processing_end_set_size)' /tmp/konclude-state-*-after-reset.json` → all zeros
- `tail -5 /tmp/vitest-full-output.txt` shows 565 passed

---

- [ ] **Unit 4: State dump baseline — collect before/after evidence**

**Goal:** Run harness with patches 009+011, collect all 24 state dumps, produce diff table
proving both fixes work. This is the shippable evidence artifact for Phase A.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1, 2, 3

**Files:**
- Modify: `docs/solutions/debugging/sequential-call-object-lifecycle.md` — add "After fix"
  section with state dump table and timing per call

**Approach:**
- Run `./build-native/konclude_debug tests/fixtures 2>/tmp/harness-fixed.log`
- Extract per-call table: `jq -s 'map({call:.reset_count, phase:.label, end_set:.processing_end_set_size, realizers:.stopped_realizer_count})' /tmp/konclude-state-*.json`
- Document timing from harness log (calls 3 vs 4 timing baseline for Phase B comparison)

**Test scenarios:**
- All 24 files contain valid JSON (`jq . /tmp/konclude-state-*.json | wc -l` > 0)
- `jq .processing_end_set_size /tmp/konclude-state-*-after-reset.json` → all `0`

**Verification:**
- Table added to analysis document with post-fix data
- No calls hang or crash

---

- [ ] **Unit 5: WASM build + full suite for Phase A**

**Goal:** Rebuild WASM with patches 009+011, run full test suite, confirm no regressions.

**Requirements:** R3

**Dependencies:** Units 1–4

**Files:**
- Rebuilt `dist/konclude.mjs`, `dist/konclude.wasm` (Docker artifacts)

**Approach:**
- `make reset-patches && make build-wasm` (Docker)
- `npm run patch-wasm` (mandatory post-build)
- `npx vitest run --reporter=verbose 2>&1 > /tmp/vitest-full-output.txt`

**Test scenarios:**
- 565/565 pass
- explanation-persistence tests pass (no 120s timeout — the call-7 hang is gone)
- No regressions in hierarchy-determinism, OWL 2 DL parity tests

**Verification:**
- `grep "FAIL" /tmp/vitest-full-output.txt` = empty
- `tail -5 /tmp/vitest-full-output.txt` shows 565 passed

---

## PHASE B — Incremental Realization (begins after Phase A is green)

> Phase B is a separate work session. It starts from the Phase A baseline with the debug
> pipeline fully operational.

- [ ] **Unit 6: Research `waitSynchronization()` semantics + COntologyClassificationItem lifetime**

**Goal:** Resolve the two open questions that block safe Phase B implementation: (a) whether
skip-classify changes `waitSynchronization()` behavior and (b) how to keep the cached
classification item alive and reachable.

**Requirements:** prerequisite for R4

**Dependencies:** Unit 3 (processing set fix must be in place — otherwise can't isolate behavior)

**Files:**
- Modify: `docs/plans/2026-10-08-001-...` — update Open Questions with confirmed answers
- No code changes

**Approach:**
- Read `CReasonerManagerThread::processCustomsEvents` (the event handler for the manager
  thread). Determine: does it track a counter of expected completion events, or is the event
  loop purely FIFO? If purely FIFO, posting a sync event after a skip-classify produces no
  hang (manager processes sync immediately after any realize events, without waiting for
  classify-complete that was never posted).
- Read `scheduleOntologyClassification()` entry/exit — what does it return and how does the
  realizer obtain it? Confirm `Impl::mCachedClassItem` stored before `reset()` stays valid
  through the next call (not deleted by `mStaleClassItems` cleanup, since `schedule...()` is
  not called on the skip path).
- Read `stopAndClearRealizers()` — confirm it does not touch classification items.

**Test scenarios:**
- Research output answers: "waitSynchronization() is FIFO, no fixed-count wait"
  OR "waitSynchronization() expects N completions — must use different skip mechanism"
- Research output answers: "mCachedClassItem stays live through next call" OR "needs explicit
  lifetime extension"

**Verification:**
- Open Questions section of this plan updated with confirmed answers
- No code written until answers are documented

---

- [ ] **Unit 7: TBox fingerprint detection**

**Goal:** Record and compare a TBox fingerprint across calls. When TBox is unchanged, set
`mTBoxSameAsPrev = true` and stash `mCachedClassItem`.

**Requirements:** R4

**Dependencies:** Unit 6

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `Impl` struct, `loadTripleBuffer()`, `dumpState()`

**Approach:**
- Add `uint64_t mPrevTBoxHash` to `Impl` (initialized to 0, invalid sentinel).
- In `loadTripleBuffer()`, after parsing NTriples, compute `std::hash<std::string>{}(ntriplesInput)`
  (or FNV-1a for speed). Compare with `mPrevTBoxHash`. Set `mTBoxSameAsPrev` and update
  `mPrevTBoxHash`.
- Add `tbox_same_as_prev` boolean to `dumpState()` JSON.
- On `mTBoxSameAsPrev = true`, store pointer to current classify result in
  `mCachedClassItem` (populated from prior call's `runPipeline` return value — exact
  mechanism confirmed in Unit 6 research).
- Reset `mPrevTBoxHash = 0` and `mCachedClassItem = nullptr` in `reset()` when
  `mPreviousOntology == nullptr` (first call ever).

**Patterns to follow:**
- `Impl::mTriviallyInconsistent` for per-call boolean flag pattern
- `loadTripleBuffer()` as the post-parse detection location

**Test scenarios:**
- Call 4 (same Roberts TBox as call 3): `jq .tbox_same_as_prev /tmp/konclude-state-4-after-load.json` = `true`
- Call 5 (simple TBox after Roberts): `jq .tbox_same_as_prev /tmp/konclude-state-5-after-load.json` = `false`
- First call: `tbox_same_as_prev = false`

**Verification:**
- State dump fields match expected `true`/`false` pattern across 8-call harness run

---

- [ ] **Unit 8: Incremental realization fast path**

**Goal:** When `mTBoxSameAsPrev = true`, skip KPSet classification, reuse `mCachedClassItem`,
run realize fresh.

**Requirements:** R4, R5, R6

**Dependencies:** Units 6, 7

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `runPipeline()`
- Modify (via patch): `vendor/konclude/Source/Reasoner/Classifier/CSubsumptionClassifierThread.cpp`
  or `COptimizedKPSetClassSubsumptionClassifierThread.cpp` — `scheduleOntologyClassification()`
  early-return path
- Create: `patches/012-incremental-classify-skip.patch`
- Modify: `patches/ENABLED`

**Approach:**
- Pass `skipClassify` flag into `runPipeline()` and then into `prepareOntology()`.
- In `scheduleOntologyClassification()`, if `skipClassify && mCachedClassItem != nullptr`:
  insert `mCachedClassItem` into `ontItemHash` under the new `{ontology*, callGeneration}` key,
  skip all classify work, return immediately. This preserves the standard event protocol
  (no changes to `waitSynchronization()` semantics) — the scheduler just returns fast.
- The stale-item cleanup (`mStaleClassItems`) must not delete `mCachedClassItem` before the
  realizer uses it. Since `scheduleOntologyClassification()` registers the item under the new
  key first, the item is "current" and will not be moved to stale this call.

**Test scenarios:**
- Happy path: `jq .processing_end_set_size /tmp/konclude-state-4-after-reason.json` = 1
  (realizer only) when `tbox_same_as_prev=true`
- Happy path: `jq .processing_end_set_size /tmp/konclude-state-3-after-reason.json` = 6
  (full pipeline) when `tbox_same_as_prev=false` (first realization)
- Correctness: diff inferred triples from calls 3 and 4 — identical
- Error path: TBox changes mid-sequence (call 5 after call 4) — `tbox_same_as_prev=false` →
  full classify runs → `processing_end_set_size` = 6
- Integration: 565/565 WASM tests pass

**Verification:**
- State dump pattern: `end_set=1` for same-TBox realize, `end_set=6` for changed-TBox or classify
- Inferred triples from calls 3 and 4 diff to zero
- `tail -5 /tmp/vitest-full-output.txt` shows 565 passed
- Call 4 timing < call 3 timing (classify skipped → faster)

---

- [ ] **Unit 9: WASM build + full suite for Phase B**

**Goal:** Rebuild WASM with patches 009+011+012, run full suite, confirm incremental
realization works at JS layer.

**Requirements:** R4–R6

**Dependencies:** Units 6–8

**Files:**
- `dist/konclude.mjs`, `dist/konclude.wasm` (Docker artifacts)

**Approach:**
- `make reset-patches && make build-wasm` (Docker)
- `npm run patch-wasm`
- Full suite + explanation-persistence specifically (the sequential call test)
- Time calls 3 vs 4 in integration log

**Verification:**
- 565/565 pass
- explanation-persistence: all pass, no 120s timeout
- Call timing shows incremental speedup for same-TBox calls

## System-Wide Impact

- **Processing sets**: cleared per pipeline in `continueRequirementProcessing()` — thread-safe
  (manager thread owns both read and write)
- **`ontItemHash` invariant**: Phase B re-registers `mCachedClassItem` under the new call's
  key — preserves the `{ptr, callGeneration}` composite key contract
- **BackendAssCache**: class hierarchy written by prior classify run remains valid for the
  next realization when TBox unchanged — this is the entire basis for Phase B's correctness
- **Stale item cleanup**: `mCachedClassItem` must be nulled in `reset()` when TBox changes
  to prevent use-after-free on the following call
- **Unchanged**: BackendAssCache Update1→Update2 ordering, `waitSynchronization()` protocol,
  public TypeScript API

## Risks

| Risk | Mitigation |
|------|------------|
| Patch-009 context shifted by prior patches | `make reset-patches` verifies clean apply before building |
| Drain-loop fix (011) breaks other flushPendingInitMessages paths | Only the trailing drain loop changes; other while-blocks have different structure |
| TBox hash collision (Phase B) | `uint64_t` std::hash — collision probability ~2^-64; log a warning if `mTBoxSameAsPrev=true` but result differs from prior call |
| `waitSynchronization()` hang in skip-classify path | Unit 6 research confirms semantics before any code; early-return in scheduler preserves event protocol |
| `mCachedClassItem` deleted before realization | Schedule re-registers item under new key first; stale cleanup only runs on old keys |
| Phase B ships before Phase A stabilizes | Phase B explicitly gated on Phase A's 565/565 green |

## Sources & References

- Analysis: `docs/solutions/debugging/sequential-call-object-lifecycle.md`
- Threading invariants: `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`
- Memory: `project_sequential_call_hang.md`, `project_debug_pipeline.md`,
  `project_build_state.md`, `project_upstream_konclude_bugs.md`
