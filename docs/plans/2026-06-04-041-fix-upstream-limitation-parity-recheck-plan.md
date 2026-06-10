---
title: "fix: re-investigate and resolve remaining UPSTREAM_LIMITATION parity skips"
type: fix
status: active
date: 2026-06-04
---

# fix: re-investigate and resolve remaining UPSTREAM_LIMITATION parity skips

## Overview

After plan-040 (SI-expressiveness realization hang), 10 `it.skip` tests remain labeled
`UPSTREAM_LIMITATION`. Several of these labels predate patch-030 and may now be incorrect.
This plan re-investigates each skip systematically: confirm native Konclude behavior per
fixture using delta-debugging, re-run the current WASM build, and categorize each as
(a) WASM regression now fixed, (b) truly upstream with a C++ fix attempt, or (c) truly
upstream with no viable C++ fix (JS workaround as last resort). The goal is correct C++
behavior across all affected ontologies, not narrow JS patches.

## Problem Frame

The test suite currently shows 313 passing / 10 skipped. The skips were marked at
different points in development, some before recent patches (024–030). The guiding
question: **are these limitations of native Konclude v0.7.0, or failures of the WASM
port compared to native behavior?** Either way, the primary fix approach is C++: if native
works we find the WASM regression; if native hangs we diagnose where in the precomputing
kernel the hang fires and attempt a targeted fix before falling back to JS workarounds.

## Requirements Trace

- R1. Any skip whose native behavior completes correctly must be activated as a passing
  test or receive a targeted fix, not left as a perpetual skip
- R2. Any skip confirmed as a true native Konclude v0.7.0 bug must have a C++ fix
  attempted first. JS-layer workaround only if C++ investigation finds no viable fix.
- R3. All 313 currently-passing tests continue to pass after each fix unit
- R4. Native Konclude Docker must be the ground truth for every affected fixture before
  any code change is committed for that fixture
- R5. Parity gap matrix (`docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`)
  is updated to reflect post-fix state

## Scope Boundaries

- Only the 10 remaining `it.skip` tests in `owl2dl-parity.test.ts` and
  `property-characteristics.test.ts` are in scope
- Upstream Konclude source contributions are out of scope; fixes work within
  `src/`, `ts/`, `patches/`, and test files
- plan-038 (unified parity test suite) is a separate initiative; do not merge concerns

### Deferred to Separate Tasks

- Data property materialization probes (conditional skips near lines 971/1008 in
  `property-characteristics.test.ts`) — handled separately if needed

## Context & Research

### Skip Inventory and Current Status

| # | File | Test description | Last confirmed native | Current WASM | Category |
|---|------|-----------------|----------------------|--------------|----------|
| 1 | `owl2dl-parity.test.ts:357` | complementOf named-class ABox clash | Wrong (native bug) | Hangs | C++ fix or JS fallback |
| 2 | `owl2dl-parity.test.ts:497` | NPA/materialize blank-node hang | **NOT confirmed for realization** | Hangs | Needs native realization test |
| 3 | `owl2dl-parity.test.ts:839` | FunctionalProperty/checkConsistency | Hangs ALIF+ precompute | Hangs | **C++ delta debug** |
| 4 | `owl2dl-parity.test.ts:847` | FunctionalProperty/classify | Hangs ALIF+ precompute | Hangs | **C++ delta debug** |
| 5 | `owl2dl-parity.test.ts:855` | FunctionalProperty/materialize | Hangs ALIF+ precompute | Hangs | **C++ delta debug** |
| 6 | `owl2dl-parity.test.ts:878` | InverseFunctionalProperty/materialize | Hangs ALIF+ (30 s) | Hangs | **C++ delta debug** |
| 7 | `property-characteristics.test.ts:250` | FunctionalProperty sameAs inference | Hangs ALIF+ precompute | Hangs | **C++ delta debug** |
| 8 | `property-characteristics.test.ts:360` | AllDisjointClasses negative probe (NTriples) | Works ~8ms (R7a) | **Likely fixed by patch-030** | Verify + activate |
| 9 | `property-characteristics.test.ts:383` | disjointUnionOf entailment probe (NTriples) | Works ~9ms (R7b) | **Likely fixed by patch-030** | Verify + activate |
| 10 | `property-characteristics.test.ts:417` | NPA consistent materialize (NTriples) | **NOT confirmed for realization** | Hangs | Needs native realization test |

