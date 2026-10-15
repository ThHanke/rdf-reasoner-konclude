---
title: "refactor: Clean pthreads baseline — strip to port-only patch set"
type: refactor
status: active
date: 2026-10-01
---

# refactor: Clean pthreads baseline — strip to port-only patch set

## Overview

Create a new experiment branch that strips all 63 current patches back to the smallest
provably-correct set needed to run native Konclude as WASM. The hypothesis: most Category C
patches compensate for Qt threading side-effects that do not apply to our pthread port, and
Category B patches may be collapsible into a single clean mechanism patch. The deliverable is
a single consolidated patch (or two: core port + multi-call memory), grounded by graphify
analysis and verified by a fast proof test suite.

This plan covers everything up to the "discuss findings" checkpoint; the single-patch authoring
step is gated on the Unit 4 findings discussion with the user.

## Problem Frame

The current 63-patch accumulation grew organically during debugging. Each patch solved an
immediate test failure but no one has verified whether the underlying need is real without the
others. This makes the patch set fragile to vendor upstream updates and hard to explain. The
goal is to answer: **what is the minimum port-layer code that makes Konclude run correctly in
Emscripten pthreads?**

## Requirements Trace

- R1. All port-layer code must be traceable to a specific pthread/WASM mechanism (M1-M17 from
  the pthread spec, or an explicitly named port need)
- R2. Patches that change native OWL DL reasoning results on a single call must be excluded
  from the port-only set, UNLESS they are also required for multi-call correctness or
  WASM-threading correctness (the native/port distinction is not binary — see Open Questions)
- R3. Each intermediate build step must have a go/no-go test criterion — no "build and hope"
- R4. pthread sync correctness must be proved by a determinism test (identical inputs → identical
  outputs across N runs) and a sequential-call test (no stale state between calls)
- R5. Memory correctness between calls must be proved by an RSS regression test
- R6. The final patch set must compile and pass the full test suite (565/567 minimum)
- R7. **Success threshold**: if more than 6 Category C patches are confirmed load-bearing
  correctness requirements (native bug or multi-call need), declare consolidation infeasible
  and publish the classification manifest only; do not attempt the single-patch authoring step

## Scope Boundaries

- This plan does NOT write the final consolidated patch — that happens after Unit 4 discussion
- Category C patches that turn out to fix real native Konclude bugs are documented as upstream
  candidates, not removed from the repo
- Browser pthread deadlock (PROXY_TO_PTHREAD) is out of scope
- M12 remaining item (CReuseCompletionGraphCache slot race) is out of scope — stays as-is
- Graphify rebuild is deferred to the authoring plan (no C++ patching occurs in this plan)

### Deferred to Separate Tasks

- M12 final cache fix (CReuseCompletionGraphCache): separate issue, known blocker
- M4 errorcheck mutex in debug builds: separate small task
- M5 broadcast→signal optimization: separate small task
- Thread pool size reduction (M16): after M12 resolved
- Graphify rebuild: follow-on authoring plan (MANDATORY before any patch is written)
- Single consolidated patch authoring: follow-on plan, after Unit 4 discussion

### Experiment-fail disposition

If R7 triggers (>6 C patches confirmed load-bearing):
- Unit 1 ENABLED allowlist mechanism is merged to main (permanent value for future experiments)
- Unit 4 classification manifest is merged to main as documentation
- Experiment branch is closed without merging Units 2-3 artifacts
- `ASSERTIONS=1` / `MI_DEBUG=2` build flags are reverted on the branch before closing

## Context & Research

### Patch category definitions

| Category | Criteria | Patches |
|----------|----------|---------|
| **A** | Qt-namespace removal, compile-only, zero runtime semantics change | 001-004 |
| **B_core** | pthread/WASM mechanism correctness — atomic callbacks, STPU scheduling | 006, 007, 014, 019, 028, 029 |
| **B_det** | WASM nondeterminism fixes — labeled "WASM nondeterminism" or "WASM specific" in manifest; reclassified from C per plan rule | 023, 026 |
| **B_cache** | Cache thread sync/elimination — reasoning-correctness async cache races | 030, 031, 032, 033, 034, 036, 042, 043, 044 |
| **C** | Logic/correctness hypothesis — excluded initially; experiment determines necessity | 005, 009, 010, 011, 012, 015, 016, 017, 018, 020, 021, 022, 025, 027 |
| **D** | Destructor/memory lifecycle — multi-call WASM lifetime, not needed by single-run native | 045-068 |

