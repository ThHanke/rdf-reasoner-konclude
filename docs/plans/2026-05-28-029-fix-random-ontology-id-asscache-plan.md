---
title: "fix: randomize ontology IDs to prevent BackendAssCache corruption on sequential calls"
type: fix
status: active
date: 2026-05-28
---

# fix: randomize ontology IDs to prevent BackendAssCache corruption on sequential calls

## Overview

`KoncludeReasoner::buildFreshOntology()` assigns ontology IDs from a monotonically-increasing
`static qint64 sNextOntologyID`. Empirically, exactly n=3 prior ABox materializations followed
by a `classify()` call causes the next `materialize()` call to return 0 `owl:sameAs` triples
(though the fixture is valid). Replacing the sequential counter with a 64-bit random ID
eliminates ID-based collision as a root cause and is low-risk given the cache structure.

## Problem Frame

Symptoms recorded in `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`.
Root cause mechanism: unknown precisely. The solutions doc mis-attributes the bug to a
"fixed-size slot array with SLOT_COUNT=4" — the actual `CBackendRepresentativeMemoryCache`
uses a dynamic `CCACHINGHASH` (Qt hash map) for `mOntologyIdentifierDataHash` and a
never-evicted `QHash` (`mFixedOntologyIdentifierDataHash`) keyed by ontology ID. Neither
structure uses fixed modular indexing. The exact failure path at n=3 is an open question;
however, the sequential ID assignment is provably unsafe: any mechanism that keyed behavior
on ID values (hash bucket distribution, fixed-hash stale-entry lookup, saturation concept
hashing, or anything else) could cause periodic collisions at predictable call counts.

The workaround in `tests/integration/abox-realization.test.ts` (fresh `RdfReasoner` per
sameAs/data-prop test) masks the bug but does not fix it for production workloads.

## Requirements Trace

- R1. `materialize()` on the same `KoncludeReasoner` instance returns correct `owl:sameAs`
  output regardless of how many prior `materialize()`/`classify()` calls were made
- R2. Ontology IDs are non-repeating and non-periodic within any single WASM module lifetime
- R3. The solutions doc accurately describes the cache mechanism
- R4. No regression in existing 198/198 tests

## Scope Boundaries

- Replace sequential IDs with 64-bit random IDs; do NOT change the cache read/write logic
- Do NOT attempt to identify the exact cache code path that produces the n=3 failure; that
  is deferred investigation work

### Deferred to Separate Tasks

- Identify the precise code path in `CBackendRepresentativeMemoryCache` that produces the
  n=3 symptom: likely a follow-up investigation with WASM_VERBOSE_LOGGING or native build
- Remove the fresh-reasoner workaround from the integration test: only after the regression
  test confirms the fix resolves the n=3 symptom
- Memory growth: `mFixedOntologyIdentifierDataHash` accumulates one entry per completed call
  and never evicts; long-running server use cases may need explicit cleanup — out of scope here

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` `buildFreshOntology()` lines 331–347: the only fresh-ID
  assignment in the WASM build (`static qint64 sNextOntologyID = 1; ... sNextOntologyID++`)
- Three copy-propagation callers exist in realizer/classifier/answerer (pass the existing ID
  to a temporary ontology), none assign a fresh ID — they are unaffected by this change
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`:
  `mOntologyIdentifierDataHash` (dynamic `CCACHINGHASH`, hash-map) and
  `mFixedOntologyIdentifierDataHash` (never-evicted `QHash`) both keyed by `cint64` ontologyID
- `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheSlotItem.cpp`
  line 61–67: `getOntologyData(id)` does `mOntologyIdentifierDataHash->value(id)` — hash map
  lookup, not modular slot indexing
- `src/compat/CSingleThreadTaskProcessorUnit.cpp` `startProcessing()` lines 286–343: stale
  semaphore drain fix for sequential calls — adjacent concern, not affected by ID change

### Institutional Learnings

