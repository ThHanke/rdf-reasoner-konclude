---
title: "Uninitialized mComplexCandidateProcessingQueuedFlag made sequential realizations lose isRelationOf links"
module: realizer / COptimizedKPSetRoleInstancesItem
tags: [uninitialized-memory, nondeterminism, sequential-calls, realization, isRelationOf, deterministic-scheduler, native-harness, patch-027]
problem_type: logic-error
root_cause: logic_error
resolution_type: code_fix
status: fixed 2026-10-12 (patch 027); supersedes the open items in realization-loss-investigation.md
---

# Uninitialized queued flag -> lossy isRelationOf in sequential realizations

## Problem

Several `materialize()` calls in one process on Roberts sometimes returned fewer `isRelationOf`
triples (step 2 241,756 vs 353,279; ASan, native and WASM all differed from run to run). Only
`isRelationOf` (the top super-role) was affected. Patch 019 had already fixed one missed-requeue
hole, but the loss kept appearing in later steps, never reliably in the first one.

## Root cause

`COptimizedKPSetRoleInstancesItem::mComplexCandidateProcessingQueuedFlag` was never assigned
(not in the constructor, not in `initInstancesItem`). Patch 019's requeue guard
`if (!hasComplexCandidateInstancesProcessingQueuedFlag())` reads it. A fresh process gets zeroed
pages, so the flag is usually false. Later calls reuse freed heap; a non-zero byte reads as
"already queued", the item is skipped, and its complex role candidates are never confirmed
(links stay "possible", untested, and are dropped at readout). Whether the byte is non-zero depends
on allocation history, hence pointer/address/seed/ASan/WASM dependence. The role-state dump showed
`complexQueuedFlag=104`, impossible for a bool.

## Fix

Patch 027: `mComplexCandidateProcessingQueuedFlag = false;` in `initInstancesItem`
(`scripts/mod_027_role_item_flag_init.py`, enabled in `patches/ENABLED`).

## Evidence

| Check | Before | After |
|---|---|---|
| Serial seed 8, 160 individuals (exact reproducer) | -1,042 isRelationOf | clean |
| Full Roberts, serial seed 0, 4 steps | lost at step 3 | 353,279 every step |
| Native multi-threaded, 240 individuals | >=3 of 8 runs lossy | 0 of 12 |
| WASM, 240 individuals, 4 steps | not measured | 0 of 6, canonically equal |
| Full vitest suite | | 573 passed, 1 skipped |

## What did not work (and why)

- ASan: changes allocation addresses (a different "seed"), not a deterministic mode. The old ASan
  binary (before the memory patches) lost data too, so the memory patches were not the cause.
- `REPRO_THREADS=1`, `REPRO_HASH_SEED`, `setarch -R`: still varied. `REPRO_THREADS` only sets
  calculation workers; manager/cache/classifier/realizer CThreads remain separate pthreads.
- Dumping role state after every step: its allocations changed the heap layout and the loss
  disappeared (heisenbug). Dump only after the LAST step.

## How it was found: deterministic serial scheduler

`src/compat/DetSched.h` (native debug builds only): one Konclude thread runs at a time, the next is
chosen by a seeded RNG at blocking points and at random preemption on lock/unlock. QMutex,
QSemaphore, QWaitCondition, QReadWriteLock and the CThread queues are modelled logically, timeouts
use virtual time, deadlocks print all thread states. Run:

```bash
REPRO_SERIAL=1 REPRO_SCHED_SEED=8 REPRO_HASH_SEED=0 setarch -R build-native/konclude_repro \
  --seq "m:F,m:F,m:F,m:F" --dump-role isRelationOf --out DIR     # F = tests/fixtures/roberts-160.nt
```

- ASLR must be off, otherwise the schedule hash (`SCHEDTRACE ... sched=`) differs between runs.
- Same seed + same binary = identical hash and identical result. A hash that diverges between a
  bad and a fixed binary shows the exact step where the fix changes behaviour.
- `scripts/reduce-roberts.py roberts-family.nt out.nt N` cuts the ABox to N connected individuals
  (full TBox). N<=80 never loses data; 160 and 240 do. Serial 160-individual run: ~9 min (vs ~26 min
  per step on full Roberts).
- Method: make it deterministic, find a failing seed, dump kernel state at the last step for a good
  and a bad seed, look for impossible values.

## Prevention

- Initialize every scalar member of kernel items in the constructor or the init function; grep a
  class for members that are only ever assigned through a setter.
- A bool whose printed int value is not 0/1 is an uninitialized read. Print flags as ints in dumps.
- Treat "differs between runs / only in later sequential steps" as an uninitialized-memory suspect
  before a threading suspect; the serial scheduler can rule threading out in one run.
- Open follow-ups: a `MALLOC_PERTURB_` sweep for other uninitialized reads; the question which Konclude
  parts must be serial (actors) vs parallel (task processors) is still unverified, a seeded
  preemption sweep with atomics as yield points would test it.
