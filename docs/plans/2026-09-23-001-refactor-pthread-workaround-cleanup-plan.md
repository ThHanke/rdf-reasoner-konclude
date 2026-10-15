---
title: "refactor: Audit and remove stale pthread workarounds"
type: refactor
status: active
date: 2026-09-23
---

# refactor: Audit and remove stale pthread workarounds

## Overview

Phases 1–4 of the pthread refactor introduced correct, principled fixes for several threading
problems that were previously masked by layered workarounds.  Some of those workarounds are
now redundant and can be removed; others remain necessary.  This plan catalogs every
pthread-related workaround, classifies it, and sequences safe removal with test checkpoints.

## Problem Frame

The codebase has accumulated pthread workarounds across four layers:

1. **JS patches** (`scripts/patch-konclude-mjs.sh`) — Emscripten exit-cleanup crash suppression,
   on-demand Worker allocation, and pool pre-sizing.
2. **KoncludeReasoner.cpp** — Two-level ontology holdback (`mPreviousOntology` /
   `mPreviousPreviousOntology`) and the WasmRealizationManager join logic.
3. **CSingleThreadTaskProcessorUnit.cpp override** — Stale-semaphore drain, tag reset,
   completeTask mutex, mProcessingBlocked reset.
4. **Vendor C++ patches 022–035** — ID guards, sync cache writes, no-thread transformations.

After Phase 1–4, some items overlap or are fully superseded.  Removing dead weight reduces
maintenance surface and makes future changes less risky.

## Requirements Trace

- R1. 566/567 test baseline must be maintained after every removal step.
- R2. Each removal is independently testable — no batching multiple removals into one WASM build.
- R3. The browser pthread deadlock (Chrome deferred-worker issue) must not regress.
- R4. The KPSet vtable-crash / STPU stale-callback family of bugs must not regress.
- R5. Pointer-recycling stale-cache hits must not regress.

## Scope Boundaries

- Only removing or simplifying existing workarounds — no new features.
- Native (non-WASM) behavior is not changed; `#ifdef WASM_BUILD` guards preserved where needed.
- Pool size change in Patch 7 is re-evaluated but not necessarily changed.

### Deferred to Separate Tasks

- Phase 4c formal holdback removal investigation: separate session (tracked in memory
  `project_holdback_removal_deferred.md`).
- Phase 5a QSemaphore broadcast→signal: needs correctness analysis of `release(n)` with n>1.

## Context & Research

### Comprehensive Workaround Inventory

| # | Location | What it does | Classification | Verdict |
|---|---|---|---|---|
| JS-P2 | `patch-konclude-mjs.sh` patch 2 | Suppress numeric exit-code errors from KPSet pthread cleanup in `onerror` | Workaround (Emscripten exit path) | **Keep** — KPSet threads still exit with vtable issues |
| JS-P3 | `patch-konclude-mjs.sh` patch 3 | No-op `__emscripten_thread_free_data` to prevent vtable crash in `returnWorkerToPool` | Workaround (vtable crash) | **Investigate** — Unit 1 |
| JS-P4 | `patch-konclude-mjs.sh` patch 4 | try/catch in `invokeEntryPoint` + explicit `__emscripten_thread_exit(0)` to unblock `pthread_join` | Workaround (vtable crash + hang) | **Keep** — critical for `stopAndClearRealizers` |
| JS-P5 | `patch-konclude-mjs.sh` patch 5 | Vite `import.meta.url` → `_scriptName` Worker URL fix | Vite-specific | **Keep** — browser builds |
| JS-P6 | `patch-konclude-mjs.sh` patch 6 | Enable on-demand Worker allocation in browsers | Workaround (pool exhaustion) | **Keep** — fallback guard |
| JS-P7 | `patch-konclude-mjs.sh` patch 7 | Pre-allocate pthreadPoolSize 8→32 | Workaround (Chrome deferred-worker) | **Audit** — Unit 2: thread count reduced after Phase 3 |
| Hold-1 | `KoncludeReasoner.cpp` `mPreviousOntology` | One-cycle holdback for KPSet pthread Emscripten exit-cleanup | Timing workaround | **Investigate** — Unit 1; attempted removal caused 4 hangs |
| Hold-2 | `KoncludeReasoner.cpp` `mPreviousPreviousOntology` | Two-cycle holdback against pointer recycling in singleton caches | Pointer-recycling workaround | **Remove** — Unit 3; superseded by ID guards (patches 022-023, 035) |
| WASM-RM | `KoncludeReasoner.cpp` `WasmRealizationManager` | pthread_join on realizer threads before ontology free | Correct permanent fix | **Keep** |
| STPU-1 | `CSingleThreadTaskProcessorUnit.cpp` completeTask mutex | Quiesces STPU before `mCallbackExecuter` is freed | Correct permanent fix | **Keep** |
| STPU-2 | `CSingleThreadTaskProcessorUnit.cpp` `stpuResetStopped` | Resets `mProcessingStopped` flag between classify() calls | Correct permanent fix | **Keep** |
| STPU-3 | `CSingleThreadTaskProcessorUnit.cpp` `startProcessing()` drain | Drains stale semaphore + events from previous call | Correct permanent fix | **Keep** |
| STPU-4 | `CSingleThreadTaskProcessorUnit.cpp` `signalizeEvent()` unconditional release | Removes tag-equality guard to prevent missed wake | Correct permanent fix | **Keep** |
| STPU-5 | `CSingleThreadTaskProcessorUnit.cpp` `processingLoop()` `mProcessingBlocked` reset | Prevents spurious initial wait on re-entry | Correct permanent fix | **Keep** |
| P022 | `patches/022-hasself-disjoint-clash.patch` | hasSelf+disjoint saturation clash detection | Correctness fix (not threading) | **Keep** |
| P023 | `patches/023-disable-kpset-pseudo-model-merge.patch` | Disables pseudo-model merge optimization | WASM workaround (non-determinism) | **Keep for now** — root cause unknown |
| P026 | `patches/026-kpset-batch-sync-determinism.patch` | WASM batch scheduling guard | WASM workaround | **Keep** |
| P028 | `patches/028-atomic-stpu-tags.patch` | `std::atomic` STPU tags | Permanent correctness fix | **Keep** |
| P029 | `patches/029-reader-linker-mutex.patch` | `mReaderLinker` traversal mutex | Permanent correctness fix | **Keep** |
| P030-032 | `patches/030-032-*-cache-sync.patch` | Sync write paths for 3 caches | WASM workaround (no bg thread) | **Keep** |
| P033-034 | `patches/033-034-*-no-thread.patch` | Skip thread spawn for 2 caches | WASM workaround | **Keep** |
| P035 | `patches/035-classification-manager-id-guard.patch` | CClassificationManager ID guard | Permanent correctness fix | **Keep** |

