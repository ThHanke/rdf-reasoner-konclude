---
module: KoncludeReasoner
tags: [backend-asscache, same-individual, sequential-calls, ontology-id, open-investigation]
problem_type: logic-error
status: corrected 2026-05-28 — mechanism description updated; root cause still under investigation
---

# BackendAssCache corruption suppresses same-individual detection after n=3 prior ABox calls + classify

## Problem

`materialize()` returns 0 `owl:sameAs` triples for ontologies with `owl:sameAs` assertions when
a specific number of prior reasoning calls have been made on the same `KoncludeReasoner` instance:

- n=3 ABOX materializations + 1 classify → next sameAs materialize: **0 triples** (FAIL)
- n=1, 2, or 4 ABOX materializations + 1 classify → next sameAs materialize: **correct triples** (PASS)

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
