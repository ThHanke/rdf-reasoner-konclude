---
title: "WASM realization 'stall' was a pthread stack overflow (64 KiB default stacks)"
date: 2026-11-23
category: runtime-errors
module: wasm-build
component: tooling
problem_type: runtime_error
severity: high
symptoms:
  - "materialize never returns on ROBOT-normalized W3C SymmetricProperty-002 / TransitiveProperty-002 premises"
  - "every thread waits in emscripten_futex_wait; the C++ stall detector (KonStall) does not fire"
  - "native binary SIGSEGVs at 64/128/256 KiB thread stacks, passes from 512 KiB (about 3,400 frames in nominal neighbour expansion)"
  - "removing patch 005 or 002 appeared to change the stall (frame sizes moved across the limit)"
root_cause: config_error
resolution_type: config_change
related_components:
  - development_workflow
tags: [wasm, emscripten, pthreads, stack-overflow, realization, nominals, konclude, native-null-deref]
---

# WASM realization "stall" on normalized premises was a pthread stack overflow

## Problem

`materialize()` (realization) never returned for two ROBOT-normalized W3C premises (`SymmetricProperty-002`, `TransitiveProperty-002`; about 20 triples each) in the WebAssembly build. The same inputs finish natively in about 27 ms, and `checkConsistency` answers in 0.3 s. The cause was not a deadlock. It was a thread stack overflow.

## Symptoms

- `materialize` made no progress until the TypeScript idle watchdog rejected it with `ReasonerStalledError`.
- The C++ detector `KonStall` (`src/compat/KonStall.h`) stayed silent.
- A CPU profile showed every thread in `emscripten_futex_wait`. The manager thread waited in `prepareOntology`, and the role classification steps never completed.
- Only the ROBOT-normalized inputs stalled; the raw W3C premises were fine.
- Removing patch 005 or 002 appeared to change the outcome (Transitive passed without 005, Symmetric still stalled), which looked like a threading race.

## What Didn't Work

- **A deadlock or scheduling hypothesis.** The override layer (`CThread`, `CSingleThreadTaskProcessorUnit` in `src/compat/overrides/`) is the same natively and in wasm; no scheduling difference was found.
- **The null-pointer guard** in `CBackendAssociationCacheHandler::getLoadedNominalIndividualIndirectConnectionData`. It fixed a real native SIGSEGV on `SymmetricProperty-002` (`this == 0`, individual id 7), but the wasm stall stayed. The hypothesis "address 0 is valid memory in wasm, so the same bug corrupts state" was refuted by a rebuild. Keep the guard: it is a separate, real bug.
- **`KonStall`** as a detector: its busy counter is nonzero while a task thread is wedged, so it did not fire.

## Solution

Two link flags in `emscripten.cmake`:

```
"-sSTACK_SIZE=2097152"
"-sDEFAULT_PTHREAD_STACK_SIZE=2097152"
```

Guard: `tests/integration/realization-normalized.test.ts` (both fixtures: consistency, materialize and classify complete; repeated realization in one reasoner keeps working). Both premises now realize in about 0.3 s. Cost: about 40 MiB of the 1 GiB heap for roughly 20 threads.

## Why This Works

The backend-cache neighbour expansion for nominals with self loops recurses about 3,440 frames deep (`getUpToDateIndividual` via `expandIndividualNeighbourNodeFromBackendCache`). Native experiment with `ulimit -s` (threads inherit it): SIGSEGV at 64, 128 and 256 KiB, passes from 512 KiB. The emsdk default pthread stack is 64 KiB. Pthread stacks are malloc'ed from the heap and the build has `ASSERTIONS=0` and no stack check, so an overflow does not trap; it corrupts neighbouring heap memory and the pipeline wedges, which looks like a deadlock. Patches 005 and 002 only change frame sizes, so they moved the requirement across the 64 KiB limit.

Proof in wasm: in a copy of `dist/`, the stack argument of `__emscripten_thread_init` in the glue was raised. At 64 KiB both fixtures stall; at 256 KiB and at 2 MiB both complete in about 0.6 s.

## Prevention

- When a wasm thread pipeline "deadlocks" only for some inputs and the native build passes, test the stack size first: `ulimit -s <KiB>` natively (new threads inherit it) and the glue patch in a copy of `dist/`.
- Build a profiling variant with `-sSTACK_OVERFLOW_CHECK=2` to see whether other stalls are the same overflow.
- Keep the idle watchdog (`stallTimeoutMs`) and the realization test.
- Compare the native and wasm log sequences for the same input: the first step that is logged natively and never in wasm points at the stuck phase.

## Related Issues

- [`docs/pr18-adoption-decisions.md`](../../pr18-adoption-decisions.md) (section 4) and [`docs/pr18-handover.md`](../../pr18-handover.md)
- [`wasm-threading-model-invariants.md`](../architecture-patterns/wasm-threading-model-invariants.md), [`emscripten-pthread-reference-2026-09-21.md`](../architecture-patterns/emscripten-pthread-reference-2026-09-21.md)
- [`pr18-known-conformance-gaps-2026-11-23.md`](../capability-gaps/pr18-known-conformance-gaps-2026-11-23.md)
- [`parallel-agent-kernel-investigation-w3c-regression-gate-2026-11-23.md`](../workflow-issues/parallel-agent-kernel-investigation-w3c-regression-gate-2026-11-23.md): how this cause was found