### Key Findings

**Hold-2 (`mPreviousPreviousOntology`) is the only confirmed-redundant item.**
ID guards in patches 022-023 and 035 cover all five singleton-cache hash tables.
The pointer-recycling justification for the two-cycle hold is gone.
The one-cycle hold (`mPreviousOntology`) is a separate concern — KPSet pthread exit-cleanup
timing — which was attempted for removal but caused 4 timeout regressions (2026-09-23).

**JS-P7 (pthreadPoolSize=32) warrants a downward audit.**
Phase 3 eliminated 2 cache threads.  The original 32 was sized for ~17 concurrent threads.
With ~15 now, a pool of 20 fits with margin.  The exact live-thread count at peak must be
verified before changing; if the measured peak is ≤ 16, dropping to 20 is safe.  Patch 6's
on-demand fallback provides a backstop regardless.

**JS-P3 (`__emscripten_thread_free_data` no-op) is worth auditing alongside `mPreviousOntology`.**
Both address the same root class: KPSet pthread exit-cleanup running after classify() returns.
JS-P3 prevents the vtable crash in the JS `returnWorkerToPool` path; `mPreviousOntology` prevents
the same class from crashing C++ state.  Neither is obviously redundant without understanding
exactly which C++ objects are accessed during `__emscripten_thread_free_data`.

### Institutional Learnings

- `project_holdback_removal_deferred.md`: removing holdback caused 4 timeout regressions;
  Phase 5 components (thread reduction, pool size) do not unblock this alone.
- `project_ontology_lifetime_singleton_cache.md`: original holdback rationale; ID-guard approach.
- `feedback_never_patch_without_logging.md`: add `fprintf` traces before any C++ change.
- `feedback_build_from_known_good.md`: never build HEAD with untested patches.
- `feedback_wasm_rebuild_sentinel.md`: `make reset-patches` when patch fails to apply cleanly.

## Key Technical Decisions

- **Remove Hold-2 first, not Hold-1.** Removing `mPreviousPreviousOntology` only reduces the
  holdback from 2 cycles to 1.  This is lower-risk than removing both, and separates the two
  concerns cleanly.
- **Measure live thread count before changing JS-P7.**  Do not guess.  Add a
  `fprintf(stderr, "[THREAD-COUNT] ...")` log and count distinct pthreads observed during a
  classify+materialize run on the large benchmark ontology.
- **Do not remove JS-P3 or Hold-1 in the same WASM build.**  They address the same bug class;
  removing both simultaneously would make regression attribution impossible.
- **graphify explain before any C++ vendor file edit** — mandatory per project rules.

## Open Questions

### Resolved During Planning

