---
title: Self-invalidating reasoner API (content digest + lazy rebuild)
date: 2026-10-10
module: KoncludeReasoner, RdfReasoner
tags: [cache, sync, generation, wasm, heap]
problem_type: architecture-pattern
---

# Self-invalidating reasoner API

## Contract
- `syncTripleBuffer(tri, n, str, len)` -> 1 changed / 0 unchanged / -1 invalid. Digest = set of 128-bit hashes over (type tag, term string); literals normalised to `value\0datatype\0lang`. Full set equality decides; added/removed counts come for free (`lastSyncAdded/Removed`), usable by a future incremental realizer.
- Retained wire buffers (`mPendTri/mPendStr`) feed the lazy `ensureBuilt(variant)`; the loaded ontology has `mBuiltGen`, `mBuiltDigest`, variant, `mPipeLevel`. Change + change-back before any verb: no rebuild (digest equals built digest). Failed pipeline sets `mBuiltGen=-1` so the next verb retries from retained content.
- Results of a stale generation are hidden (`mClassified/mRealized=false`) until the next verb.
- Variants are not interchangeable: realization pre-scans FP/IFP and drops declarations; consistency/classification keep native IFP semantics. classify->materialize or materialize->consistency rebuilds once. Per-op result retention (serve realization result after a consistency rebuild) is NOT implemented.
- Worker: `sync` (alias `loadTripleBuffer`), `syncStats` -> `{generation, rebuilds, triples}`. No reset in the call flow; `reset()` is explicit teardown.
- TS: `_sync(store, ignoreGraph)` returns the generation; caches `{store, gen}`; stall recovery and Worker recycle clear them (generations restart in a new Worker).

## Gotchas found
- **Pointers above 2 GiB are negative in Embind `int`.** `HEAPU8.slice(ptr, ptr+len)` then reads foreign memory (end-relative index): zero/partial inferred quads, "Invalid typed array length", only when a Roberts-size run pushed the heap past 2 GiB (looked like "fails only under suite load"). Fix: `>>> 0` in worker.ts/inlineWorker.ts; `readResult` also validates the header and rebuilds.
- N3 parsers give new blank-node labels per parse, so re-parsing the same Turtle with blank nodes is a content change (conservative by design).
- Recycle the Worker only on `changed:true`; recycling on every sync destroyed the cache-hit path.

## Tools
`konclude_repro --mode sync-scenarios fixture.nt`, `--mode seq-sync --seq ...` (`REPRO_MODE=seq-sync scripts/seq-sample.sh`), `tests/integration/self-invalidating-cache.test.ts`.

## See also
- Memory: Worker recycle is the backstop only; the retained heap per call was mostly scheduler free-pool reserves, fixed natively (patches 025/026): [scheduler-free-pool-memory-retention-2026-10-11.md](../performance-issues/scheduler-free-pool-memory-retention-2026-10-11.md).