- `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
  — records the symptom and incorrect mechanism description; this plan corrects it (Unit 3)
- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
  — STPU stale semaphore is a related sequential-call class of bug; the ID fix is orthogonal

### Available Entropy (WASM Build)

- `std::mt19937_64` + `std::random_device` from `<random>` (C++17, always available in
  Emscripten 3.1.73). `std::random_device` reads `/dev/urandom` via Node.js `crypto` in
  worker mode — non-deterministic, sufficient entropy for this purpose
- `std::chrono::steady_clock::now()` + address-space hash as fallback seed if
  `std::random_device` throws
- `arc4random()`/`arc4random_buf()` is available in Emscripten's musl libc but untested in
  this codebase — prefer the `<random>` approach for portability

## Key Technical Decisions

- **`std::mt19937_64` seeded from `std::random_device`, with chrono+address fallback**: Avoids
  relying on the `<cstdlib>` `rand()` / `qrand()` path (which is deterministically seeded with 0
  due to the `QTime` stub in `QtCompat.h`). MT19937-64 generates 64-bit values directly with
  a period of 2^19937−1 — negligible collision probability.
- **Mask to positive `cint64`**: `cint64` is `int64_t`; the high bit must be 0 to avoid
  negative IDs. Apply `& 0x7FFFFFFFFFFFFFFFull` to the raw generator output.
- **Function-local static generator**: Initialize once in `buildFreshOntology()` via a lambda
  IIFE. The static is per-process (not per-`Impl`) — correct, since the BackendAssCache is also
  a server-lifetime singleton and IDs must be unique across all `KoncludeReasoner` instances.

## Open Questions

### Resolved During Planning

- **Is the BackendAssCache a fixed-size slot array?** No — it is a dynamic hash map
  (`CCACHINGHASH`) and an accumulating `QHash`. The solutions doc was wrong. (See research.)
- **Does `getOntologyData()` use modular slot indexing on the ID?** No — it uses
  `mOntologyIdentifierDataHash->value(id)`, a standard hash-map value lookup.
- **Can we use `std::random_device` in Emscripten 3.1.73 node mode?** Yes — Emscripten
  maps `random_device` to `/dev/urandom` via Node.js `crypto` in worker threads. Confirmed
  available; adding chrono fallback for robustness.

### Deferred to Implementation

- **Does the random-ID fix actually resolve the n=3 failure?** Verifiable only after WASM
  rebuild + regression test run. The fix is low-risk regardless of the root-cause mechanism.
- **Can the fresh-reasoner workaround in `tests/integration/abox-realization.test.ts` be
  removed after the fix?** Yes, if the regression test (Unit 2) passes. Remove the workaround
  only after confirming.

## Implementation Units

- [ ] **Unit 1: Replace sequential `sNextOntologyID` with `std::mt19937_64` random IDs**

**Goal:** Eliminate periodic ID repetition / hash-collision potential as a root cause of
BackendAssCache corruption on sequential calls.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `src/KoncludeReasoner.cpp`

**Approach:**
- In `buildFreshOntology()`, replace the `static qint64 sNextOntologyID = 1; ... sNextOntologyID++`
  block with a function-local static `std::mt19937_64` initialized once via an IIFE
- Seed with `std::random_device{}()` in a try/catch; fall back to
  `std::chrono::steady_clock::now().time_since_epoch().count()` XOR-ed with a
  `std::hash<void*>` of the generator's address on failure
- Sample: `static_cast<qint64>(gen() & 0x7FFFFFFFFFFFFFFFull)` to stay in the positive
  `cint64` range
- Add `#include <random>` if not already present; `#include <chrono>` is already included
- The IIFE lambda should be the simplest construct that initializes and returns the generator;
  no external seeding ceremony is required
- Document the single-caller assumption with a comment alongside the static generator:
  `buildFreshOntology()` is always called from the Worker's single dispatch thread (JS Worker
  serializes all WASM calls); no mutex is needed. If future architecture ever calls
  `buildFreshOntology()` from multiple threads, a `std::mutex` guard or `std::atomic` ID
  counter will be required

**Patterns to follow:**
- Existing `static` local pattern in `buildFreshOntology()` for `sNextOntologyID`
- `std::chrono::steady_clock::now()` already used in `KoncludeReasoner.cpp` for logging

**Test scenarios:**
- Happy path: two successive `materialize()` calls on the same instance receive different
  ontology IDs (observable indirectly via correct output from both calls)
- Integration coverage: the n=3 regression test (Unit 2) is the primary verification vehicle
- Edge case: the generator does not repeat an ID in a 100-call sequence (extremely low
  probability to fail; omit as an explicit test — the math provides assurance)

**Verification:**
- WASM compiles cleanly (`docker compose run --rm build` exits 0)
- `npm run patch-wasm && npm run build && npm test` shows 198+ tests passing, no regressions

---

- [ ] **Unit 2: Add regression test for n=3 sequence; remove fresh-reasoner workaround if it passes**

**Goal:** Confirm the fix resolves the n=3 ABox + classify → sameAs failure, and clean up
the workaround once confirmed.

**Requirements:** R1, R4

**Dependencies:** Unit 1 (WASM rebuilt with random IDs)

**Files:**
- Modify: `tests/integration/abox-realization.test.ts`

