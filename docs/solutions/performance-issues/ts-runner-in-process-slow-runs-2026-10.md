---
title: TS-layer benchmark runner — intermittent 4-5x slow Roberts runs when several reasoners live in one process
date: 2026-10-15
module: tests/bench
problem_type: performance
tags: [benchmark, ts-runner, roberts, wasm, pthreads, measurement]
---

# In-process repetition produced intermittent slow Roberts runs

## Symptom

The previous `ts-runner.mjs` created a fresh `RdfReasoner` per run but ran all runs (plus an explanation pass) in one Node process. On Roberts, some runs took 4-5x longer than the rest: full Roberts 225-275 s vs 29 s; roberts-240 60-73 s vs 13-17 s. The runs were slow inside the kernel (eight kernel threads at ~94% CPU in `realization()`, confirmed with a Node diagnostic report of the Worker stack), not in the TS layer or result injection.

## What was ruled out

- Explanation pass (on/off), forced GC between runs, triple order of the clone, TS-layer result handling: none made the effect appear or disappear reliably.
- Host contention: four CPU hogs made both v0.7.2 and v0.8.0 ~1.4x slower (19 s vs 18.5 s on roberts-240) with no slow mode.
- Not a stall: all worker threads busy, results complete.

## Evidence for the cause class

- The slow mode appeared only in runs that created several `RdfReasoner` instances in one process (the runner: 4 of 4 batches; a hand-written probe doing the same: once; other in-process probes: not seen in ~30 runs).
- **One fresh process per measurement showed no slow run at all**: 16 alternating runs on roberts-240 (8 per build), v0.7.2 13.4-13.8 s, v0.8.0 13.1-13.3 s; full Roberts 5 runs 29.4-33.1 s (spread 12%), constant inferred count 352 108.

## Decision

The TS-layer benchmark measures every run in its own process (`tests/bench/simple-run.mjs`, `simple-warm.mjs`), which also matches the definition of "cold". The in-process phenomenon is not explained; it is a known risk for any caller that creates and terminates many Workers in one process (see also the existing guidance to share one reasoner per test file).

## Side observation

With the same harness v0.7.2 returned two different inferred counts across eight identical runs (131 543 and 132 202), v0.8.0 returned the same count every time (132 198): the lossy/nondeterministic realization fixed by the realizer patches is visible in plain repeated runs.

## Update: the library itself creates a second Worker in the same process

The warm scenario run in a fresh process with ONE `RdfReasoner` still showed the effect on the call after a large one: Roberts "one axiom added" 29.8 s, 48.6 s (median), 218.7 s over three repetitions. After a call that pushed the WASM heap past `recycleHeapBytes` (2 GiB), a changed load makes the TS layer `terminate()` the Worker and immediately start a new one in the same process (`ts/index.ts`, recycle path). That is the same "second module in one process" situation as the old runner, and it is intermittently 1-7x slow. The sequential test's one-off 20 s call among ~6 s calls (roberts-160, call 7, right where RSS crossed 2 GiB) is probably the same event. No CPU quota applies (cgroup `cpu.max` = max, no throttling on this host). A plausible mechanism, not verified: `Worker.terminate()` is asynchronous, so the old Worker's busy kernel threads can still be running while the new module starts, oversubscribing 8 cores with a spin-waiting kernel.

## Resolution (2026-10-16): not caused by the recycle

`tests/bench/recycle-probe.mjs` runs 8 changed-content calls on roberts-160 in one process, three variants (one run each, sequential, no other load):

| Variant | per-call ms |
| --- | --- |
| recycle every call, `terminate()` not awaited | 7249 8597 8479 7142 11641 8416 8469 11581 |
| recycle every call, `terminate()` awaited | 7934 8585 11656 11635 8417 11727 7461 8567 |
| no recycle (control) | 7904 12117 7281 6498 8493 18578 6505 6246 |

The control (single Worker, no recycle, the first call included) shows the same outliers (up to 2.9x), so the recycle and the async `terminate()` are not the trigger. Awaiting `terminate()` changes nothing; the OS thread count stays at 44 after each recycle, so old kernel threads do not overlap. Slow calls burn proportionally more CPU (e.g. 54 s vs 80-137 s for the same input), i.e. the kernel does more or spins more work: the same unexplained step-time variance seen natively (17-97 s, handover item 2). The earlier "second module in one process" explanation (old runner, recycle) is withdrawn; remaining lead is the nondeterministic scheduler (`REPRO_SERIAL=1 REPRO_SCHED_SEED`). Treat Roberts timings as having a heavy upper tail regardless of recycle.
