---
title: "PMDco 0.8.0 to 0.9.x slowdown (3x Node, 10x Chromium): completed classification plus C++ exception cost"
date: 2026-11-12
category: performance-issues
module: wasm-kernel
problem_type: performance_issue
component: tooling
severity: high
symptoms:
  - PMDco (checkConsistency + materialize) 1.3 s in 0.8.0, 4.1 s in 0.9.x in Node; 1.8-2.6 s vs 17-19 s in Chromium
  - Chromium burned 111-114 CPU-seconds for 24.8 CPU-seconds of Node work on the same input
  - checkConsistency took as long as a full classification
root_cause: algorithmic_cost_and_exception_cost
resolution_type: build_flags_and_kernel_patch
tags:
  - wasm
  - exceptions
  - chromium
  - classification
  - profiling
  - patch-009
---

# PMDco 0.8.0 to 0.9.x slowdown

## What was wrong (three independent causes, each measured)

1. **0.8.0 was fast because it skipped work.** Its buffered, sorted possible-subsumption flush ran after the items to test had been collected, so about 4,760 candidate subsumptions on PMDco (sibling pairs under one parent, almost all negative) were never tested (0 calculated tests). Patch 009 (v0.9.0) fixed that, correctly: unmodified native Konclude runs the same tests (9.6 s for the classification on one worker; WASM 10.1-10.4 s on one pinned core). Bisect of 0.9.0 sources: patch 009 alone is the whole slowdown; patches 005-008 cost nothing. On the repo's PMDco fixture it adds exactly 2 edges, on Pizza 70.
2. **`checkConsistency` classified.** `consistency()` requested the whole pipeline (`...consistency, precompute-saturation, class-classify...`), then `materialize` reloaded (load-variant switch) and classified again. Consistency is a prerequisite of classification, not the reverse; the native `consistency` command stops at `OPSCONSISTENCY`. It now does too (`src/KoncludeReasoner.cpp`, `runPipeline(..., consistencyOnly)`): 2.4 s to 0.4 s.
3. **The tableau ends OR-branching tasks with a C++ exception.** `executeORBranching` creates the branch tasks and throws `CCalculationStopProcessingException(true)`, caught in `handleTask`. About 324,000 throws per classification. In situ throw-to-catch latency: 3.1 us in Node, 77-79 us in Chromium 158: 25 of 35 CPU-seconds. The primitive itself is cheap in both (microbenchmark: 0.6-3 us for a shallow throw); what makes it expensive in the real module was not isolated (frame size matters: 0.5 us for a tiny function, 34 us through a 5,000-call-site function; `handleTask` is the second-largest function of the module).

## Fixes

- `-fwasm-exceptions` instead of `-fexceptions` (+ drop `NO_DISABLE_EXCEPTION_CATCHING`): Node CPU -20 %, Chromium CPU -30-35 %.
- Binaryen at link time (`--no-wasm-opt` and `--profiling-funcs` removed from the default link; `KONCLUDE_PROFILING_FUNCS=ON` re-adds them): 10.4 MB to 7.05 MB.
- Consistency-only pipeline.
- Patch 005 `or-branching-stop-flag`: on the direct rule chain the task end is a flag (`mKonStopPending`) instead of the exception. Result: Chromium 5.0 s / 35 CPU-s to 2.0 s / 12.7 CPU-s.

## How it was diagnosed (reusable)

- **Names in profiles:** `KONCLUDE_PROFILING_FUNCS=ON make build-wasm`, then `tests/bench/browser-profile.mjs` (raw CDP, `Target.setAutoAttach` flattened into every worker including the pthread pool, `Profiler.start`). Blocked threads show as `(idle)`, `emscripten_futex_wait`, `__pthread_cond_timedwait`: not CPU.
- **Spinning vs work:** CPU-seconds were constant across 1/2/4/8 cores (Node 24 s) and across Chromium core counts: work, not spinning. Kernel time was 1.6 s of 110.
- **In-situ cost of a suspected operation:** global atomics in the kernel printed through the classifier's `LOG(INFO, getLogDomain(), ...)` statistics line, collected with `onTrace`. Only that route reaches the browser: `LOG` from the tableau domain, `fprintf(stderr)` and `console` from pthreads are not delivered.
- **Microbenchmarks** in the same emsdk (a small C++ throw/catch file at several stack depths and function sizes) separate the engine primitive from the application.
- **Comparing against native:** upstream `konclude/konclude` with `-w 1` and its own "Finished class classification in N ms".

## What did not help (all measured, reverted)

Transitive one-hop subsumption skip (fired once in 4,764 tests); re-enabling the pseudo-model pre-test (decided 2 of 4,761; it had been disabled by old patch 023); pausing a task without exception (not the dominant throw); catching in a small `noinline` wrapper (the optimizer folded it back into `handleTask`: its `try` count rose 151 to 154); `--js-flags=--no-liftoff` (whole-module optimizing compile: 51 CPU-s); `Error.stackTraceLimit=0` (no effect).

## Pitfalls met on the way

- Source files are CRLF: patch scripts must read and write with `newline=''`.
- `open(p,"w").write(modify(open(p).read()))` truncates the file before reading; generate and inspect the patch before applying.
- A leftover benchmark loop and other sessions load the host: compare CPU-seconds, interleave runs, and check `ps` before timing.
- Classifier statistics (calculated/confirmed/invalidated tests) vary between identical runs because of parallel scheduling; they are not an identity gate. Edge sets, inferred triple sets and the suite are.

## Open

The flag covers the direct chain only; the nested immediate-processing path and the other `Stop(true)` sites still throw (`scripts/returncode/` holds the AST analysis and a generator scaffold: 264 closure functions, 964 call sites, 110 hard).