### Relevant Code and Patterns

- **Precomputing kernel:** `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
  (2714 lines) — handles concept saturation → individual saturation → consistency; the
  ALIF+ hang fires somewhere in this chain when equality propagation for FP/IFP is triggered
- **Precomputation override:** `src/compat/overrides/CPrecomputationManager.cpp` — singleton
  precomputator management; not the saturation code itself
- **Patch pattern:** `patches/030-saturation-clash-combined.patch` — how to add
  targeted C++ fixes without full overrides; `patches/031-realizer-verbose-logging.patch`
  — how to add `fprintf` instrumentation via a patch with `#ifdef` guard
- **JS pre-process pattern:** `ts/index.ts` lines 607–621 — `differentFrom` reflexive
  short-circuit; only use this pattern if C++ investigation finds no fix
- **Native test method:** `docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest realization -i /data/<fixture>.nt -o /data/<out>.owl` (stdout = logs; `-o` = OWL/XML)

### Institutional Learnings

- `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` —
  native ground truth for R4, R8; NPA realization was NOT tested there
- `docs/solutions/capability-gaps/si-realization-hang-native-trace-2026-06-03.md` —
  delta debugging methodology that found the SI hang; same approach applies to ALIF+
- Memory `feedback_saturation_patch_placement.md` — saturation clash checks go BEFORE
  `othIndiNode` branch, not inside it
- Memory `feedback_wasm_rebuild_sentinel.md` — delete `vendor/konclude/.patches-applied`
  before docker rebuild or patches are silently skipped
- Memory `project_sequential_call_fix.md` — if equality merges accumulate state across
  calls (like the BackendAssCache n=3 isolation bug), `reset()` or `stopAndClearRealizers()`
  may need updating after a fix

## Key Technical Decisions

- **Re-test WASM before any code change**: Tests 8 and 9 are likely already passing
  with the current build. Verify first, write no code until confirmed.
- **Native confirmation before every fix**: Per R4, run native Docker on each fixture
  before claiming upstream vs. regression. NPA realization has never been tested against
  native — this is the first thing that must happen.
- **C++ delta debugging for ALIF+ — not JS workaround**: The correct approach is to
  bisect the ALIF+ hang to a minimal fixture pair (one triple difference), then instrument
  `CTotallyPrecomputationThread.cpp` with `fprintf` at phase gates, rebuild WASM, and
  observe where Fixture B diverges from Fixture A. JS workaround is only a fallback if
  this investigation finds the bug unresolvable.
- **Post-fix cleanup scope**: If the ALIF+ C++ fix works, equality merges may accumulate
  state in the BackendAssCache or sameAs tables across sequential calls. The `reset()` and
  `stopAndClearRealizers()` paths in `src/KoncludeReasoner.cpp` must be audited to ensure
  equality state is properly cleaned. Test infrastructure (fresh `RdfReasoner` instances
  in FP/IFP tests) already guards against this, but the pattern must be confirmed.
  Additionally, if the `differentFrom` JS pre-process (`ts/index.ts` lines 607–621)
  becomes redundant after the C++ fix, it should be removed.
- **R4 complementOf**: TBox regression blocks the C++ patch attempt from plan-039.
  Diagnose the regression first. Preferred fix is JS pre-process (trivially detectable
  pattern; native is already wrong so this is a WASM-layer addition, not a kernel correction).
- **NPA realization hang**: Not confirmed against native. Gate all NPA fix work on Unit 2.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not
> code to reproduce.*

