---
title: "fix: Make the benchmark numbers valid and characteristic"
type: fix
status: active
date: 2026-10-15
deepened: 2026-10-15
---

# fix: Make the benchmark numbers valid and characteristic

## Overview

`docs/benchmark.md` (regenerated 2026-10-15 on v0.8.0) shows WASM classify times 2-3x slower than the 2026-09-18 table on main (GALEN 1500 vs 544 ms, LUBM+data 2647 vs 1169 ms) while native reproduces. This plan (A) diagnoses the discrepancy with a gate, then (B) rebuilds the benchmark so its numbers mean something and cannot silently shift again, and (C, optional) adds scaling/stability content.

Revised after document review (coherence, feasibility, scope, adversarial): the diagnosis is now a competing-hypotheses test with a pre-stated accept/refute rule, Unit 1 gates the rest, and speculative items were cut or demoted.

## Problem Frame

### Hypothesis H1 (column-boundary shift) — plausible, NOT yet established

The old table's "load" included eager Raptor parse + `mapTriples()` (`loadTripleBuffer`); v0.8.0 `syncTripleBuffer` only hashes/stores buffers, and mapping happens lazily inside the first `classification()`/`realization()`. Work moved from the "load" column to the "classify" column.

| Ontology | old load + classify | new load + classify | delta | old TS total | new TS total | delta |
|---|---|---|---|---|---|---|
| GALEN | 807 + 544 = 1351 ms | 54 + 1500 = 1554 ms | +203 ms (+15%) | 2033 ms | 1890 ms | -143 ms (-7%) |
| LUBM+data | 1427 + 1169 = 2596 ms | 175 + 2647 = 2822 ms | +226 ms (+9%) | 4550 ms | 4273 ms | -277 ms (-6%) |

A pure boundary shift would leave the sums equal. Sums rose ~9-15% while TS totals fell ~6-7%; about 200 ms per ontology is unaccounted for and the two measures disagree in direction. H1 explains most of the column change but not all of it, and nothing here proves "no regression". Same-day A/B of main's committed binary vs branch (GALEN ~2.0 s both, Roberts ~30 s both) is consistent with no end-to-end change but used a different harness than the old table.

### Competing hypotheses to discriminate in Unit 1

| # | Hypothesis | Evidence for | Discriminating measurement |
|---|---|---|---|
| H1 | Boundary shift (mapping moved from load to classify) | `loadTripleBuffer` mapped eagerly; lazy build now | Mapping time from the existing `WASM_TRACE1("BUILD","done", ms=...)` in `src/KoncludeReasoner.cpp`; compare old-load vs new-mapping |
| H2 | Thread configuration: `PTHREAD_POOL_SIZE` 8 -> 32 with `STRICT=2` (emscripten.cmake), plus effective `processorCount()` | `git diff 322b997 HEAD -- emscripten.cmake` | Record `processorCount()` and host cores in both; build one binary variant with pool 8 (ccache, ~6 min) |
| H3 | `--profiling-funcs` added since the old build | same diff | Same variant build without it if H2 variant does not explain |
| H4 | Kernel/patch changes 019-041 (pool reserve/flush 025/026, pool registry 037, cache release 038/041, classifier stale-item flush 040) | those patches add per-call work | Per-step kernel timings (build, preprocess, classify) old vs new on one ontology; pool stats (patch 024 counters) |
| H5 | Cache-sanity regression like b5dd77b (patch-018 accepting stale cache entries gave a documented 2-3x classify slowdown on the same four ontologies) | symptom match | Kernel classify-step time excluding mapping; b5dd77b fixed rows (GALEN 568 ms, LUBM+data 1191 ms) are a second old-path data point |
| — | SatExpCache re-enable | ruled out: disabled in `6a52a98` (09-16), before the 09-18 baseline, and still disabled at HEAD | none needed; record in findings |

Accept/refute rule (fixed before measuring): H1 is **accepted** if, per ontology, (old load + old classify) vs (new ingest + new reasoning) agree within the measured run-to-run spread, **and** the kernel classify-step time excluding mapping is within spread between old and new. Otherwise the residual is attributed to the first of H2-H5 whose isolating experiment closes the gap, or reported as an open regression.

### Other defects in the current benchmark

