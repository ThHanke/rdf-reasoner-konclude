---
module: KoncludeReasoner
tags: [backend-asscache, same-individual, sequential-calls, ontology-id, open-investigation]
problem_type: logic-error
status: corrected 2026-05-29 — further narrowed; root cause still open
---

# BackendAssCache corruption suppresses same-individual detection after n=3 ABox + classify

## Problem

`materialize()` returns 0 `owl:sameAs` triples for ontologies with `owl:sameAs` assertions under
a specific combination of prior reasoning calls:

- n=3 ABOX materializations **with object property assertions (e.g. Alice knows Bob)** + 1 classify (full TBox) → next sameAs materialize: **0 triples** (FAIL)
- n=3 ABOX materializations **without** object property assertions + 1 classify → **correct triples** (PASS)
- n=3 ABOX + 0 classify → **correct triples** (PASS)
- n=3 ABOX + classify + 1 more ABOX → **correct triples** (PASS)

## Narrowed Root Cause

The trigger requires: (1) Alice-knows-Bob object property assertion in prior ABOX calls, AND
(2) a TBox-only classify call with a multi-class hierarchy (Animal/Mammal/Dog, 2 subclass axioms).
The simpler TBox (just Animal/Mammal, 1 subclass) does NOT trigger the failure.

The Alice-knows-Bob relationship creates `NEIGHBOUR_INSTANTIATED_ROLE_SET_COMBINATION_LABEL`
entries in the BackendAssCache's permanent context. After the full TBox classify, the BackendAssCache's
`mSlotUpdateWaitingIncreaseCount` reaches a higher value, which combined with the accumulated
neighbour label state causes the sameAs detection in Round 2 (Eve's `requireSameAsNeighboursCompletion`
path) to fail to set Eve's `DeterministicMergedSameConsideredLabelCacheEntry` with Alice's ID.

Exact failure path in `installAssociationUpdates` / `completeDeterministicSameAsMergingInformation`
remains under investigation.

## Root Cause

Exact failure path is still under investigation.

`KoncludeReasoner::Impl::buildFreshOntology()` originally assigned ontology IDs via a monotonically-increasing
`static qint64 sNextOntologyID = 1`. This was replaced with a `std::mt19937_64` random 63-bit ID generator
in plan-029. The sequential counter was provably unsafe — any mechanism keyed on ID values (hash bucket
distribution, stale-entry lookup, saturation concept hashing, etc.) could produce periodic failures at
predictable call counts — but the random-ID fix alone did **not** resolve the n=3 failure. The regression
test added in plan-029 (Unit 2) confirmed that 0 `owl:sameAs` triples are still returned after exactly
3× materialize(ABOX) + 1× classify(TBOX).

### Corrected Cache Structure

An earlier version of this document incorrectly described `CBackendRepresentativeMemoryCache` as using a
"fixed-size slot array with SLOT_COUNT=4 and modular indexing (`ontologyID mod SLOT_COUNT`)". That
description was wrong. The actual structures are:

- `mOntologyIdentifierDataHash` — a dynamic `CCACHINGHASH` (Qt open-addressing hash map) keyed by
  `cint64` ontologyID. `getOntologyData(id)` calls `mOntologyIdentifierDataHash->value(id)` — a standard
  hash-map value lookup, **not** modular slot indexing.
- `mFixedOntologyIdentifierDataHash` — a never-evicted `QHash` also keyed by `cint64` ontologyID.
  Accumulates one entry per completed reasoning call; no eviction occurs.

Neither structure uses fixed-size modular indexing. The n=3 failure pattern is not explained by a
SLOT_COUNT=4 collision model.

## Impact

- Affects `owl:sameAs` entailment output from `materialize()` only.
- Reproducible at exactly n=3 prior ABox materialize calls + 1 classify call on the same instance.
- `rdf:type` and object property assertions are unaffected.

## Workaround (plan-027, still active)

The integration test for `owl:sameAs` uses a fresh `RdfReasoner` instance for the sameAs-specific
test case, bypassing the corruption. This sidesteps the bug without fixing the underlying cache.

A regression test (`it.fails`) was added in plan-029 to document the exact failure sequence:
3× materialize(ABOX) + classify(TBOX) + materialize(SAMEAS). Remove `.fails` when the root cause is fixed.

## Proper Fix (deferred — root cause still unknown)

The random-ID fix (plan-029 Unit 1) eliminates sequential-counter ID collision as a root cause and is
retained as a correctness improvement. However, the n=3 failure persists. The actual failure path likely
involves BackendAssCache internal state that is not properly reset between calls — candidates include:

- Stale `mFixedOntologyIdentifierDataHash` entries affecting the fixed-reader path
  (`createOntologyFixedCacheReader`, `CBackendRepresentativeMemoryCache.cpp` lines 520–528)
- `DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL` write failures in the saturation path after cache state
  accumulated from prior calls
- Cache reader/writer synchronization across the `reset()` boundary

Recommended next step: instrument `CBackendRepresentativeMemoryCache` with WASM_VERBOSE_LOGGING or
a native build to trace `mFixedOntologyIdentifierDataHash` lookups and writes across the n=3 sequence.

## Discovery Context

Discovered while implementing plan-027 (owl:sameAs output from materialize()). Diagnosed by sweeping
`n_abox ∈ {1,2,3,4}` in a Node.js test harness and observing the n=3 failure. Mechanism description
corrected and random-ID fix attempted in plan-029; root cause remains open.