```
For each of the 10 skipped tests:

  1. Run native Konclude Docker on the test fixture (if not already confirmed)
     │
     ├─ Native HANGS → upstream bug — attempt C++ fix
     │    │
     │    ├─ Build minimal delta fixture pair (differ by 1 triple)
     │    ├─ Instrument CTotallyPrecomputationThread.cpp with fprintf at phase gates
     │    ├─ Rebuild WASM, observe where Fixture B log stops vs Fixture A
     │    ├─ Apply targeted C++ fix → both native + WASM benefit
     │    └─ If no viable C++ fix found → JS workaround as fallback only
     │
     └─ Native COMPLETES → WASM regression
          │
          └─ Try current WASM build first (patch-030 may have already fixed it)
               ├─ WASM now passes → activate test (stale skip)
               └─ WASM still fails → diagnose + C++ patch
```

**ALIF+ delta debugging fixtures (FunctionalProperty — bisection pair):**

```
Fixture A — SHOULD PASS (one filler, no equality chain needed):
  hasMother rdf:type owl:ObjectProperty, owl:FunctionalProperty
  alice, eve rdf:type owl:NamedIndividual
  alice hasMother eve

Fixture B — HANGS (one extra triple: forces sameAs):
  [Fixture A] +
  carol rdf:type owl:NamedIndividual
  alice hasMother carol        ← this single triple triggers ALIF+ hang

Divergence point = last [WASM-PRECOMP] log line in Fixture B vs last in Fixture A
```

Same bisection for IFP: Fixture C (one subject → one object) vs Fixture D (two subjects
→ same object). Possible intermediate experiments: omit `owl:NamedIndividual` typing,
use `owl:DatatypeProperty` instead — these narrow the exact trigger condition.

**Key C++ code path:** `CTotallyPrecomputationThread.cpp` phases:

```
createSaturationConstructionJob()           → concept saturation
addRequiredSaturationIndividuals()          → individual saturation queue
saturateRemainingRequiredSaturationIndividuals() → individual sat execution
isAllAssertionIndividualSaturationSufficient()   → completion check
[equality propagation for FP/IFP here]     → ← likely hang location
```

## Implementation Units

---

- [ ] **Unit 1: Verify and activate stale skips 8 and 9 (NTriples AllDisjointClasses / disjointUnionOf)**

**Goal:** Confirm that tests 8 and 9 in `property-characteristics.test.ts` now pass with
the current WASM build. Activate them.

**Requirements:** R1, R3.

**Dependencies:** None (current WASM build used; no rebuild).