- Roberts TS row = FAIL: global 600 s subprocess limit (`execFileSync` timeout in `tests/bench/bench.mjs`) is exceeded by warm-ups + 5 runs + explanations at ~40 s each.
- Incremental table: "re-reason speedup 0.1-0.5x" divides warm WASM time by native cold *process* time (Docker spawn + parse + serialize). "Cache hit" is now encode + digest check (270 ms at 100k triples).
- Overhead text asserts causes (pthread round-trips, linear-memory slowdown, "230 ms + factor") never verified on this build; comments elsewhere still say "8 pthreads"/"capped at PTHREAD_POOL_SIZE=8" while the pool is 32 (CLAUDE.md says 32; memory notes said 20).
- "Exact" output match hides equivalent-role representatives differing between builds (`hasChild`/`isParentOf`, 620 pairs). No native golden exists for role assertions.
- One host, small n, no spread, no record of binary hash, sha, CPU, load, thread count, or Docker image versions.
- Native "parse"/"TBox" are scraped from Konclude log lines; what each timer covers (mapping? build? output) has never been checked against WASM sub-steps, so the headline ratio may still not be like-for-like.

## Requirements Trace

- R1. Explain the old/new WASM discrepancy with measurements against the competing hypotheses and the accept/refute rule.
- R2. Every reported comparison is like-for-like; each timing boundary is defined against what native's timers actually cover.
- R3. Results carry metadata and spread sufficient to detect a ~10% difference or to say they cannot.
- R4. No row fails for harness reasons (explicit per-case budgets).
- R5. Replace the incremental/cache table with absolute, correctly named scenarios.
- R6. Output-equivalence claims are limited to what is actually checkable.
- R7. Narrative is data-derived or links to verified findings; no unverified causal claims.
- R8. (Phase C) Scaling series and stability stage.
- R9. Benchmark directory documented and runnable in quick and full modes.

## Scope Boundaries

- No reasoner/kernel behaviour changes; no optimisation work. Diagnostic-only builds (pool-8 variant, trace level) live outside the repo or behind existing flags.
- No new competitor systems.
- Thread-count sweep in WASM is impossible without rebuilding (`processorCount()` is a read-only getter set from `CThread::idealThreadCount()`; only `REPRO_THREADS` in the native debug build overrides). Handled via the H2 variant build or the native debug build, not a runtime sweep.

### Deferred to Separate Tasks

- Optimising mapping/parse in WASM (depends on Unit 1 numbers).
- Explanations/justification-overhead benchmark.
- Second-machine result set; processor-count sweep beyond the H2 variant.

## Context & Research

### Relevant Code and Patterns

- `tests/bench/bench.mjs` (orchestrator, prose generator; 600 s timeout hard-coded in `runInSubprocess`), `wasm-runner.mjs` (direct Embind; silences `print`/`printErr`), `ts-runner.mjs` (`benchOne`, `benchIncremental`), `native-runner.mjs` (Docker log regexes), `robot-runner.mjs`, `sequential-runner.mjs`, `gen-family.mjs`.
- Trace system (v0.7.0 "unified WASM trace", `WASM_TRACE1`) already emits `BUILD done ms=` for mapping/build in `src/KoncludeReasoner.cpp`; use it instead of new instrumentation. Fallback if the trace is not reachable from the Node runner: JS-side timing around the first reasoning call plus a throwaway instrumented build kept outside the repo.
- Old baseline: commit `322b997`; only `dist/konclude.mjs` and `dist/konclude.wasm` are tracked there, JS wrapper must be built from `ts/`; old worker message `loadTripleBuffer` takes `[tripleBuffer, strTableBuffer, bool]`.
- `emscripten.cmake` diff vs old: pool 8 -> 32, strict 2, `--profiling-funcs`.

### Institutional Learnings

- `b5dd77b` (09-15): tag-based sanity check in patch-018 restored classify performance after a 2-3x slowdown — a precedent for H5.
- `6a52a98` (09-16): SatExpCache disabled.
- Run anything >1 min in the background; poll <=4 min; small fixtures first; full Roberts only as a final gate.

### External References

- None needed (local patterns sufficient).

## Key Technical Decisions