Note: patches 035, 037 are absent from `patches/` (deleted or never created).

### Hard compile prerequisites

These patches are required for the WASM build to compile at all — their symbols are called
from always-compiled override files or `src/KoncludeReasoner.cpp`. Omitting any of them
causes a build-time compile error before any test can run.

| Patch | Why required |
|-------|-------------|
| **028** | `CSingleThreadTaskProcessorUnit.h` — changes `cint64` fields to `std::atomic<cint64>`; STPU override calls `.store()`/`.load()` on them |
| **038** | `CConcreteOntology.h` — adds `getCallGeneration()`/`setCallGeneration()`; called unconditionally from `src/compat/overrides/CClassificationManager.cpp` and `src/KoncludeReasoner.cpp` |
| **039** | Stage-thread headers — adds `mOntoClassifierHash` and variants with `QPair<CConcreteOntology*, cint64>` keys; called from the same override and KoncludeReasoner |

Patches 040, 041 implement the `.cpp` bodies for the 039 header additions. Whether they must
be in ENABLED depends on whether the vendor `.cpp` files they patch are compiled (the
`CClassificationManager.cpp` override replaces the vendor file). Determine during Unit 1 setup.

### Relevant code and patterns

**Overrides (never patches — always active):**
- `src/compat/overrides/CThread.cpp` — pthread event loop (M1, M2, M3)
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — semaphore drain, atomic tags
  (M7, M10, M11)
- `src/compat/overrides/CClassificationManager.cpp` — calls 038+039 symbols unconditionally
- `src/compat/QtCompat.h:1300-1600` — QMutex→pthread_mutex_t, QSemaphore→condvar,
  QAtomicPointer→std::atomic (M4, M5, M6)

**Patch disable mechanism:**
- `scripts/apply-patches.sh` has no built-in skip mechanism
- Unit 1 adds an `ENABLED` allowlist: when `patches/ENABLED` exists, only listed patches apply
- **Every ENABLED list change requires `make reset-patches` (full vendor reset + re-apply) +
  `make build-wasm`. Running `make patches` without `--force` after changing ENABLED silently
  applies the old patch set. The sentinel does not track which patches were applied.**

**Post-build mandatory step (every build cycle):**
- `npm run patch-wasm` — MUST run after every `make build-wasm`. Patches pthreadPoolSize from
  8→20, fixes `createRequire`, `onerror`, `__emscripten_thread_free_data`, `invokeEntryPoint`.
  Without it, the Worker fails to initialize and all tests fail for wrong reasons.

**Test proof suite (covers all three proof targets):**

Fast subset (~12 min total — hierarchy-determinism is ~9 min of that):
- `tests/integration/concurrency-regression.test.ts` — sequential calls, no deadlock (~1 min)
- `tests/integration/owl-dl-capabilities.test.ts` — OWL DL correctness, inline (~1 min)
- `tests/integration/consistency.test.ts` — consistency check, inline (<1 min)
- `tests/integration/abox-realization.test.ts` — sequential call regression (~1 min)
- `tests/integration/hierarchy-determinism.test.ts` — N identical materialize() must agree
  (~3 min/run × 3 runs = ~9 min); **pthread race detector, NOT a proof of pthread event-loop
  correctness** — its root cause is unsolved as of 2026-09-18, and it is sensitive to KPSet
  scheduling changes (023, 026), not the event loop itself

Memory proof (runs as part of full suite):
- `tests/integration/memory-rss-regression.test.ts` — RSS < 200 MB across 3 classify() calls

Full correctness suite (~594s total):
- All integration tests; hierarchy-determinism is necessary but not sufficient for pthread proof

### Diagnostic strategy for D-patch exclusion