- *Is `mPreviousPreviousOntology` genuinely redundant?* Yes — patches 022-023 + 035 guard all
  five singleton caches by ontology ID.  No singleton cache can return a stale entry for a
  recycled pointer regardless of holdback.
- *Does removing Hold-2 change the JS build?* No — it is a C++ source change in
  `KoncludeReasoner.cpp`; requires a WASM rebuild but no JS patch changes.
- *What is the live thread count after Phase 3?* Unresolved — needs measurement (Unit 2).

### Deferred to Implementation

- Whether JS-P3 can be safely removed: depends on tracing exactly what C++ state
  `__emscripten_thread_free_data` touches on the KPSet thread exit path.
- Whether `mPreviousOntology` can be removed: depends on Unit 1 findings.
- The minimum safe pthreadPoolSize value: depends on Unit 2 measurement.

## Implementation Units

- [ ] **Unit 1: Investigate `mPreviousOntology` + JS-P3 exit-cleanup path**

**Goal:** Understand exactly why removing `mPreviousOntology` caused 4 timeout hangs, and
whether JS-P3 (no-op `__emscripten_thread_free_data`) already prevents the underlying crash
without the C++ holdback.

**Requirements:** R1, R4

**Dependencies:** None (analysis only, no code change)

**Files:**
- Read: `src/KoncludeReasoner.cpp` (reset, WasmRealizationManager, stopAndClearRealizers)
- Read: `scripts/patch-konclude-mjs.sh` patches 2–4
- Read: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`

**Approach:**
- Add `fprintf(stderr, "[HOLDBACK] reset cycle N: freeing ptr=%p id=%lld\n", ...)` to
  `reset()` for both the holdback and the immediate-delete paths.
- Add `fprintf(stderr, "[THREAD-FREE] __emscripten_thread_free_data called: ptr=%p\n", ...)`
  by temporarily un-no-oping JS-P3 to a logging version (not the real WASM call).
- Build with Hold-2 (`mPreviousPreviousOntology`) already removed (Unit 3 done first),
  Hold-1 (`mPreviousOntology`) still present.
- Run the 4 previously-failing tests with verbose logging captured.
- Analyze: does the hang correlate with `__emscripten_thread_free_data` being called on a
  pointer that is still live in C++?  Or is there a semaphore / event-queue interaction?
- The investigation will determine whether Hold-1 can be removed independently or needs a
  deeper C++ fix first.

**Test scenarios:**
- Integration: run `tests/integration/axiom-api.test.ts > whatIf() > R6` in isolation with
  LOG output captured — 2 sequential classify calls should both complete.
- Integration: run `tests/integration/property-characteristics.test.ts` rdfs:domain and
  rdfs:range cases — should pass without 60s timeout.
- Integration: run `tests/integration/explanation-persistence.test.ts` — should not time out.

**Verification:**
- LOG output explains whether the hang is in JS-P3 path, semaphore, or C++ state access.
- A fix is proposed (or Hold-1 removal is confirmed impossible without a deeper change).

---

- [ ] **Unit 2: Measure live thread count and right-size JS-P7 pthreadPoolSize**

**Goal:** Determine the actual peak concurrent pthread count during a classify+materialize run,
then decide whether pthreadPoolSize can be reduced below 32.

**Requirements:** R1, R3

**Dependencies:** None (measurement only before deciding on a code change)

**Files:**
- Modify (temporarily): `src/KoncludeReasoner.cpp` — add thread-count instrumentation
- Modify (if change warranted): `scripts/patch-konclude-mjs.sh` patch 7

**Approach:**
- Add a temporary `fprintf(stderr, "[PTHREAD-COUNT] peak=%d\n", ...)` in
  `KoncludeReasoner.cpp` that tracks the peak live pthread count using a `std::atomic<int>`
  incremented in `CThread::startThread` override and decremented in `CThread::stopThread`.
  Alternatively, read `Atomics` usage or observe the pool via `pthreadPoolSize` JS variable.
- Run the full benchmark ontology (e.g., the large integration test or `make reason`).
- Record peak.  Add ~25% margin.  If peak ≤ 16, target pool size = 20.  If peak ≤ 24, target = 28.
- If reducing: update JS-P7 `AFTER_POOL` and the `BEFORE_POOL` sentinel to match the new
  compile-time value (requires coordinated change in both `emscripten.cmake` and the patch
  script, since the script searches for `var pthreadPoolSize=N;`).
- Verify Patch 6 on-demand fallback still exists as backstop.

**Test scenarios:**
- All 566 tests pass after pool size change.
- Browser smoke test: load page, run `classify()`, no "unhandled rejection" or thread-limit
  errors in browser console.

**Verification:**
- Peak thread count documented in a comment in `scripts/patch-konclude-mjs.sh` patch 7.
- Test suite passes at 566/567.

---

- [ ] **Unit 3: Remove `mPreviousPreviousOntology` holdback**

**Goal:** Remove the two-cycle holdback field, reducing to a one-cycle hold.  The
pointer-recycling justification is fully superseded by ID guards in patches 022-023 and 035.

**Requirements:** R1, R5

**Dependencies:** None (independent of Unit 1 and Unit 2 — the pointer-recycling and
exit-cleanup concerns are orthogonal)

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
  - Remove field `mPreviousPreviousOntology`
  - Remove `delete mPreviousPreviousOntology` from `~Impl()`
  - In `reset()`: change rotation to `mPreviousOntology = mOntology; mOntology = nullptr`
    (one-cycle hold remains for exit-cleanup timing)
  - Update comment on `mPreviousOntology` to remove pointer-recycling rationale
- Rebuild: `make build-wasm` then `npm run patch-wasm`

**Approach:**
- Change is mechanical: remove one field, update three call sites.
- The one-cycle hold (`mPreviousOntology`) is explicitly kept — this unit does not attempt to
  remove it.
- A `fprintf(stderr, "[HOLDBACK] ...")` log line before and after is recommended to confirm
  the remaining single-cycle hold behaves as expected under test.

**Test scenarios:**
- Happy path: full test suite at 566/567 after rebuild.
- Edge case: run 10 sequential `classify()` calls on the same `RdfReasoner` instance — no
  stale results (each call should produce correct inferences for its input ontology).
- Integration: `whatIf()` test suite — all 6 `whatIf` variants should pass including R6
  (two independent calls).

**Verification:**
- 566/567 test baseline holds.
- No stale-cache hits observed in LOG output across sequential calls.

---

- [ ] **Unit 4: Document the permanent "keep" list**

**Goal:** Add a concise reference comment or doc entry explaining each kept workaround,
so future maintainers understand what is intentional vs what is technical debt.

**Requirements:** None (documentation only)

**Dependencies:** Units 1–3 complete (so the list is final)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — add a block comment near `WasmRealizationManager`
  listing the JS patches it depends on (patches 2, 3, 4) and why.
- Modify: `scripts/patch-konclude-mjs.sh` — add a brief "rationale" comment header to
  patches 3, 4, 6, 7 citing what Emscripten behavior they work around and which
  code they coordinate with.
- Optional: update `docs/solutions/` with a new architecture note summarizing the final
  pthread workaround surface.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- Each kept JS patch has a comment explaining: (a) what Emscripten behavior it works around,
  (b) which C++ code it coordinates with, (c) conditions under which it could be removed.

## System-Wide Impact

- **Interaction graph:** All units touch the WASM binary path — any C++ change needs a full
  `make build-wasm` + `npm run patch-wasm` cycle.
- **Error propagation:** Regression = test timeout (hang) or assertion failure; both are
  observable in the test suite.
- **State lifecycle risks:** Unit 3 changes `reset()` — verify that no test depends on the
  two-cycle hold implicitly (sequential call tests are the primary check).
- **Unchanged invariants:** JS patches 2, 4, 5, 6 are untouched in all units.
  `WasmRealizationManager` and all STPU fixes are untouched.
- **Integration coverage:** Multi-call tests (`whatIf R6`, `explanation-persistence`,
  `property-characteristics` rdfs:domain/range) are the key integration regression signals.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 3 removal triggers same hangs as previous holdback-removal attempt | Unit 3 only removes 2nd-cycle hold; 1st cycle (`mPreviousOntology`) stays. If hangs occur, revert immediately. |
| Unit 2 pool size reduction breaks browser worker allocation | Patch 6 on-demand fallback provides backstop; smoke-test in Chrome before committing. |
| Unit 1 investigation is inconclusive | Document findings and defer Hold-1 removal; do not block Units 2 and 3. |
| JS patch sentinel mismatch (BEFORE_POOL doesn't match after compile-time change) | Update both `emscripten.cmake` and `BEFORE_POOL` sentinel in same PR; verify `[SKIP] already patched` fires correctly. |

## Recommended Execution Order

Start with **Unit 3** (lowest risk, no investigation needed, clear expected outcome).
Run **Unit 2** in parallel or immediately after (measurement only, no rebuild needed until
decision is made).
Run **Unit 1** after Unit 3 is confirmed stable (investigation with full single-cycle holdback).
Run **Unit 4** last (documentation, no rebuild).

## Sources & References

- `docs/solutions/architecture-patterns/pthread-refactor-plan-2026-09-21.md`
- `docs/solutions/architecture-patterns/pthread-gap-analysis-2026-09-21.md`
- Memory: `project_holdback_removal_deferred.md`, `project_ontology_lifetime_singleton_cache.md`
- Related patches: `patches/022–035`