- **Unit 1 is a gate.** Units 2-7 do not start until its verdict exists; a "regression" or "open" verdict re-scopes the plan instead of baking the slowdown into a regenerated doc.
- **Two published views**: (a) end-to-end user view = ingest-to-result for WASM vs the native wall-clock inside the container (or native `Total processing time`, whichever Unit 2 shows covers the same work); (b) kernel-only view from the shared pipeline steps in the kernel log. Both labelled; neither replaces the other. Phase splits are breakdown only.
- **A/B across builds through one harness** with an adapter for old `loadTripleBuffer`, run alternating old/new, so the measurement path is not a variable.
- **Spread rule**: report n, min/median/max and IQR; flag rows with spread >10% (the effect size under investigation is ~10-15%); rows with n<5 are labelled "indicative only".
- **Per-case budget lives in a registry** (explicit timeout and run count per case), not a calibration run; policy: first run >10 s -> n=3, no warm-up.
- **Prose is template-driven**; causal explanations only from verified findings, linked from `docs/solutions/`.

## Open Questions

### Resolved During Planning

- Regression or not? Unresolved by design; decided by the Unit 1 rule above (earlier draft's "probably not" removed).
- Need external research? No.
- Is a runtime thread sweep possible? No (see Scope Boundaries).
- SatExpCache as cause? Ruled out.

### Deferred to Implementation

- Which native log lines cover mapping/build/output (Unit 2 inspects `native-runner.mjs` regexes against a real native log).
- Whether the trace output (`BUILD done`) reaches the Node runner without code changes (else the fallback in Context).
- Whether to put stability results in `docs/benchmark.md` (ask the user at Phase C).
- Role-equivalence normalisation scope (Unit 5 decides after checking that the 620-pair case is explained by explicit input axioms).

## Implementation Units

### Phase A — diagnosis (gate)

- [x] **Unit 1: Reconcile old vs new numbers** (done 2026-10-15; see `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md` — verdict: boundary shift, small +4..+7% residual on LUBM cases, H2/H3 untested)

**Goal:** Reach an accept/refute verdict on H1 and attribute any residual to H2-H5.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `tests/bench/ab-compare.mjs` (one case against a checkout path; phases, end-to-end, trace-derived mapping time, `processorCount()`)
- Create: `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md` (findings; includes the config/patch delta list and the rule outcome)

**Approach:**
- Worktree recipe for the old build: `git worktree add` at `322b997`, `npm ci` (or link `node_modules`), build TS, confirm committed `dist/konclude.mjs` is already patched (`npm run patch-wasm` is idempotent), copy `ts/worker-node.mjs` into `dist/`. Drive old Embind directly with `loadTripleBuffer(ptr, n, strPtr, len, flag)` as the old runner did, and new Embind with `syncTripleBuffer(...)`.
- Capture module `print`/`printErr` (the runner currently discards them) to read trace/kernel step lines.
- Alternate old/new/old/new, n>=5 per ontology on LUBM schema, GALEN, LUBM+data; Roberts once per build. Record load average at start; run native Konclude in the same session as a host-state reference.
- List deltas: `git diff 322b997 HEAD -- emscripten.cmake patches src/KoncludeReasoner.cpp`.
- If the rule does not close the gap: build the pool-8 variant (H2), then the no-profiling variant (H3), then per-step comparison for H4/H5; each only as needed.
- Also compare main's committed binary vs the branch binary under the same harness.

**Test scenarios:**
- Test expectation: none -- diagnostic measurement; the result is the findings document.

**Verification:**
- Findings doc states per ontology old vs new (load+classify, kernel classify step, end-to-end) with spread, the rule outcome, which hypotheses were tested, and a one-line verdict: boundary shift / explained by H2-H5 / open regression (follow-up plan filed).

### Phase B — rebuild the benchmark (only after Unit 1 verdict)

- [ ] **Unit 2: Define timing boundaries against native's real timers**

**Goal:** Like-for-like comparison with each number defined.

**Requirements:** R2, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/bench/native-runner.mjs`, `tests/bench/wasm-runner.mjs`, `tests/bench/ts-runner.mjs`, `tests/bench/bench.mjs`

**Approach:**
- First inspect what `Ontology parsed in`, `Finished class classification in`, `Total processing time` etc. actually cover in a real native log (parse? mapping? build? output write?); record in the doc's definitions.
- WASM: `ingest` (sync), `reasoning` (classify/realize incl. lazy mapping), `output`, `ingest-to-result`; init reported once, outside ratios.
- Publish the two views from Key Technical Decisions; drop the old "classify vs TBox" ratio (or keep as labelled secondary only if boundaries match).

**Test scenarios:**
- Test expectation: none -- harness definitions; checked by regeneration in Unit 7.

**Verification:**
- Every ratio column cites matching boundaries in a one-line definition; native wall-clock-in-container vs `Total processing time` difference is documented.

- [ ] **Unit 3: Methodology hardening and metadata**

**Goal:** Reproducible, judgeable results; no harness-caused failures.

**Requirements:** R3, R4

**Dependencies:** Unit 1

**Files:**
- Create: `tests/bench/stats.mjs`, `tests/bench/cases.mjs` (registry: fixture, profile, timeout, runs), `tests/unit/benchStats.test.ts`
- Modify: `tests/bench/bench.mjs`, `tests/bench/ts-runner.mjs`, `tests/bench/wasm-runner.mjs`

**Approach:**
- Metadata block: git sha, binary sha256, package version, CPU model, cores, load average, Node version, `processorCount()`, pool size, Docker image digests, native Konclude version, HermiT/ROBOT version.
- Per-case timeout and run count from `cases.mjs`; first-run >10 s -> n=3, no warm-up; rows with n<5 labelled indicative.
- Report n, min/median/max, IQR; flag spread >10%.
- `--quick` (LUBM schema + GALEN, n=3) and `--case NAME`.
- Fix stale "8 pthreads" text and comments.

**Test scenarios:**
- Happy path: [100, 110, 120] -> min 100, median 110, max 120, spread 18% -> flagged.
- Edge case: single sample and empty list return defined values without NaN.
- Edge case: even-length median matches the existing `median` in `native-runner.mjs`.
- Edge case: spread flag triggers exactly above 10%.

**Verification:**
- Roberts TS row produces numbers; every row shows n, spread and an indicative marker where applicable; metadata block present.

- [ ] **Unit 4: Honest warm-behaviour scenarios**

**Goal:** Replace the incremental/cache table.

**Requirements:** R5, R2

**Dependencies:** Unit 3

**Files:**
- Modify: `tests/bench/ts-runner.mjs` (`benchIncremental`), `tests/bench/bench.mjs`

**Approach:**
- On one reasoner: cold first call; unchanged-content call (named for what it costs: encode + digest check); one-axiom change (full rebuild). Absolute ms only; no speedup ratio vs native.
- Runner asserts the digest semantics it relies on (unchanged -> generation same; changed -> generation bumps) with a few lines and aborts if violated.

**Test scenarios:**
- Test expectation: none -- harness; guarded by the runner's assertions.

**Verification:**
- No ratio-to-native column; scenario names match behaviour.

- [ ] **Unit 5: Limit and correct output-equivalence claims**

**Goal:** State only what is verified.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `tests/bench/bench.mjs`
- Create (only if kept after the check below): `tests/bench/equivalence.mjs`, `tests/unit/benchEquivalence.test.ts`

**Approach:**
- rdf:type: exact comparison against native goldens (all three fixtures are committed; `tests/fixtures/roberts-native-abox.nt`, `lubm-native-tbox.nt`, `galen-native-tbox.nt`).
- Role assertions: no native golden; doc states this. First check whether the 620-pair `hasChild`/`isParentOf` difference is explained by explicit `owl:inverseOf`/`owl:equivalentProperty` axioms in the input (or only by inferred equivalence). If yes, normalise by that closure and keep the helper; if not, compare closure sets of the v0.8.0 build vs the v0.7.2 build (the `322b997` binary from Unit 1) only and drop the helper.

**Test scenarios:**
- Happy path: outputs differing only by `hasChild(x,y)` vs `isParentOf(x,y)` for equivalent roles compare equal after normalisation.
- Edge case: a genuinely missing assertion with no equivalent-role counterpart is reported.
- Edge case: inverse chain normalises to one orientation.
- Error path: input without equivalence axioms behaves as raw set comparison.
- (Tests exist only if the helper is kept; bench-helper tests live in `tests/unit/` and are cheap, so they stay in the main suite.)

**Verification:**
- Doc says exactly what is compared (types exact; roles per the chosen method).

- [ ] **Unit 6: Regenerate docs and prune prose**

**Goal:** `docs/benchmark.md` generated from measured data plus verified, linked explanations.

**Requirements:** R7, R9

**Dependencies:** Units 1-5

**Files:**
- Modify: `tests/bench/bench.mjs`, `docs/benchmark.md`, `package.json` (`bench`, `bench:quick`)
- Create: `tests/bench/README.md`

**Approach:**
- Delete causal paragraphs not backed by Unit 1; add "Reading these numbers" (boundary definitions, single host, spread, Docker overhead on native/HermiT, minimum detectable difference).
- Link the Unit 1 findings doc. If Unit 1's verdict was an open regression, the doc carries a visible caveat and a link to the follow-up plan.
- `--quick` first; full run in the background as the final gate.

**Test scenarios:**
- Test expectation: none -- documentation generation; verified by a full run with no FAIL/TIMEOUT rows.

**Verification:**
- Full run completes (metadata is emitted by the run itself and pasted into the doc header by the generator; no separate persistence); doc has metadata, spread, definitions, both views; grep for removed model terms ("230 ms", "Scaling model", "8 pthreads") returns nothing.

### Phase C — optional follow-up

- [ ] **Unit 7: Scaling series and stability stage**

**Goal:** Show scaling, not four anecdotes; measure the v0.8.0 stability gain.

**Requirements:** R8

**Dependencies:** Units 3, 6

**Files:**
- Modify: `tests/bench/cases.mjs`, `tests/bench/sequential-runner.mjs`, `tests/bench/bench.mjs`, `tests/bench/gen-family.mjs`

**Approach:**
- Size series on existing fixtures (Roberts-160/240; Roberts-405 and larger LUBM behind a flag after estimating total full-run time). LUBM schema labelled a startup probe, excluded from ratio headlines.
- `--stability`: N changed-content calls on roberts-160 with explicit N and per-call timeout in `cases.mjs`; abort if result size varies or a call exceeds its timeout.
- Ask the user whether stability output belongs in `docs/benchmark.md`; default if unanswered: keep it in the bench output and `tests/bench/README.md`, not in the doc.

**Test scenarios:**
- Test expectation: none -- generation; the stability stage asserts constant result size and aborts otherwise.

**Verification:**
- Scaling table for at least two families; with `--stability`, per-call table with constant result size.

## System-Wide Impact

- **Interaction graph:** tooling only (`tests/bench/`, `docs/`, `package.json` scripts).
- **Error propagation:** harness aborts on semantic violations instead of printing misleading numbers.
- **Integration coverage:** old-vs-new A/B needs a second checkout and an old-API adapter; recipe is in Unit 1.
- **Unchanged invariants:** the published package and the test suite (573/574) are untouched. NOTE: the WASM binary and kernel patches differ from the old baseline (pool 32, profiling flag, patches 019-041) — that difference is precisely what Unit 1 measures; it is not an invariant.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Old build unusable under current Node/toolchain | recipe in Unit 1; fall back to comparing main's committed binary and b5dd77b rows |
| Trace/kernel logs unavailable on the WASM path | JS-side timing + throwaway instrumented build outside repo |
| Host noise hides a 10-15% effect | alternating runs, n>=5, load average recorded, same-session native reference, IQR, minimum-detectable-difference stated |
| Real regression found | plan re-scoped at the gate; doc caveat + follow-up plan |
| Native timers do not cover the same work as WASM sub-steps | Unit 2 inspects real logs first; two labelled views |
| Cost of Roberts runs | background + single waiter; quick mode for iteration; large cases behind flags |

## Documentation / Operational Notes

- Add `tests/bench/README.md`; update `docs/benchmark.md`.
- Record Unit 1 in `docs/solutions/performance-issues/` and mention any between-release number movement caused by boundary changes in the next release notes.

## Sources & References

- Benchmark docs: `docs/benchmark.md` (current) and `322b997:docs/benchmark.md` (old numbers)
- Related code: `tests/bench/*.mjs`, `src/KoncludeReasoner.cpp` (`syncTripleBuffer`, `WASM_TRACE1`), `emscripten.cmake`
- History: `b5dd77b` (cache sanity slowdown precedent), `6a52a98` (SatExpCache disabled), `d72537d` (09-18 baseline binary)
- Related notes: `docs/release-notes-v0.8.0.md`, `docs/solutions/architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md`