The plan excludes Category D (destructor patches) in Unit 1 to expose what B patches prevent.
**Critical limitation**: `MALLOC=mimalloc` manages its own heap region inside WASM linear
memory, independent of dlmalloc. Emscripten's `-sASSERTIONS=1` covers the JS heap / dlmalloc
only — it does NOT catch use-after-free of C++ objects in mimalloc-managed memory. Missing
D patches produce **silent wrong results or nondeterministic crashes**, not readable assertion
errors.

Mitigation: enable `MI_DEBUG=2` via environment variable (`MIMALLOC_VERBOSE=2 MI_DEBUG=2`
passed to the Node.js process running tests). This adds mimalloc allocation header guards and
detects many UAF patterns. Alternatively, swap to `MALLOC=dlmalloc` in `emscripten.cmake` for
the experiment build — this makes ASSERTIONS=1 effective for UAF. Either approach must be
applied; D-exclusion without one of these produces uninterpretable failures.

### Institutional learnings

- `docs/solutions/architecture-patterns/pthread-implementation-spec-2026-09-21.md` — M1-M17
  mechanisms, status, and target. Golden reference.
- `docs/solutions/architecture-patterns/pthread-refactor-plan-2026-09-21.md` — Phase 1-5 plan;
  Phases 1-3 mostly complete.
- Memory: `feedback_never_patch_without_logging.md` — vitest auto-captures LOG output; always
  save to `/tmp/vitest-full-output.txt` before tailing.
- Memory: `feedback_build_from_known_good.md` — never build HEAD with untested patches.
- Memory: `feedback_always_use_new_multi_file_patch.sh` — use `new-multi-file-patch.sh`,
  never `new-vendor-patch.py`.

## Key Technical Decisions

- **Patch allowlist over file removal**: Add an `ENABLED` allowlist file to `patches/` rather
  than physically removing patches. When `patches/ENABLED` exists, `apply-patches.sh` applies
  only the listed patches. Preserves all patches on the branch; state is diffable and
  reversible. ENABLED is a permanent feature merged to main regardless of experiment outcome.

- **MI_DEBUG=2 or dlmalloc swap for UAF diagnostics**: `ASSERTIONS=1` alone does not catch
  mimalloc UAF. Choose one before running Unit 1: `MI_DEBUG=2` (env var, no rebuild needed)
  or swap `MALLOC=dlmalloc` in `emscripten.cmake` (requires rebuild but gives full ASSERTIONS
  coverage). Decision deferred to implementation; document which was chosen in Unit 1 findings.

- **ASSERTIONS=1 for experiment build**: Enable `-sASSERTIONS=1` in `emscripten.cmake`.
  Catches stack/heap overflows, double-free, and JS-heap violations. Note: adds LTO link-time
  overhead on top of the ~2× classify() slowdown — measure one baseline build before committing.
  Remove for the final consolidated patch.

