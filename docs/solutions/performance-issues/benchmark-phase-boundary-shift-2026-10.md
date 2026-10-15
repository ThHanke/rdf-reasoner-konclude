---
title: WASM benchmark "2-3x slowdown" between 2026-09-18 and 2026-10-15 is a phase-boundary shift
date: 2026-10-15
module: tests/bench
problem_type: performance
tags: [benchmark, wasm, syncTripleBuffer, loadTripleBuffer, measurement]
---

# Benchmark phase-boundary shift (v0.7.2 -> v0.8.0)

## Symptom

`docs/benchmark.md` regenerated on v0.8.0 showed WASM "classify" 2-3x slower than the 2026-09-18 table (GALEN 1500 vs 544 ms, LUBM+data 2647 vs 1169 ms) while native reproduced.

## Verdict

**Not a regression.** The old `loadTripleBuffer` parsed and mapped triples eagerly (counted as "load"); `syncTripleBuffer` (v0.8.0) only hashes/stores the buffers and mapping happens lazily inside the first `classification()`/`realization()` (counted as "classify"). End-to-end ingest-to-result is equal on GALEN and Roberts and within +4..+7% on the two LUBM cases.

## Method

Same harness (`tests/bench/ab-compare.mjs`, driven by `tests/bench/ab-run.mjs`) against two checkouts: v0.7.2 (`322b997`, built TS + its committed `dist/konclude.*`) and v0.8.0 (`a7fcbc1`). Direct Embind use, one cold module per run, old/new alternated, n=5 (Roberts n=1), host 8-core Xeon Silver 4216, load average at start 2.8-3.3 (other sessions share the host; the first attempts at load ~15 were discarded). Times in ms, median [min..max]. ingest-to-result = load + reasoning + output decode (init excluded).

| Case | old load | old reasoning | old total | new load | new reasoning | new total | delta |
|---|---|---|---|---|---|---|---|
| LUBM schema (classify) | 20 | 359 | 390 [361..394] | 1 | 398 | 405 [400..428] | +4% |
| GALEN (classify) | 1071 | 717 | 1824 [1775..1841] | 14 | 1765 | 1814 [1792..1860] | -0.5% |
| LUBM schema+data (realize) | 1295 | 1539 | 3276 [3200..3289] | 41 | 2972 | 3498 [3473..3551] | +6.8% |
| Roberts (realize, n=1) | 71 | 27544 | 27958 | 5 | 26522 | 26981 | -3.5% |

GALEN: old load 1071 ms is the eager mapping; new reasoning grew by ~1048 ms. Inferred-quad counts are identical (LUBM+data 138 522 both).

## Hypotheses (plan `docs/plans/2026-10-15-001-fix-benchmark-validity-plan.md`)

| H | Status |
|---|---|
| H1 boundary shift | Accepted for GALEN and Roberts (sums within spread / better). LUBM schema and LUBM+data show a small residual of +4..+7% (ranges do not overlap; LUBM+data reasoning +138 ms, output decode +77 ms). |
| H2 pool 8 -> 32 | **Untested.** An attempted pool-8 build produced a byte-identical binary and glue: the build directory reuses the cached CMake configuration, so `emscripten.cmake` flag edits need a reconfigure (clear `build/CMakeCache.txt`) to take effect. `processorCount()` is 8 in both. |
| H3 `--profiling-funcs` | Untested (same reconfigure requirement). |
| H4 patches 019-041 (pool flush/reserve, per-call release) | Plausible source of the +4..+7% residual (per-call release work, output path); not isolated. |
| H5 cache-sanity regression (b5dd77b pattern) | Not supported: GALEN is flat; a 2-3x classify regression would show there. |
| SatExpCache | Ruled out: disabled in `6a52a98` (before the 09-18 baseline) and still disabled. |

## Measurement notes

- WASM kernel logs do not contain per-pipeline-step timings (`Finished preprocessing in ...` is native-only); `WASM_TRACE1` is compile-time gated off in the shipped binary. Phase attribution therefore uses JS-side timers around load / reasoning / output.
- Host load matters: a first attempt at load average ~15 gave unusable numbers (another session was running a test suite). `ab-run.mjs` waits for a quiet host before each case but cannot prevent concurrent external load.
- Old/new in separate processes; init (~1.1 s) excluded from ratios.

## Consequences for the benchmark

- Compare **ingest-to-result**, never "classify" alone, across releases.
- The 2026-09-18 table's WASM classify numbers (and its "WASM/Konclude" ratio) used the old boundary; do not compare them against v0.8.0 classify.
- Open (small): the +4..+7% LUBM residual; reconfigure-and-rebuild a pool-8 and a no-profiling variant if it matters.