**Approach:**
- Add a new `it()` test that uses a **fresh `RdfReasoner` instance created inside the test
  body** and runs exactly: 3× materialize(`ABOX_NTRIPLES`), 1× classify(`TBOX_ONLY_NTRIPLES`),
  then materialize(`SAME_AS_NTRIPLES`). This reproduces the exact call-count that triggered
  the failure and is independent of how many prior calls the shared `reasoner` has made.
  Using a fresh instance avoids the call-count accounting problem that arises when using the
  shared `reasoner` (which already has 3+ calls from prior tests).
- Terminate the fresh instance in `afterAll` or inline `finally` block.
- If the regression test passes (the fix resolves the n=3 symptom), optionally change the
  existing `"owl:sameAs pair appears in materialize() output"` test to use the shared
  `reasoner` (remove the current fresh-instance workaround). Keep the new regression test
  regardless — it documents the specific failure mode.

**Test scenarios:**
- Regression: fresh reasoner, exactly 3× materialize(ABOX) + classify(TBOX) →
  materialize(SAMEAS) returns ≥1 `owl:sameAs` triple (was returning 0 before the fix)
- Regression: Alice↔Eve pair appears in at least one direction in the output
- No-regression: all 6 existing abox-realization tests still pass

**Verification:**
- `npx vitest run tests/integration/abox-realization.test.ts` passes all tests including
  the new regression case
- The shared-reasoner version of the sameAs test passes (workaround removed if confirmed)

---

- [ ] **Unit 3: Correct the BackendAssCache solutions doc mechanism description**

**Goal:** Fix the mis-characterization in the solutions doc so future readers understand the
actual cache structure and don't optimize against a fictional "SLOT_COUNT=4" fixed-slot model.

**Requirements:** R3

**Dependencies:** Unit 2 (regression test must confirm fix before doc claims randomization "eliminates it as a root cause")

**Files:**
- Modify: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`

**Approach:**
- Replace the "fixed-size slot array, SLOT_COUNT=4, ontologyID mod SLOT_COUNT" description
  with the correct mechanism: `mOntologyIdentifierDataHash` is a dynamic `CCACHINGHASH`
  (Qt open-addressing hash map); `mFixedOntologyIdentifierDataHash` is a never-evicted `QHash`
- Preserve the symptoms table (n=3 fails, n=1/2/4 pass), the workaround, and the proper-fix
  section — those remain accurate
- Update the root-cause section to state: "exact failure path is still under investigation;
  the sequential ID is provably unsafe regardless of mechanism, and randomization eliminates
  it as a root cause"
- Add a `status: corrected` tag or update note at the top with today's date

**Test scenarios:**
- Test expectation: none — documentation change, no executable behavior modified

**Verification:**
- Doc accurately describes `CBackendRepresentativeMemoryCacheSlotItem::getOntologyData()`
  (hash-map lookup, not modular array indexing)
- Symptom table, workaround, and proper-fix sections are preserved intact

## System-Wide Impact

- **Affected surface:** `src/KoncludeReasoner.cpp` `buildFreshOntology()` only — the sole
  fresh-ID assignment in the WASM build
- **Copy-propagation callers unaffected:** Three callers in realizer/classifier/answerer that
  propagate an existing ontology ID to a temporary ontology are not changed; they will receive
  the random ID from the primary ontology and propagate it correctly
- **BackendAssCache hash map behavior:** With random 63-bit IDs the load factor and bucket
  distribution of `mOntologyIdentifierDataHash` are effectively uniform — no pathological
  bucket clustering
- **`mFixedOntologyIdentifierDataHash` growth:** Still grows one entry per completed call and
  never evicts; the random ID change does not affect this — memory growth mitigation is
  deferred
- **Unchanged invariants:** All public TypeScript APIs (`materialize`, `classify`,
  `classifyProperties`, `checkConsistency`) are unaffected. Wire format, WASM binary interface,
  and `npm` package API are unchanged

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `std::random_device` throws in Emscripten node mode | `try/catch` fallback to chrono+address seed; still non-deterministic |
| Random ID fix does not resolve the n=3 failure (wrong root cause) | Regression test (Unit 2) will prove this; solutions doc update (Unit 3) documents the unresolved mechanism |
| 63-bit ID space exhaustion | Negligible: 9.2 × 10^18 IDs before repeat; no WASM process runs that many calls |
| Fresh-reasoner workaround removal breaks an edge case | Remove only after Unit 2 regression test passes; if Unit 2 fails, keep workaround and file follow-up issue |

## Sources & References

- Symptom documentation: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
- Cache structure: `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp`
- Cache slot lookup: `vendor/konclude/Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheSlotItem.cpp` lines 61–67
- Fixed reader: `CBackendRepresentativeMemoryCache.cpp` lines 520–528 (`createOntologyFixedCacheReader`)
- ID assignment: `src/KoncludeReasoner.cpp` lines 331–347 (`buildFreshOntology`)
- STPU stale-semaphore fix (adjacent): `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` lines 286–343