**Files:**
- Modify: `tests/integration/property-characteristics.test.ts` — activate lines 360 and 383
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`

**Approach:**
- Change `it.skip(` → `it(` for both blocks
- Test 9 body fix: replace the conditional pass-through (`if (!emitsSuper) expect(emitsSuper).toBe(false)`)
  with a direct `expect(emitsSuper).toBe(true)` — the conditional trivially passes
  regardless of WASM output; native confirms the triple is emitted
- Run `npm test`; if either hangs revert and document as a separate NTriples-path bug

**Test scenarios:**
- Happy path: `materialize(ALL_DISJOINT_CLASSES_NEGATIVE_NTRIPLES)` → `x rdf:type B` is `false`
- Happy path: `materialize(DISJOINT_UNION_OF_ENTAILMENT_NTRIPLES)` → `x rdf:type C` is `true`
- Regression: all 313 existing tests still pass

**Verification:**
- `npm test` shows 315 passing, 8 skipped

---

- [ ] **Unit 2: Run native Konclude on NPA realization fixtures**

**Goal:** Confirm whether native Konclude v0.7.0 `realization` hangs on consistent NPA
fixtures. This result gates all NPA fix work in Unit 6.

**Requirements:** R4.

**Dependencies:** None.

**Files:**
- Create: `docs/solutions/capability-gaps/npa-realization-native-trace-2026-06-04.md`

**Approach:**
- Extract `NEGATIVE_PROPERTY_ASSERTION_CONSISTENT_NTRIPLES` from `property-characteristics.test.ts`
  and the NPA section from `abox.ttl` to `/tmp/konclude-test/`
- Run `docker run --rm ... realization -i /data/npa-consistent.nt -o /data/npa_out.owl` (15s timeout)
- Record full stdout; note whether OWL/XML output file is produced or the process times out

**Test scenarios:**
Test expectation: none — pure research unit.

**Verification:**
- Investigation log exists with actual Docker output and clear verdict: HANGS or COMPLETES

---

- [ ] **Unit 3: Find minimal ALIF+ delta-debug fixtures using native Konclude**

**Goal:** Establish two minimal deterministic NTriples fixture pairs — Fixture A (passes)
and Fixture B (hangs, differs from A by exactly one triple) — for FunctionalProperty and
InverseFunctionalProperty. These form the instrumentation baseline for Unit 4.

**Requirements:** R4.

**Dependencies:** None.

**Files:**
- Create: `docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md`
  — all four fixtures (A/B for FP, C/D for IFP), Docker commands, native behavior,
  expressiveness labels for each

**Approach:**
- **Fixture A (FP, one filler):** `hasMother` FP + `alice hasMother eve` only. Run
  `realization` (15s timeout). Expected: completes.
- **Fixture B (FP, two fillers):** Fixture A + `alice hasMother carol`. Expected: hangs.
- **Fixture C (IFP, one subject):** `hasDNA` IFP + `alice hasDNA seq1`. Expected: completes.
- **Fixture D (IFP, two subjects):** Fixture C + `bob hasDNA seq1`. Expected: hangs.
- Record expressiveness labels from native stdout for all four fixtures
- Try intermediate variants: no `owl:NamedIndividual` typing, `owl:DatatypeProperty`
  instead of `owl:ObjectProperty` — narrow the exact trigger condition
- If Fixture A also hangs: the threshold is not about the number of fillers; bisect further
  (FP only, no ABox at all; FP + one typed individual but no assertion)

**Test scenarios:**
Test expectation: none — pure research unit.

**Verification:**
- Four fixtures documented with actual Docker run output
- Exactly one triple separates passing from hanging in each pair
- Expressiveness labels recorded for all four

---

- [ ] **Unit 4: Instrument C++ precomputing code — find ALIF+ hang point**

**Goal:** Add `fprintf(stderr, "[WASM-PRECOMP] ...")` log points to
`CTotallyPrecomputationThread.cpp` via a patch, rebuild WASM, run Fixtures A and B,
and identify the exact phase gate where Fixture B diverges (last log line before hang).

**Requirements:** R4.

**Dependencies:** Unit 3 (fixtures confirmed).

**Files:**
- Create: `patches/032-precomp-verbose-logging.patch` — log points at phase gates;
  guarded by `#ifdef WASM_PRECOMP_VERBOSE` (same pattern as `031-realizer-verbose-logging.patch`)
- Modify: `src/CMakeLists.txt` — add `option(WASM_PRECOMP_VERBOSE ...)` (same pattern
  as existing `option(WASM_REALIZATION_VERBOSE ...)`)
- Update: `docs/solutions/capability-gaps/alif-plus-delta-debug-fixtures-2026-06-04.md`
  — add WASM log observations section

**Approach:**
- Apply patches: `rm -f vendor/konclude/.patches-applied && bash scripts/apply-patches.sh`
- Add `fprintf` log points in `CTotallyPrecomputationThread.cpp` at:
  1. Entry: individual count, whether individual saturation is required
  2. After concept saturation job creation
  3. Entry of `saturateRemainingRequiredSaturationIndividuals()` — individual count
  4. Entry of `addRequiredSaturationIndividuals()` — count added
  5. After `isAllAssertionIndividualSaturationSufficient()` — result
  6. Any equality-merge or sameAs-propagation function called during saturation
- Generate patch: `git -C vendor/konclude diff > patches/032-precomp-verbose-logging.patch`
- Restore vendor: `git -C vendor/konclude checkout -- .`
- Rebuild WASM (ccache makes this fast — only one file changes)
- Run Fixtures A and B via temporary reproducer; compare log output

**Patterns to follow:**
- `patches/031-realizer-verbose-logging.patch` — patch structure, `#ifdef` guard
- `src/CMakeLists.txt` — `option(WASM_REALIZATION_VERBOSE ...)` for the new flag

**Test scenarios:**
Test expectation: none — instrumentation unit.

**Verification:**
- Fixture A logs all phase gates to completion
- Fixture B logs subset; last log line before hang documented
- Patch exists and applies cleanly; WASM rebuild succeeds

---

- [ ] **Unit 5: Fix the ALIF+ precomputing hang in C++ and activate FP/IFP tests**

**Goal:** Apply a targeted C++ fix at the hang point identified in Unit 4. Rebuild WASM.
Activate all 5 FP/IFP tests (tests 3–7). Audit and clean up equality-related state
in the reset path.

**Requirements:** R1, R2, R3.

**Dependencies:** Unit 4 (hang point confirmed).

**Files:**
- Create: `patches/033-alif-plus-precomp-fix.patch` — targeted fix at the identified
  hang location; follows pattern of `030-saturation-clash-combined.patch`
- Modify: `tests/integration/owl2dl-parity.test.ts` — fill bodies and activate skips
  at lines 839 (checkConsistency), 847 (classify), 855 (materialize), 878 (IFP/materialize)
- Modify: `tests/integration/property-characteristics.test.ts` — activate skip at line 250
- Audit: `src/KoncludeReasoner.cpp` — verify `reset()` and `stopAndClearRealizers()`
  clean any equality-merge state that the fix introduces; add cleanup if needed

**Approach:**
- Fix strategy depends entirely on Unit 4's finding. Most likely candidates:
  - **Zero-work completion path not firing**: same class as plan-040 fix — the equality
    saturation step completes but `setStepFinished(true)` / `submitRequirementsUpdate()`
    is never called; add the completion signal
  - **Infinite equality propagation loop**: FP + two fillers creates a merge chain that
    cycles; add a guard on already-processed node pairs
  - **WASM pthread race on equality merge**: inter-thread signaling for merge events
    doesn't work in WASM pthreads; apply same semaphore drain / signal pattern as
    `CSingleThreadTaskProcessorUnit.cpp`
- After fix: rebuild WASM, verify Fixture A still completes and Fixture B now completes
  with correct output (Fixture B should emit `eve owl:sameAs carol`)
- **Reset path audit**: equality merges may add entries to BackendAssCache or sameAs
  tables that persist across calls. The existing `stopAndClearRealizers()` in `reset()`
  was added in plan-039 to handle realizer thread cleanup; check whether equality tables
  in the precomputer also need clearing between calls. The FP/IFP tests already use fresh
  `RdfReasoner` instances, so inter-call contamination is not tested — add a sequential
  call test if the audit finds shared state.
- **Check `differentFrom` JS pre-process**: if the C++ equality fix correctly handles
  the reflexive case (`x differentFrom x`), remove the JS short-circuit in
  `_checkConsistencyOnQuads()` (`ts/index.ts` lines 607–621) and verify the test still
  passes via the kernel path instead.
- Fill empty test bodies for tests 3 and 4 using native Fixture A/B output for expected
  values; test 5 and 7: `eve owl:sameAs carol` (or `carol owl:sameAs eve`); test 6:
  `alice owl:sameAs bob` (or `bob owl:sameAs alice`)

**Test scenarios:**
- Happy path FP: `materialize(FUNCTIONAL_NTRIPLES)` → `eve owl:sameAs carol` emitted, no hang
- Happy path IFP: `materialize(ifpQuads)` → `alice owl:sameAs bob` emitted, no hang
- Happy path consistency: `checkConsistency(fpOneFiller)` → `true`, no hang
- Happy path classify: `classify(fpTBox)` → completes (TBox output confirmed from Unit 3)
- Sequential call: two sequential `materialize()` calls on FP fixture → same output, no
  state contamination from equality tables
- Regression: Fixture A (one filler) → no sameAs, completes normally
- Regression: all 315 previously-passing tests still pass after WASM rebuild

**Verification:**
- `npm run patch-wasm && npm run build && npm test` passes
- Test count increases to ≥320 passing (313 + 2 from Unit 1 + 5 FP/IFP activated)
- No hang timeouts

---

- [ ] **Unit 6: Act on NPA native finding (tests 2 and 10)**

**Goal:** Apply the Unit 2 verdict. If native hangs → relabel both NPA/materialize tests
as `CONFIRMED_UPSTREAM_LIMITATION`. If native completes → investigate WASM regression.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** Unit 2.

**Files (scenario A — native hangs):**
- Modify: `tests/integration/owl2dl-parity.test.ts` — update comment at line 497
- Modify: `tests/integration/property-characteristics.test.ts` — update comment at line 417
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`

**Files (scenario B — native completes = WASM regression):**
- Create: `patches/034-npa-realization-fix.patch` (or override) — fix the WASM regression
- Modify test files to activate with assertions

**Approach (scenario B):**
- First check whether current WASM build already passes (patch-030 may have fixed this
  too, same as R7a/R7b). Run `materialize(NPA_CONSISTENT_NTRIPLES)` against current WASM.
- If still hanging: re-enable realizer instrumentation (`WASM_REALIZATION_VERBOSE`) to
  isolate hang point; apply same pattern as plan-040 Unit 2

**Test scenarios:**
- Scenario A: tests remain skipped with accurate native evidence
- Scenario B: `materialize(NPA_CONSISTENT_NTRIPLES)` completes; `alice knows bob` is
  NOT in the result (NPA carries no positive assertion)
- Regression: all passing tests unchanged

**Verification:**
- Unit 2 log is the authority; tests updated accordingly

---

- [ ] **Unit 7: Diagnose R4 complementOf TBox regression and implement fix**

**Goal:** Characterize the TBox regression from plan-039's complementOf fix attempt, then
implement the fix. Preferred approach: JS pre-process (`ts/index.ts`) scanning for
`A owl:complementOf B` + individual typed both A and B → return `false` without calling
WASM. This avoids repeating the TBox regression and is semantically correct (native is
already wrong here; any fix is a WASM-layer addition).

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None (independent of ALIF+ units).

**Files:**
- Create: `docs/solutions/capability-gaps/r4-complementof-diagnosis-2026-06-04.md`
  — records native classification output for complementOf TBox, identifies regression cause
- Modify: `ts/index.ts` — add pre-process in `_checkConsistencyOnQuads()` (preferred)
- Modify: `tests/integration/owl2dl-parity.test.ts` — activate skip at line 357

**Approach:**
- Run native `classification` on `A owl:complementOf B` (TBox only, no ABox) to see
  what class hierarchy is emitted — this establishes what the previous patch was trying to
  preserve
- Run native `consistency` on ABox clash fixture to confirm native returns consistent (wrong)
- Read git history or any surviving patch to understand what plan-039's attempt changed
  and why it caused the TBox regression
- Implement JS pre-process: scan quads for `?A owl:complementOf ?B` (where both A and B
  are NamedNodes, not blank nodes); for each such pair, check whether any quad types an
  individual as both A and B; if so return `false` immediately from `checkConsistency()`
  before `encodeToBuffers()`. Pattern: `ts/index.ts` lines 607–621.

**Test scenarios:**
- Happy path: `checkConsistency()` with `Pos complementOf Neg` + `posNeg rdf:type Pos, Neg`
  → returns `false`
- Edge case: `A complementOf B` declared but individual only in A → returns `true` (no clash)
- Edge case: `A complementOf BNode:restriction` — blank-node complement object → NOT handled;
  scope limited to named-class pairs only
- Regression: TBox classification tests that previously broke must still pass

**Verification:**
- `npm run build && npm test` — complementOf test now active and passing
- No TBox classification regressions

---

- [ ] **Unit 8: Update parity gap matrix and verify final test counts**

**Goal:** Update gap matrix and memory with definitive post-plan-041 status.

**Requirements:** R5, R3.

**Dependencies:** All prior units.

**Files:**
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Modify: memory `project_owl2dl_parity_gaps.md`

**Approach:**
- Record final status for each of the 10 original skips
- Target: ≥320 passing, ≤4 skipped (NPA if native-confirmed-upstream + any ALIF+ ops
  where the C++ fix doesn't extend to classify/checkConsistency)

**Test scenarios:**
Test expectation: none — documentation unit.

**Verification:**
- `npm test` shows expected passing/skipped counts; gap matrix matches

---

## System-Wide Impact

- **Precomputing pipeline**: Unit 5 C++ fix affects `CTotallyPrecomputationThread.cpp`
  equality propagation path. Must not break concept saturation for non-FP/IFP ontologies
  (Fixtures A/C are the regression guard). The fix must leave the existing BackendAssCache
  Update2 completion pattern intact.
- **Reset path**: If the C++ fix adds equality state to precomputer-level tables, the
  `reset()` path in `src/KoncludeReasoner.cpp` must clean it. The existing
  `stopAndClearRealizers()` handles the realizer; check whether a matching call is needed
  for precomputing equality tables. Fresh `RdfReasoner` in tests already isolates — but
  sequential calls on a shared instance must also be correct.
- **`differentFrom` JS pre-process**: If the C++ fix handles reflexive equality, the
  `_checkConsistencyOnQuads()` short-circuit (lines 607–621 of `ts/index.ts`) may become
  redundant. Audit after Unit 5 and remove if so.
- **Test count invariant**: 313 currently-passing tests must pass after every unit.
- **WASM rebuilds**: Units 4 and 5 each require one. Unit 7 (JS-only) and Unit 6 (JS or
  possible patch) may require one more. Maximum three rebuilds total.
- **Unchanged invariants**: `checkConsistency()`, `classify()`, `materialize()` public
  API signatures unchanged. No new npm package API surface.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Tests 8/9 still hang (NTriples vs Turtle path differs) | Low | Low | Unit 1 verifies first; revert and document if hang persists |
| Fixture A also hangs (ALIF+ threshold is not the filler count) | Low-Med | Med | Bisect further: FP only no ABox; FP + one untyped individual; narrow trigger before instrumenting |
| C++ ALIF+ hang unfixable without deep algorithm rework | Med | High | Fall back to JS workaround (detect FP/IFP + multiple fillers → compute sameAs in JS, skip WASM); this is the fallback not the plan |
| ALIF+ fix introduces equality state not cleared between calls | Med | Med | Sequential call regression test; audit `reset()` path in Unit 5 |
| differentFrom JS pre-process removal breaks test | Low | Low | Run full suite before removing; if fails, keep both the C++ fix and JS pre-process (defense in depth) |
| R4 complementOf JS fix misses multi-hop complement chains | Low | Low | Scope to direct named-class pairs only; document multi-hop as deferred |
| NPA is a WASM regression (scenario B in Unit 6) | Low-Med | Med | Realizer instrumentation patch-031 can be re-enabled with `WASM_REALIZATION_VERBOSE`; apply same plan-040 fix pattern |

## Phased Delivery

### Phase 1 — Verify stale skips and gather native evidence (Units 1–3, no rebuild)
Confirms tests 8/9 are already fixed, gathers NPA native verdict, and establishes ALIF+
minimal fixture pair. Fast — all Docker + current WASM. Expected: 2 tests activated.

### Phase 2 — C++ ALIF+ investigation and fix (Units 4–5, 2 WASM rebuilds)
Instruments precomputing kernel, finds hang point, applies fix. Activates up to 5 FP/IFP
tests. Audits reset path and cleans up differentFrom JS pre-process if redundant.

### Phase 3 — NPA and complementOf (Units 6–7, 0–1 WASM rebuilds)
Unit 6 depends on Unit 2 verdict. Unit 7 is JS-only. At most one additional rebuild
if NPA is a WASM regression.

### Phase 4 — Documentation (Unit 8)
Gap matrix update. Closes the plan.

## Sources & References

- Native investigation: `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md`
- SI hang delta debug: `docs/solutions/capability-gaps/si-realization-hang-native-trace-2026-06-03.md`
- Gap matrix: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Precomputing kernel: `vendor/konclude/Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp`
- Instrumentation pattern: `patches/031-realizer-verbose-logging.patch`
- Saturation fix pattern: `patches/030-saturation-clash-combined.patch`
- Reset path: `src/KoncludeReasoner.cpp`
- Plan-039: `docs/plans/2026-06-03-039-fix-owl2dl-parity-gap-closure-plan.md`
- Plan-040: `docs/plans/2026-06-03-040-fix-wasm-si-realization-hang-plan.md`
