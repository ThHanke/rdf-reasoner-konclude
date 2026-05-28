---
module: KoncludeReasoner
tags: [backend-asscache, same-individual, sequential-calls, ontology-id, slot-collision]
problem_type: logic-error
---

# BackendAssCache slot collision suppresses same-individual detection after n≡2 (mod 4) prior calls

## Problem

`materialize()` returns 0 `owl:sameAs` triples for ontologies with `owl:sameAs` assertions when
a specific number of prior reasoning calls have been made on the same `KoncludeReasoner` instance:

- n=3 ABOX materializations + 1 classify → next sameAs materialize: **0 triples** (FAIL)
- n=1, 2, or 4 ABOX materializations + 1 classify → next sameAs materialize: **correct triples** (PASS)

## Root Cause

`KoncludeReasoner::Impl::buildFreshOntology()` assigns a monotonically-increasing unique ontology
ID via `static qint64 sNextOntologyID = 1`. The intent (per comment) was to prevent the
BackendRepresentativeMemoryCache from treating call N as "already complete" because call N-k
had used ID=0.

However, `CBackendRepresentativeMemoryCache` (BackendAssCache) internally maps per-ontology
data to a **fixed-size slot array** using modular indexing (`ontologyID mod SLOT_COUNT`). With
`SLOT_COUNT = 4`, ontology IDs 2 and 6 map to **the same slot** (both ≡ 2 mod 4).

For the failing sequence (initial ID=1, then sequential calls):
| Call | Kind | Ontology ID | Cache slot |
|------|------|-------------|------------|
| init | constructor | 1 | 1 |
| 1 | materialize(ABOX) | 2 | **2** |
| 2 | materialize(ABOX) | 3 | 3 |
| 3 | materialize(ABOX) | 4 | 0 |
| 4 | classify(TBOX) | 5 | 1 |
| 5 | materialize(SAMEAS) | **6** | **2** ← collision with call 1 |

Call 5's ontology (ID=6) reuses slot 2, which still contains stale data from call 1 (Alice+Bob
without any `owl:sameAs`). The `DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL` that the saturation
tries to write for Alice-Eve merging fails to land cleanly, causing
`hasPotentiallySameIndividuals()` to return false and the same-individual realization to produce
no output.

## Impact

- Affects `owl:sameAs` entailment output from `materialize()` only.
- Occurs when `ontologyID mod SLOT_COUNT == ontologyID_of_a_prior_same_or_abox_call mod SLOT_COUNT`.
- The period depends on `SLOT_COUNT` (appears to be 4 in the current build).
- `rdf:type` and object property assertions are less sensitive because they do not rely on
  `DETERMINISTIC_SAME_INDIVIDUAL_SET_LABEL` in the BackendAssCache.
- Incremental reasoning across many ontology versions would hit collisions predictably every
  `SLOT_COUNT` revisions.

## Workaround (plan-027)

The integration test for `owl:sameAs` uses a fresh `RdfReasoner` instance for the sameAs-specific
test case, bypassing the collision. This sidesteps the bug without fixing the underlying cache.

## Proper Fix (deferred)

Replace sequential `sNextOntologyID++` with a random or hash-based ID (e.g., 64-bit random UUID
via `arc4random_buf`) so that slot collisions occur with negligible probability regardless of call
count. Alternatively, investigate whether `CBackendRepresentativeMemoryCache` can be made to use
a hash-map rather than a fixed slot array.

## Discovery Context

Discovered while implementing plan-027 (owl:sameAs output from materialize()). Diagnosed by
sweeping `n_abox ∈ {1,2,3,4}` in a Node.js test harness and observing the n=3 failure.