- **B_det subcategory**: Patches 023 (disable KPSet pseudo-model merge — "WASM nondeterminism
  workaround") and 026 (KPSet batch sync determinism — "WASM specific") are explicitly
  WASM nondeterminism fixes. The plan's rule "re-classify to B if race-induced" applies.
  Enable B_det from Unit 1 onward alongside B_core to keep the experiment's C-patch measurement
  clean. Without them, hierarchy-determinism failures are ambiguous.

- **Graphify rebuild deferred**: No C++ patching occurs in this plan. Graphify rebuild is
  mandatory before any consolidated patch is written, but that happens in the follow-on
  authoring plan. Do not spend build time on it here.

- **hierarchy-determinism as necessary (not sufficient) signal**: Passing = evidence of correct
  KPSet scheduling + B patches. Failing = ambiguous (could be KPSet race, B patch missing,
  or unsolved root cause). Supplement with concurrency-regression + sequential abox-realization
  as the event-loop correctness evidence.

## Open Questions

### Resolved During Planning

- **Can we skip individual patches without removing them?** No built-in mechanism — Unit 1
  adds ENABLED allowlist.
- **Is patch 028 the only hard build prerequisite?** No — patches 038 and 039 are also hard
  compile prerequisites (symbols called from always-compiled overrides). All three always in
  ENABLED.
- **Does ASSERTIONS=1 catch mimalloc UAF?** No — requires MI_DEBUG=2 or dlmalloc swap.
- **Is hierarchy-determinism a proof of pthread correctness?** No — necessary but not
  sufficient; its root cause is unsolved; sensitive to KPSet scheduling, not event loop.
- **Are patches 023/026 Category C?** No — reclassified to B_det (WASM nondeterminism).

### Resolved During Planning — Patch Dependencies

- 028, 038, 039 → hard build prereqs (always in ENABLED)
- 014 → required by 006 (generation counter fields; verify direction in Unit 4)
- 040, 041 → may be required alongside 039 (verify during Unit 1 setup)
- 015 + 038 → required by 039-041 (mGeneration public access); since 039 is a prereq,
  check whether 015 must also be a prereq
- All other patches: independent of each other

### Deferred to Implementation

- Which of MI_DEBUG=2 vs dlmalloc-swap is used for UAF diagnostics
- Whether patches 040, 041 must be included as hard prereqs (verify against override file list)
- Whether patch 015 is a hard prereq (required by 039 which is a hard prereq)
- Whether Category C patches are needed: determined empirically
- Exact shape of the consolidated single patch: after Unit 4 discussion
- Whether CThread.cpp override needs changes once C patches are removed

### Open — Unresolved

- **R2 binary assumption**: Some C patches may fix bugs that are only reachable under WASM's
  pthread scheduling (latent Qt-masked bugs exposed by threading). Use the "single-call vs
  multi-call" and "deterministic vs nondeterministic" discriminators in Unit 4; add "tested
  in native binary" column where native Konclude is buildable.
- **BackendAssCache patches (010, 017)**: Labeled "Qt timing artifact?" but may fix WASM
  multi-call correctness (long-lived objects reused across calls, where Qt implicitly
  reconstructed them). Test both with a targeted single-call test BEFORE the experiment if
  possible; add "single-call clean?" column to Unit 4 manifest.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification.*

```
Experiment flow:

  refactor/pthread-phase1 (63 patches, 565/567 pass)
       │
       └── experiment/native-konclude-baseline (new branch)
                │
                ├── Unit 1: setup + first experiment
                │     ├── add ENABLED allowlist to apply-patches.sh
                │     ├── ENABLED = A + hard-prereqs + B_core + B_det (no D, no B_cache)
                │     ├── Build (ASSERTIONS=1 + MI_DEBUG=2 or dlmalloc)
                │     ├── npm run patch-wasm
                │     └── fast proof suite → document failures
                │
                ├── Unit 2: add B_cache + correctness validation
                │     ├── ENABLED += B_cache (030-034, 036, 042-044)
                │     ├── Build → npm run patch-wasm
                │     ├── fast proof suite + owl2dl-parity
                │     └── hierarchy-determinism (pthread race signal)
                │
                ├── Unit 3: add D patches + full suite
                │     ├── ENABLED += D (045-068)
                │     ├── Build → npm run patch-wasm
                │     ├── Full suite (~594s) → memory-rss-regression
                │     └── Table: Test | Passes A+B+D? | C patch? | Bug class
                │
                └── Unit 4: analysis document (discussion checkpoint)
                      ├── Port-necessary inventory (B+D confirmed)
                      ├── C-patch disposition (3 buckets: needed / not needed / ambiguous)
                      ├── Consolidated patch proposal OR manifest-only if R7 triggers
                      └── Go/no-go for single-patch authoring
                           (graphify rebuild deferred to authoring plan)
```

Patch category legend:
- **A**: Qt removal glue (001-004) — always needed
- **Hard prereqs**: 028, 038, 039 (+ verify 015, 040, 041) — compile-time required
- **B_core**: Atomic callbacks + pthread scheduling (006, 007, 014, 019, 029)
- **B_det**: WASM nondeterminism (023, 026)
- **B_cache**: Cache sync/no-thread (030, 031, 032, 033, 034, 036, 042, 043, 044)
- **C**: Logic/correctness hypothesis (005, 009, 010, 011, 012, 015*, 016, 017, 018, 020, 021, 022, 025, 027)
  *015 may be reclassified as hard prereq pending Unit 1 verification
- **D**: Destructor/memory (045-068) — multi-call lifecycle

## Implementation Units

---

- [ ] **Unit 1: Branch setup, ENABLED mechanism, and A+B first experiment**

**Goal:** Create the experiment branch, add patch selectivity to `apply-patches.sh`, determine
the full set of hard build prerequisites, and run the first experiment (A + hard prereqs +
B_core + B_det) to establish the near-native baseline.

**Requirements:** R3 (first go/no-go data point)

**Dependencies:** None

**Files:**
- Create: branch `experiment/native-konclude-baseline` from `refactor/pthread-phase1`
- Modify: `scripts/apply-patches.sh` — add ENABLED allowlist support (5-10 lines: if
  `patches/ENABLED` exists, read it; skip any `.patch` not listed; warn on misspelled names)
- Create: `patches/ENABLED` (committed on this branch)
- Modify: `emscripten.cmake` — add `-sASSERTIONS=1` to link flags
- Choose and document: MI_DEBUG=2 env var OR swap `MALLOC=dlmalloc` for UAF diagnostics

**Approach:**
- ENABLED file initially contains: 001, 002, 003, 004 (A), 028, 038, 039 (hard prereqs),
  006, 007, 014, 019, 029 (B_core), 023, 026 (B_det)
- Verify whether 015, 040, 041 are also compile-time required — add if yes
- **Every ENABLED change: `make reset-patches && make build-wasm` (full rebuild required)**
- After build: `npm run patch-wasm` (mandatory — without it all tests fail)
- Run fast subset: concurrency-regression + owl-dl-capabilities + consistency + abox-realization
  (~4 min)
- **Do NOT run hierarchy-determinism in this unit** — its ~9 min runtime is not worth it before
  B_cache is added; the race it detects requires B_cache to be meaningful
- For each failure: classify as hang (STPU/cache deadlock) / wrong result (logic) / crash
  (UAF visible via MI_DEBUG or dlmalloc ASSERTIONS)
- Document findings in a `docs/solutions/` note

**Test scenarios:**
- Build succeeds without compile error (proves prereq list is complete)
- consistency.test.ts passes (no caches involved — control group)
- owl-dl-capabilities may fail if C patches fixed real bugs (record which cases)
- concurrency-regression: document if hang occurs (expected if B_cache missing)
- Any crash: record MI_DEBUG/ASSERTIONS output verbatim

**Verification:**
- Build compiles clean
- Sentinel written after `apply-patches.sh` reports exactly N patches applied (N = ENABLED count)
- Test output saved to `/tmp/vitest-unit1.txt`; failures documented with error class

---

- [ ] **Unit 2: Add B_cache, run correctness validation**

**Goal:** Complete the pthread synchronization layer by adding cache sync/no-thread patches.
Verify OWL DL correctness without any Category C patches. First use of hierarchy-determinism
as the pthread scheduling signal.

**Requirements:** R3, R4

**Dependencies:** Unit 1 (established baseline and ENABLED mechanism)

**Files:**
- Modify: `patches/ENABLED` — add 030, 031, 032, 033, 034, 036, 042, 043, 044

**Approach:**
- `make reset-patches && make build-wasm && npm run patch-wasm`
- Run fast subset + `owl2dl-parity.test.ts` + `hierarchy-determinism.test.ts`
- Total runtime: ~12 min (4 min fast + 9 min determinism + ~2 min parity)
- Compare to Unit 1 baseline: which failures resolved by B_cache?
- hierarchy-determinism: if it fails, the failure is KPSet scheduling, not the event loop
  (023 and 026 are already enabled via B_det — so failure here is a deeper issue)

**Test scenarios:**
- Happy path: B_cache-protected caches no longer race; concurrency-regression passes
- Expected gap: C-patch-gated tests still fail (wrong OWL DL results)
- Expected gap: memory-rss-regression may fail (missing D patches)
- hierarchy-determinism: any non-determinism at this step is a signal that B_core or B_det
  is incomplete, not a C-patch issue

**Verification:**
- Pass rate documented, delta from Unit 1 measured
- Remaining failures classified by type before Unit 3
- hierarchy-determinism result recorded with run count and subClassOf values

---

- [ ] **Unit 3: Add D patches, run full suite, produce findings table**

**Goal:** Add all destructor/memory patches and run the full test suite. Establish the
"A + B + D (no C)" maximum baseline — everything possible without touching native logic.

**Requirements:** R3, R5, R6

**Dependencies:** Unit 2

**Files:**
- Modify: `patches/ENABLED` — add 045-068

**Approach:**
- `make reset-patches && make build-wasm && npm run patch-wasm`
- Full suite: `npx vitest run --reporter=verbose 2>&1 > /tmp/vitest-unit3.txt`
- RSS measurement: `memory-rss-regression.test.ts` — record actual MB values
- For each remaining failure, determine:
  - Is it present ONLY in tests covering constructs patched by specific C patches?
  - Is the failure deterministic across repeated runs (logic bug) or nondeterministic (race)?
  - For BackendAssCache patches (010, 017): does the failure occur on the first call (single-call
    bug) or only after multiple calls (multi-call correctness)?
- Produce the findings table:

  | Test | Passes A+B+D? | C patch(es) needed | Single-call? | Deterministic? | Bug class |
  |------|--------------|-------------------|-------------|---------------|----------|
  | ... | ... | ... | ... | ... | ... |

**Test scenarios:**
- memory-rss-regression: RSS growth < 200 MB across 3 calls
- concurrency-regression: no hang, correct results
- hierarchy-determinism: all N runs agree
- Expected failures: tests covering hasSelf+disjoint (022), asymmetric self-loop (027),
  ALIF (020-021), negative prop (011), role axioms (012)
- If failures appear in tests unrelated to any C patch, this signals a missing B patch
  or undiscovered hard prereq

**Verification:**
- Pass count documented (expected: 545-565 range if hypothesis is partly correct)
- findings table complete for every failing test
- R7 check: if failing tests map to >6 distinct C patches, apply experiment-fail disposition

---

- [ ] **Unit 4: Analysis document — findings and single-patch plan**

**Goal:** Synthesize all unit findings into a decision document. This is the discussion
checkpoint — single-patch authoring (and graphify rebuild) happens only after user approval.

**Requirements:** R1, R2, R7

**Dependencies:** Units 2 and 3

**Files:**
- Create: `docs/solutions/architecture-patterns/patch-classification-manifest-2026-10-01.md`
  — definitive per-patch classification grounded by experiment results (not hypothesis)
- Create: `docs/solutions/architecture-patterns/clean-pthreads-baseline-findings-2026-10-01.md`

**Approach:**

**Manifest document** — one row per patch with:
- Patch, Category (A/B_core/B_det/B_cache/C/D/hard-prereq), Rationale, Single-call clean?,
  Deterministic failure?, Bug class, Recommendation

**Findings document structure:**

*Section 1 — Port-necessary inventory*
- B patches: which M-mechanism, which test fails without it
- D patches: which destructor, which test shows the leak without it
- Hard prereqs: compile requirement confirmed

*Section 2 — Category C disposition*
Three explicit buckets per patch:
- **Confirmed needed**: test fails deterministically without it; failure confirmed WASM-only
  (not reproducible in native binary) OR confirmed multi-call need (single-call passes,
  multi-call fails) — keep in port patch
- **Confirmed not needed**: all tests pass without it at A+B+D level — remove
- **Ambiguous**: failure class unclear; document the one additional test that would resolve it

For BackendAssCache patches (010, 017): include "single-call clean?" result from Unit 3 as
the discriminator between "Qt artifact" and "WASM multi-call requirement."

*Section 3 — Consolidated patch structure proposal*
```
patches/000-wasm-port-core.patch:
  - Hard prereqs (028, 038, 039, + verified others)
  - M7: STPU atomic tags
  - M9: callback atomic guards (006, 007, 014)
  - M12: cache sync/no-thread (030-036)
  - M13: stats/consequences no-thread (042-044)
  - M14: reader-linker mutex (029)
  - Port: pthread yield (019)
  - B_det: KPSet nondeterminism (023, 026)
  - A: Qt header removals (001-004)

patches/001-wasm-multi-call-memory.patch:
  - D: all destructor additions (045-068)

[confirmed-needed C patches: individual files with upstream-bug markers]
[ambiguous C patches: held pending one additional targeted test]
```

*Section 4 — Go/no-go*
- Pass rate A+B+D vs full 63 patches (gap = what C patches would close)
- R7 check result: consolidation feasible / infeasible
- Three-outcome approval: (a) <6 C patches needed → full consolidation; (b) 6-12 needed →
  two-tier patch (port-core + correctness-layer); (c) >12 needed → manifest-only, close branch
- **Precondition note for authoring plan**: graphify rebuild is mandatory before the first line
  of the consolidated patch is written

**Test scenarios:**
- Test expectation: none — documentation unit; verified by reading the document

**Verification:**
- Every patch has a row in the manifest with experiment-grounded rationale
- Every ambiguous C patch has exactly one documented follow-up test
- User approves one of the three go/no-go outcomes before authoring proceeds

---

## System-Wide Impact

- **Interaction graph:** `apply-patches.sh` → every downstream build; ENABLED file gates all
  vendor C++ patches; `npm run patch-wasm` gates all runtime correctness
- **Error propagation:** Build failures in the experiment branch are expected and informative —
  they do NOT indicate bugs in the current main branch
- **State lifecycle risks:** The experiment branch must never be merged to main/refactor without
  full 565/567 pass; it is an investigation branch only
- **Unchanged invariants:** The `refactor/pthread-phase1` branch and its 63-patch set are
  untouched by this work
- **Integration coverage:** Full suite in Unit 3 covers multi-call lifecycle and large
  ontologies that unit tests cannot prove

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Experiment build takes 20-30 min per cycle + LTO overhead with ASSERTIONS=1 | Measure one baseline build first; use ccache; 4 builds total (Units 1-3 + any single re-run) |
| Hard prereq list is incomplete (015, 040, 041 status unknown) | Verify at Unit 1 setup; build fails fast if a prereq is missing — add and retry |
| mimalloc UAF is silent under ASSERTIONS=1 | MI_DEBUG=2 or dlmalloc swap (chosen in Unit 1); no longer a risk if mitigation is applied |
| B_det patches (023, 026) were C — enabling them changes the experiment's C-measurement | Correct: they were always nondeterminism fixes; enabling them makes the measurement clean, not dirty |
| hierarchy-determinism passes/fails for reasons unrelated to event-loop correctness | Treat as KPSet scheduling signal only; supplement with concurrency-regression + abox-realization |
| BackendAssCache C patches (010, 017) are WASM multi-call requirements, not Qt artifacts | Single-call discriminator column in Unit 3 findings table resolves this |
| R7 triggers — experiment fails, >6 C patches load-bearing | Apply experiment-fail disposition (manifest + allowlist merged; branch closed); outcome is still valuable |
| Opportunity cost against P0/P1/P2 active bugs | Experiment requires ~3 build cycles (60-90 min compute) plus analysis. If P0/P1/P2 work is parallel (separate engineer or separate workstream), cost is zero. If single-engineer, schedule after P0 hangs are resolved |

## Sources & References

- `docs/solutions/architecture-patterns/pthread-implementation-spec-2026-09-21.md`
- `docs/solutions/architecture-patterns/pthread-refactor-plan-2026-09-21.md`
- `docs/plans/2026-09-23-001-refactor-pthread-workaround-cleanup-plan.md`
- `scripts/apply-patches.sh`
- `src/compat/overrides/CThread.cpp`
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`
- `src/compat/overrides/CClassificationManager.cpp` — calls 038+039 symbols
- `src/compat/QtCompat.h`
- `patches/038-concrete-ontology-call-generation.patch`
- `patches/039-stage-thread-composite-keys-headers.patch`
