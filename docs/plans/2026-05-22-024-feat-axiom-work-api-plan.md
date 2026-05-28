---
title: "feat: Add axiom-work API — isEntailed, explain, whatIf, sameAs, isSatisfiable"
type: feat
status: active
date: 2026-05-22
origin: docs/brainstorms/2026-05-22-009-axiom-work-api-requirements.md
---

# feat: Add axiom-work API — isEntailed, explain, whatIf, sameAs, isSatisfiable

## Overview

Extends `RdfReasoner` with seven capabilities that make the reasoner usable in interactive and iterative ontology-engineering workflows:

1. **Incremental caching (A)** — skip re-reasoning when input is unchanged; return `{ added, removed }` delta; also caches `checkConsistency()`
2. **`isEntailed` (B)** — O(1) post-reasoning entailment check via named-graph lookup
3. **`whatIf` (D)** — hypothetical reasoning over `store ∪ additions \ removals` without mutating the store
4. **`owl:sameAs` extraction (E)** — include individual equivalences in `materialize()` output (C++ + WASM rebuild)
5. **`isSatisfiable` / `getUnsatisfiableClasses` (F)** — post-classify taxonomy check for `owl:Nothing` equivalents (C++ + WASM rebuild)
6. **`explain` / `explainInconsistency` (C)** — BlackBox justification via repeated classify/materialize sub-calls within a single queue slot; `explainInconsistency` is a dedicated wrapper for inconsistent-ontology diagnosis
7. **`validate` (G)** — high-level API returning `{ consistent, errors, warnings }` where errors are inconsistency justifications and warnings are unsatisfiable-class justifications

Units 1–3, 6, and 7 require no WASM rebuild. Units 4 and 5 both require a C++ change — they must be batched into a **single WASM rebuild** (~20–30 min).

## Problem Frame

`RdfReasoner` is purely batch and stateless: load quads → reason → dump inferred quads. Three concrete gaps:

- **Testing new axioms** — "If I add this axiom, what new entailments follow?" requires re-running the full pipeline manually and diffing the output.
- **Debugging missing entailments** — "Why wasn't SubClassOf(A B) inferred?" has no answer; no justification mechanism exists.
- **Every call re-reasons from scratch** — even a single-triple change triggers a full reset, because the TS layer has no fingerprint cache.
- **`owl:sameAs` is silently discarded** — `OPSSAMEINDIVIDUALSREALIZE` runs during `realization()`, but `buildInferredTripleBuffer()` never extracts the result.

See origin doc for full architecture context and named-graph layout.

## Requirements Trace

- R-A: Fingerprint cache per (op × input hash); `returnDelta` option returns `InferenceDelta` alongside store mutation; `checkConsistency(store)` wired into same cache infrastructure (A1–A4)
- R-B: `isEntailed(store, axiom | axioms[])` post-reasoning lookup; `null` for unsupported predicates (B1–B4)
- R-C: `explain(store, axiom, opts?)` — BlackBox justification with `maxJustifications`, `axiomFilter`; `explainInconsistency(store, opts?)` — dedicated wrapper for inconsistency diagnosis (C1–C7)
- R-D: `whatIf(store, additions, opts?)` — hypothetical full-materialize, delta vs current `INFERRED_GRAPH_IRI` (D1–D3)
- R-E: `materialize()` includes `owl:sameAs` pairs from `CSameRealization`; self-pairs suppressed; both directions (E1–E3)
- R-F: `isSatisfiable(store, classIRI)` and `getUnsatisfiableClasses(store)` via taxonomy bottom-node walk (F1–F3)
- R-G: `validate(store, opts?)` — high-level consistency + satisfiability check; returns `ValidationResult` with `errors` (inconsistency justifications) and `warnings` (unsatisfiable-class justifications); explanations always computed (G1–G3)

## Scope Boundaries

- No arbitrary class expressions for `isEntailed` or `isSatisfiable` — named classes and ground SPO triples only
- No true incremental Konclude (`OPSPREPROCESSDELTA`, A4) in this plan
- No data property value entailments
- No `owl:differentFrom` extraction
- `explain` performance profiling deferred; the built-in declaration filter is always active (see Key Technical Decisions); `axiomFilter` (C5) is the user mechanism for further restricting the search space on large ABoxes

### Deferred to Separate Tasks

- True incremental via `OPSPREPROCESSDELTA`: separate investigation + plan
- Data property entailment materialization: open investigation from prior session

## Context & Research

### Relevant Code and Patterns

- `ts/index.ts:75` — `_queue` promise chain; every public method follows `const result = this._queue.then(async () => {...}); this._queue = result.then(()=>{},()=>{});`
- `ts/index.ts:147` — `_call(method, args, transfer?)` — posts `WorkerRequest`, registers in `this.pending`; does NOT touch `_queue`
- `ts/index.ts:190,358,450` — `_reasonOnStore`, `_materializeOnStore`, `_classifyPropertiesOnStore` — existing patterns for new methods
- `ts/types.ts:3` — `INFERRED_GRAPH_IRI = "urn:konclude:inferred"`; no `HYPOTHETICAL_IRI` constant exists yet
- `ts/worker.ts:99–176` — `handleMessage` switch; active messages: `loadTripleBuffer`, `classification`, `realization`, `consistency`, `getInferredTripleBuffer`, `getPropertyTripleBuffer`; three dead cases (`loadNTriples`, `getInferredNTriples`, `reset`) must not be removed (covered by existing unit tests)
- `ts/intern.ts` — `encodeToBuffers`, `decodeBuffers`, `InternTable`; no fingerprint utility exists
- `src/KoncludeReasoner.cpp:807` — `buildInferredTripleBuffer()`; `InternTable` at lines 753–784; `emitTriple` lambda at 816; existing `emittedTriples` dedup set; ABox block at line 900+ (`if (mImpl->mRealized)`)
- `vendor/konclude/Source/Reasoner/Realization/CSameRealization.h` — `visitSameIndividuals(CRealizationIndividualInstanceItemReference, visitor*)`, `getSameInstanceItemReference(CIndividualReference)`, `hasPotentiallySameIndividuals()`
- `vendor/konclude/Source/Reasoner/Realization/CSameRealizationIndividualVisitor.h` — pure virtual `visitIndividual(const CIndividualReference&, CSameRealization*) → bool`
- `vendor/konclude/Source/Reasoner/Realization/CRealization.h:66` — `getSameRealization()`
- `vendor/konclude/Source/Reasoner/Taxonomy/CTaxonomy.h:66` — `getBottomHierarchyNode()`; line 104 `getConceptHierarchyNodeHash()`
- `vendor/konclude/Source/Reasoner/Taxonomy/CHierarchyNode.h:104` — `getEquivalentConceptList()`
- `tests/unit/RdfReasoner.store.test.ts` — canonical unit test scaffolding: `vi.hoisted` mocks, `makeReadyReasoner()`, `simulateWorkerMessage()`, `mockWorkerSequence()`
- `tests/unit/RdfReasoner.materialize.test.ts` — `buildCombinedBuffer()` helper for constructing fake Worker responses
- `tests/integration/abox-realization.test.ts` — integration pattern: `describe.skipIf(!wasmExists)`, single `beforeAll`, 30 s timeout, shared `reasoner` instance

### Institutional Learnings

- `project_sequential_call_fix.md` — `waitSynchronization()` fence after `prepareOntology()` is required for sequential calls; already applied in current C++ code; every feature that issues multiple reasoning cycles depends on it
- `project_manager_thread_lifecycle.md` — `Impl` singleton must persist across calls; use `reset()` not `destroyReasoner()`; every new feature relies on this invariant
- `project_realization_classify_dependency.md` — `prepareOntology()` must not be called twice on the same ontology object; all requirements submitted in one call; UAF crash in realizer thread is the current blocker for sequential ABox tests — the `explain` and `whatIf` tests should be structured so that ABox scenarios only run when the UAF fix is confirmed merged
- `project_backend_asscache_pattern.md` — BackendAssCache completes Update 2 ("0 remaining") before classifier/realizer reads; `waitSynchronization()` fence covers this
- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` — taxonomy walk: key on `CHierarchyNode*` (not `CConcept*`); stale-pointer guard for defunct nodes; `getConceptTag()` (lowest = oldest = canonical representative); applies to isSatisfiable/getUnsatisfiableClasses implementation
- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md` — pthreads required; KPSet deadlocks permanently on cooperative dispatch; `whatIf` and `explain` sub-calls must use the pthread-based Manager architecture — no synchronous inline reasoning

## Key Technical Decisions

- **Hash function: sorted NTriples → djb2/FNV-1a** — O(N log N), no external deps, no async SubtleCrypto, portable across call contexts. Intern-ID set-equality is fragile across call boundaries (IDs are insertion-order-dependent). *(Resolves planning question A1)*
- **`maxJustifications` default = 1** — Single MUS (O(N log N) calls) for interactive use; opt into full HSDAG with `{ maxJustifications: N }`. *(Supersedes brainstorm C4's parenthetical "default: 5"; the brainstorm's outstanding-questions section recommended default 1 for interactive use — adopted here.)*
- **BlackBox default axiom filter: exclude built-in declarations** — Triples where predicate is `rdf:type` and object is `owl:Class` / `owl:ObjectProperty` / `owl:DatatypeProperty` / `owl:AnnotationProperty` / `rdfs:Class` are excluded from the search space by default. User override via `axiomFilter` option. Dramatically reduces call count for typical ontologies. *(Resolves planning question C3/C5)*
- **`_callDirect` as named private method** — Same body as `_call`; named explicitly to signal "safe to call from within a `_queue` body". Prevents accidental calls to the public methods (`classify`, `materialize`) inside `explain`'s loop, which would deadlock.
- **`whatIf` uses full materialize pipeline** — Runs classify + realization (same as `materialize()`). Consistent with D1 "materializes inferences". Delta is always relative to current `INFERRED_GRAPH_IRI`.
- **`isSatisfiable` via TS membership check** — `getUnsatisfiableClasses()` returns the full set from C++; `isSatisfiable()` checks membership. Simpler than a dedicated single-IRI C++ lookup path.
- **owl:sameAs dedup via existing `emittedTriples` set** — The `{subjectId, predicateId, objectId}` dedup set already in `buildInferredTripleBuffer()` handles all triple deduplication. Both symmetric directions are emitted naturally (visitor fires for B when processing A, and for A when processing B).
- **`explain` operation type fixed at call start** — Determined once from the axiom predicate: `rdfs:subClassOf` / `owl:equivalentClass` → `classification()`; `rdf:type` / object property assertion → `realization()`; `rdfs:subPropertyOf` → `classification()` (entailment checks use `getPropertyTripleBuffer`, not `getInferredTripleBuffer` — property triples are in that buffer). All BlackBox iterations use the same operation.

## Open Questions

### Resolved During Planning

- **Hash function**: sorted NTriples + djb2/FNV-1a (see Key Technical Decisions)
- **`maxJustifications` default**: 1 — see Key Technical Decisions
- **`CSameRealizationIndividualVisitor.h` path**: `vendor/konclude/Source/Reasoner/Realization/CSameRealizationIndividualVisitor.h` — confirmed present
- **CTaxonomy owl:Nothing entry point**: `getBottomHierarchyNode()` (line 66) is the correct entry point; use `getEquivalentConceptList()` on the bottom node for unsatisfiable classes; apply stale-pointer guard per the subClassOf taxonomy-walk learning
- **BlackBox axiom subset**: exclude built-in declaration triples by default; user overrides via `axiomFilter` (see Key Technical Decisions)

### Deferred to Implementation

- Exact djb2/FNV-1a seed and bit-width — inconsequential for correctness; pick during implementation
- Whether `explain` needs a timeout/abort mechanism for pathological inputs — assess against typical test cases during implementation
- Behavior of `whatIf` when `INFERRED_GRAPH_IRI` has been partially written by a prior failed call — verify against actual test cases

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Named-graph ownership

```
n3.Store
├── default graph          ← user's base ontology (read by encode; never written by reasoner)
├── INFERRED_GRAPH_IRI     ← last materialized inferences (written by materialize/classify/classifyProperties)
└── user-supplied IRIs     ← optional; e.g. outputGraph from whatIf
```

`whatIf` computes inferences but writes only to `outputGraph` (if supplied) — never to `INFERRED_GRAPH_IRI` or the default graph.

### `_queue` slot serialization — normal vs. sub-call pattern

```
Normal call (classify, materialize, whatIf, isEntailed, isSatisfiable):
  _queue.then(async () => {
    await _call("loadTripleBuffer", ...)
    await _call("classification" | "realization")
    await _call("getInferredTripleBuffer")
  })

explain() — holds one slot; BlackBox iterations use _callDirect:
  _queue.then(async () => {
    // initial entailment check (fast path via INFERRED_GRAPH_IRI, no Worker call)
    for each BlackBox iteration:
      await _callDirect("loadTripleBuffer", ...)   // ← NOT _call via public method
      await _callDirect(operationType)
      await _callDirect("getInferredTripleBuffer")
      // check entailment in returned buffer
  })
```

`_callDirect` has the identical body to `_call`. The name exists to make it explicit that this path is only safe inside an already-held `_queue` slot — not as a general escape from serialization.

### WASM rebuild batching

Units 4 (owl:sameAs) and 5 (isSatisfiable) both touch `src/KoncludeReasoner.cpp` and both require a WASM rebuild. Implement both C++ changes before running `make build-wasm`.

## Implementation Units

- [ ] **Unit 1: Fingerprint cache + delta infrastructure (A1–A3)**

**Goal:** Add a per-operation content hash cache to `RdfReasoner` so that calling `classify()`, `materialize()`, `classifyProperties()`, or `checkConsistency()` with an unchanged store skips the Worker round-trip. Add `returnDelta` option that returns `{ added: Quad[], removed: Quad[] }` alongside the standard store mutation.

**Requirements:** R-A

**Dependencies:** None

**Files:**
- Modify: `ts/intern.ts` — add `computeStoreFingerprint(quads: Quad[]): string` utility
- Modify: `ts/types.ts` — add `InferenceDelta` type; add `returnDelta?: boolean` to `MaterializeStoreOptions` and any classify-equivalent option interfaces; add `HYPOTHETICAL_IRI` constant (used by Unit 3)
- Modify: `ts/index.ts` — add **four** cache slots (`_classifyCache`, `_materializeCache`, `_classifyPropertiesCache`, `_consistencyCache` — each a `{hash: string, result: void | boolean} | null`); inject cache-check into `_reasonOnStore`, `_materializeOnStore`, `_classifyPropertiesOnStore`, and `checkConsistency(store)`; inject delta-capture into `_materializeOnStore` (only operation that writes `INFERRED_GRAPH_IRI` and supports `returnDelta`)

**Approach:**
- `computeStoreFingerprint`: filter store quads to exclude `INFERRED_GRAPH_IRI` and `HYPOTHETICAL_IRI` graphs **explicitly** via graph identity check — do not rely on `removeQuads` having been called first. `_materializeOnStore` removes `INFERRED_GRAPH_IRI` quads at line 363 before encoding, but `_reasonOnStore` and `_classifyPropertiesOnStore` may not; the explicit filter ensures consistent fingerprints across all four injection points. Serialize each remaining quad to N-Triples canonical string; sort; concatenate; hash with djb2 or FNV-1a (pure-JS, no external dep).
- Cache key: `(operationName, fingerprint)` — four independent slots, one per operation type. `_classifyCache` maps to `_reasonOnStore` exclusively; `_consistencyCache` maps to `checkConsistency(store)` exclusively (the store-based overload at `ts/index.ts:297`). If the 1:1 invariants change, the cache slots must be revised.
- Cache hit: return without dispatching to Worker; if `returnDelta: true`, return `{ added: [], removed: [] }` (materialize-only)
- Cache miss: proceed with Worker call; if `returnDelta: true`, capture `before` set from `INFERRED_GRAPH_IRI` quads, capture `after` set from returned buffer, compute symmetric diff; update cache slot
- Delta computation: `added = after \ before`, `removed = before \ after` — quad identity by N-Triples canonical form
- `checkConsistency(store)` cache: result is `boolean`; cache stores `{hash, result: boolean}`; cache hit returns the stored boolean directly

**Patterns to follow:**
- `_materializeOnStore` in `ts/index.ts` for the queue-gated async structure
- `encodeToBuffers` / `decodeBuffers` in `ts/intern.ts` for quad manipulation conventions

**Test scenarios:**
- Happy path: `materialize(store)` called twice with identical store → Worker receives exactly one `loadTripleBuffer` message (cache hit on second call)
- Happy path: `classify(store)` and `materialize(store)` called with same store → each triggers its own Worker call (separate cache slots)
- Happy path: `checkConsistency(store)` called twice with identical store → Worker receives exactly one `loadTripleBuffer` (cache hit on second call)
- Happy path: `checkConsistency(store)` and `classify(store)` with same store → each triggers its own Worker call (separate cache slots)
- Happy path: `materialize(store, { returnDelta: true })` on first call → `delta.added` = all inferred quads, `delta.removed` = []
- Happy path: `materialize(store, { returnDelta: true })` after adding a triple → `delta.added` contains only newly inferred quads, `delta.removed` contains only retracted ones
- Happy path: `materialize(store)` without `returnDelta` → no delta property in return value (backward compat)
- Edge case: store contains only `INFERRED_GRAPH_IRI` quads (no base triples) → fingerprint is stable empty string; cache hit on second call
- Edge case: store changes between calls → cache miss; Worker receives a new `loadTripleBuffer`

**Verification:**
- `npm test` passes with no regressions on existing store-based tests
- Unit tests confirm Worker call count matches expected cache behavior for all four operation types

---

- [ ] **Unit 2: isEntailed (B1–B4)**

**Goal:** Add `isEntailed(store, axiom: Quad): Promise<boolean | null>` and batch overload `isEntailed(store, axioms: Quad[]): Promise<(boolean | null)[]>`. Triggers classify or materialize via the Unit 1 cache if the store has changed, then answers via O(1) n3.Store lookup.

**Requirements:** R-B

**Dependencies:** Unit 1 (cache check to avoid redundant Worker calls)

**Files:**
- Modify: `ts/index.ts` — add `isEntailed` overloads
- Modify: `ts/types.ts` — add supported predicate constant set (or document inline)
- Modify: `tests/unit/RdfReasoner.store.test.ts` — unit tests for both overloads

**Approach:**
- Supported predicate set: `rdfs:subClassOf`, `owl:equivalentClass`, `rdf:type`, `rdfs:subPropertyOf`, object property assertion triples (SPO where predicate is an object property IRI — not `owl:ObjectProperty` declaration triples) — answered by INFERRED_GRAPH_IRI lookup
- Unsupported: if axiom predicate is not in the supported set, return `null` immediately and `console.warn`; do not trigger reasoning
- For single-axiom: determine operation from axiom predicate (`rdfs:subClassOf`/`owl:equivalentClass`/`rdfs:subPropertyOf` → `classify`; `rdf:type`/object-property → `materialize`); trigger that operation (uses Unit 1 cache — no Worker call if already current); then call `store.has(DataFactory.quad(s, p, o, inferredGraphNode))`
- For batch: determine operation from the first supported axiom (all axioms in one batch must be the same operation type; if mixed, classify first, then materialize); run reasoning once; check each axiom
- Queue gating: `isEntailed` follows the same `_queue.then(...)` pattern as other public methods — the cache check and Store lookup both occur inside the slot

**Patterns to follow:**
- `_reasonOnStore` queue-gating pattern in `ts/index.ts`
- `n3.Store.has(quad)` — single quad lookup returns boolean

**Test scenarios:**
- Happy path: `isEntailed(store, penguin-rdf:type-bird)` returns `true` after `materialize()` on ontology where Penguin ⊑ Bird
- Happy path: `isEntailed(store, unknownClass-rdf:type-bird)` returns `false`
- Happy path: batch overload returns `[true, false, null]` for a mixed set of axioms
- Edge case: unsupported predicate (e.g., `skos:prefLabel`) → returns `null`; warning logged; no Worker call
- Edge case: `isEntailed` called before any reasoning → triggers reasoning internally; correct result returned
- Edge case: store changes after previous `isEntailed` call → cache miss, re-reasoning triggered
- Edge case: `isEntailed` called concurrently with `materialize` → queued correctly, no interleaving

**Verification:**
- `npm test` passes
- Unit tests confirm: correct boolean for entailed/non-entailed, null for unsupported, no Worker call when cache is warm

---

- [ ] **Unit 3: whatIf (D1–D3)**

**Goal:** Add `whatIf(store: Store, additions: Quad[], opts?: { removals?: Quad[], outputGraph?: string }): Promise<{ added: Quad[], removed: Quad[] }>`. Computes full-materialize inferences over the hypothetical input without mutating the store or `INFERRED_GRAPH_IRI`.

**Requirements:** R-D

**Dependencies:** Unit 1 (INFERRED_GRAPH_IRI exclusion pattern; delta computation helper)

**Files:**
- Modify: `ts/index.ts` — add `whatIf` method
- Modify: `ts/types.ts` — add `WhatIfOptions` interface (uses `HYPOTHETICAL_IRI` declared in Unit 1)
- Modify: `tests/unit/RdfReasoner.store.test.ts` — unit tests
- Modify: `tests/integration/abox-realization.test.ts` — integration test with WASM (gated on `wasmExists`)

**Approach:**
- Queue-gate as a single `_queue` slot (standard pattern)
- Build hypothetical quad set: `store.getQuads(null,null,null,null)` filtered to exclude `INFERRED_GRAPH_IRI` (and `HYPOTHETICAL_IRI`) graphs + `additions` − `removals`
- Encode via `encodeToBuffers`; dispatch `loadTripleBuffer` → `realization` → `getInferredTripleBuffer` via `_call` (within the slot, same as `_materializeOnStore`)
- Compute delta: `before` = current `store.getQuads(null,null,null,inferredGraphNode)`; `after` = decoded result buffer; return `{ added: after \ before, removed: before \ after }`
- Return value: always resolves to `{ added, removed }` regardless of whether `outputGraph` is supplied. `outputGraph` is a side-effect-only write and does not affect the returned delta.
- If `opts.outputGraph` supplied: write `after` quads into `store` under that named graph IRI (mutation of outputGraph only — never touch default graph or `INFERRED_GRAPH_IRI`)
- If `INFERRED_GRAPH_IRI` is empty (no prior reasoning): `removed` = []; `added` = all hypothetical inferences
- **Delta baseline**: the delta is relative to the current `INFERRED_GRAPH_IRI` content. If `INFERRED_GRAPH_IRI` was last written by `classify()` (which emits only `rdfs:subClassOf` triples), `whatIf`'s `added` array will contain all `rdf:type` entailments — these are real hypothetical entailments, but their presence in `added` reflects the operation-type gap rather than the hypothetical additions specifically. Callers who need an operation-consistent delta should call `materialize()` first to populate `INFERRED_GRAPH_IRI` with the same pipeline `whatIf` uses.

**Patterns to follow:**
- `_materializeOnStore` in `ts/index.ts` for the Worker call sequence
- `decodeBuffers` in `ts/intern.ts` for the result

**Test scenarios:**
- Happy path: `whatIf(store, [newAxiom])` where `newAxiom` triggers new entailments → `added` is non-empty, `removed` is []
- Happy path: `whatIf` does not mutate `store.getQuads(null,null,null,defaultGraph)` (base triples unchanged)
- Happy path: `whatIf` does not mutate `INFERRED_GRAPH_IRI` quads in `store`
- Happy path: `whatIf(store, additions, { outputGraph: 'urn:hyp' })` → hypothetical inferences written to `urn:hyp` named graph in store
- Edge case: `whatIf` with `removals` that include an axiom required for an entailment → that entailment absent in `added`
- Edge case: `whatIf` with empty `INFERRED_GRAPH_IRI` (no prior reasoning) → `added` = all hypothetical inferences, `removed` = []
- Edge case: `whatIf` with empty `additions` and no `removals` → delta equivalent to materialize result
- Edge case: `opts.outputGraph` === `INFERRED_GRAPH_IRI` → throws before any Worker call
- Integration: `whatIf` followed by `materialize` → `INFERRED_GRAPH_IRI` reflects the real base state, not the hypothetical

**Verification:**
- `npm test` passes
- Integration test confirms hypothetical entailments appear and store is not mutated

---

- [ ] **Unit 4: owl:sameAs extraction from CSameRealization (E1–E3)**

**Goal:** Extract `owl:sameAs` pairs from `CSameRealization` inside `buildInferredTripleBuffer()` and include them in the WASM output buffer. These appear in `materialize()` results under `INFERRED_GRAPH_IRI`.

**Requirements:** R-E

**Dependencies:** None (C++ change, independent of TS units). Must be batched with Unit 5 to share WASM rebuild.

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — add `SameIndividualVisitor` struct; call `visitSameIndividuals` for each individual inside the `if (mImpl->mRealized)` block of `buildInferredTripleBuffer()`
- Test: `tests/integration/abox-realization.test.ts` — add `owl:sameAs` scenario

**Approach:**
- Add `SameIndividualVisitor` concrete struct implementing `CSameRealizationIndividualVisitor`; override `visitIndividual(const CIndividualReference& indiRef, CSameRealization*)` returning `bool`
- The visitor receives: a reference to the source individual's intern ID, the `owl:sameAs` predicate ID, the `emittedTriples` dedup set, and the `tripleIds` output vector — same pattern as `TargetIndiVisitor` for role assertions
- Visitor logic: resolve `indiRef` to `CIndividual*` via `indiRef.getIndividual()`; guard: `if (!individual) return true` (ID-only `CIndividualReference` references return nullptr — same pattern as `TargetIndiVisitor` at line 1002–1003); get IRI via `CIRIName::getRecentIRIName`; skip if empty; skip self-pairs (`tgtId == srcId`); emit both `(srcId, sameAsId, tgtId)` via `emitTriple` (which checks `emittedTriples`)
- Guard chain inside `buildInferredTripleBuffer()`:
  1. `mImpl->mRealized` must be true (same outer guard as existing ABox block)
  2. `sameReal = mImpl->mOntology->getRealization()->getSameRealization()`
  3. `sameReal && sameReal->hasPotentiallySameIndividuals()`
- Outer loop: iterate `indiVec` (same `CIndividual*` vector as the role-assertion block); for each `indi` (non-null from the pre-validated vector), construct `CIndividualReference(indi)` using the pointer constructor; call `sameReal->getSameInstanceItemReference(CIndividualReference(indi))` to get the item reference; call `sameReal->visitSameIndividuals(itemRef, &visitor)` with a fresh visitor per source individual. Use the pointer constructor (not the ID-only `CIndividualReference(cint64)`) because `indi` is known non-null at this point; the visitor's null guard (above) covers target references arriving as ID-only.
- `owl:sameAs` IRI: `"http://www.w3.org/2002/07/owl#sameAs"` — intern once before the outer loop
- Required include: add `"Reasoner/Realization/CSameRealizationIndividualVisitor.h"` to existing includes in `src/KoncludeReasoner.cpp` (confirm `CSameRealization.h` is already transitively included via `CRealization.h`)

**Patterns to follow:**
- `TargetIndiVisitor` / role-assertion extraction in `src/KoncludeReasoner.cpp` (existing ABox block around line 900+)
- `emitTriple` lambda for dedup-aware output

**Test scenarios:**
- Integration: `materialize(store)` where ontology entails `<a> owl:sameAs <b>` (e.g., two individuals declared equivalent) → result includes both `<a> owl:sameAs <b>` and `<b> owl:sameAs <a>` in `INFERRED_GRAPH_IRI`
- Integration: `<a> owl:sameAs <a>` (self-pair) is NOT in the result
- Integration: ontology with no individuals → no `owl:sameAs` triples emitted
- Integration: `owl:sameAs` triples are in `INFERRED_GRAPH_IRI` named graph (not default graph)
- Integration: existing `rdf:type` and subClassOf triples unaffected by the change

**Verification:**
- After WASM rebuild (`make build-wasm` + `npm run patch-wasm`), `npm test` passes
- Integration test confirms `owl:sameAs` presence and symmetry

---

- [ ] **Unit 5: isSatisfiable / getUnsatisfiableClasses (F1–F3)**

**Goal:** Add `buildUnsatisfiableClassBuffer()` in C++ to walk the taxonomy's bottom node and return all class IRIs equivalent to `owl:Nothing`. Wire this to a new Worker message `"getUnsatisfiableClassBuffer"`. Expose `isSatisfiable(store, classIRI)` and `getUnsatisfiableClasses(store)` on `RdfReasoner`.

**Requirements:** R-F

**Dependencies:** Unit 4 for the WASM rebuild — both C++ units must be complete before running `make build-wasm`. The TS wrapper layer must be written after the WASM binary is available and `npm run patch-wasm` has run.

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — add `buildUnsatisfiableClassBuffer()` method
- Modify: `src/KoncludeReasoner.h` — declare `buildUnsatisfiableClassBuffer()`
- Modify: `src/bindings.cpp` — add `.function("getUnsatisfiableClassBuffer", &KoncludeReasoner::buildUnsatisfiableClassBuffer)` to the `EMSCRIPTEN_BINDINGS(konclude)` block
- Modify: `ts/worker.ts` — add `"getUnsatisfiableClassBuffer"` case to `handleMessage`
- Modify: `ts/index.ts` — add `isSatisfiable(store, classIRI)` and `getUnsatisfiableClasses(store)`
- Modify: `ts/types.ts` — add return types if needed
- Test: `tests/unit/RdfReasoner.store.test.ts`
- Test: `tests/integration/owl-dl-capabilities.test.ts`

**Approach:**

*C++ side (`buildUnsatisfiableClassBuffer`):*
- Guard: `mImpl->mClassified` must be true
- Access taxonomy bottom node: `CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy(); CHierarchyNode* bottomNode = taxonomy->getBottomHierarchyNode()`
- Walk `bottomNode->getEquivalentConceptList()`: for each `CConcept* c`, get IRI via `CIRIName::getRecentIRIName(c->getClassNameLinker())`; skip blank IRIs; skip `owl:Nothing` itself (full IRI `"http://www.w3.org/2002/07/owl#Nothing"`). The `owlNothing` static defined locally inside `buildInferredTripleBuffer()` (line 832) should be promoted to a file-scope static so both methods share the same constant.
- Apply stale-pointer guard from taxonomy-walk learning: check that the concept's node pointer maps to a live node in `getConceptHierarchyNodeHash()` before emitting (avoids stale defunct nodes)
- Return format: newline-delimited UTF-8 string. `buildUnsatisfiableClassBuffer()` returns `std::string` — Emscripten marshals `std::string` directly to a JS string without ptr/len plumbing. The IRI list is short (typically <50 entries); binary buffer overhead is not justified. The Worker handler calls `r.buildUnsatisfiableClassBuffer()` and posts the result directly as a plain JS string.

*Worker side:*
- New case `"getUnsatisfiableClassBuffer"` in `handleMessage`: call `reasoner.buildUnsatisfiableClassBuffer()`, return result via `postMessage`

*TS side:*
- `_getUnsatisfiableClassesInternal(store)` (private, no queue gating): if Unit 1 classify cache is cold, issues `loadTripleBuffer` → `classification` via `_call` before dispatching `"getUnsatisfiableClassBuffer"`; parses newline-delimited response into `string[]`. Same pattern as `_callDirect` — safe to call from within a `_queue` body. Calling the public `getUnsatisfiableClasses(store)` from inside another `_queue.then()` body would deadlock (the inner call enqueues behind the already-held outer slot).
- `getUnsatisfiableClasses(store)`: public, queue-gated wrapper; calls `_getUnsatisfiableClassesInternal(store)` within its `_queue.then()` slot
- `isSatisfiable(store, classIRI)`: public, queue-gated; calls `_getUnsatisfiableClassesInternal(store)` within its own `_queue.then()` slot; returns `!(set.includes(classIRI))`; for a class not in the taxonomy returns `true` (open-world assumption, per F1)

**Patterns to follow:**
- `buildPropertyTripleBuffer()` in `src/KoncludeReasoner.cpp` for the buffer-building pattern
- `getInferredTripleBufferPtr()` / `getPropertyTripleBuffer` Worker dispatch for the message plumbing
- Taxonomy walk in `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` for node traversal guard

**Test scenarios:**
- Integration: `isSatisfiable(store, ':EmptyClass')` returns `false` when EmptyClass is declared disjoint with itself
- Integration: `isSatisfiable(store, ':Bird')` returns `true` for a satisfiable class
- Integration: `isSatisfiable(store, 'urn:unknown:class')` returns `true` (not in taxonomy — open-world)
- Integration: `getUnsatisfiableClasses(store)` returns `[]` for an ontology with no unsatisfiable classes
- Integration: `getUnsatisfiableClasses(store)` returns the IRI of the unsatisfiable class
- Unit: Worker receives `"getUnsatisfiableClassBuffer"` message after a classification-warm cache run; mock response parsed correctly
- Edge case: `isSatisfiable` called before any classification → triggers classification internally; correct result returned

**Verification:**
- After WASM rebuild (`make build-wasm` + `npm run patch-wasm`), `npm test` passes
- Integration tests in `owl-dl-capabilities.test.ts` confirm satisfiable/unsatisfiable classification

---

- [ ] **Unit 6: explain / explainInconsistency — BlackBox justification (C1–C7)**

**Goal:** Add `explain(store: Store, axiom: Quad, opts?: ExplainOptions): Promise<Quad[][]>` implementing the BlackBox justification algorithm in TypeScript. Each inner `Quad[]` is a minimal subset of the store's quads that alone entails the axiom. Returns `[]` if the axiom is not entailed. Also add `explainInconsistency(store: Store, opts?: ExplainOptions): Promise<Quad[][]>` as a dedicated wrapper for diagnosing inconsistent ontologies.

**Requirements:** R-C

**Dependencies:** Unit 1 (fingerprint cache for the initial entailment check), Unit 2 (`isEntailed` for fast-path exit)

**Files:**
- Modify: `ts/index.ts` — add `_callDirect` private method; add `explain` public method; add `explainInconsistency` public method
- Modify: `ts/types.ts` — add `ExplainOptions { maxJustifications?: number, axiomFilter?: (q: Quad) => boolean }` interface
- Test: `tests/unit/RdfReasoner.explain.test.ts` — new unit test file
- Test: `tests/integration/owl-dl-capabilities.test.ts` — integration scenarios
- Test: `tests/integration/consistency.test.ts` — `explainInconsistency` integration scenarios

**Approach:**

*`_callDirect` private method:*
- Identical body to `_call`. Named differently to signal safe use inside a `_queue` body. Callers inside `explain`'s `_queue` slot use `_callDirect`; callers outside use `_call` via public methods.

*Operation type selection (fixed at call start):*
- `rdfs:subClassOf`, `owl:equivalentClass` → Worker operation `"classification"`
- `rdf:type`, object property assertions → Worker operation `"realization"`
- `rdfs:subPropertyOf` → `"classification"` + property walk
- Unsupported predicate → throw `UnsupportedAxiomError` (do not return `null` here — explain is a deliberate query, not a probe)

*Candidate axiom set:*
- All quads from `store` excluding `INFERRED_GRAPH_IRI` and `HYPOTHETICAL_IRI` graphs
- Apply `opts.axiomFilter` if provided
- Apply default filter: remove triples where `predicate === rdf:type` and `object ∈ { owl:Class, owl:ObjectProperty, owl:DatatypeProperty, owl:AnnotationProperty, rdfs:Class }` (built-in declarations)

*Single-justification binary-search shrink (within `_queue` slot):*
1. Fast-path exit: if `await _callDirect`-based entailment check on full set fails, return `[]`
2. Binary-partition shrink loop: repeatedly split `candidates`, discard the half whose absence doesn't break entailment, until no further reduction is possible. Each entailment check: `_callDirect("loadTripleBuffer", subset)` → `_callDirect(operationType)` → result buffer → check axiom presence. **Buffer selection**: `rdfs:subClassOf` / `owl:equivalentClass` / `rdf:type` targets use `_callDirect("getInferredTripleBuffer")`; `rdfs:subPropertyOf` targets use `_callDirect("getPropertyTripleBuffer")` — property triples are not in `getInferredTripleBuffer`. **Correctness depends on monotone entailment**: OWL 2 DL guarantees adding axioms cannot remove entailments. Each iteration resets WASM via the `r.reset()` call in `ts/worker.ts:102` (triggered by `loadTripleBuffer`), making iterations independent. Removing `r.reset()` in the worker would break this invariant.
3. **Deletion pass (required for MUS guarantee)**: Binary partition reduces size but may retain non-essential axioms. After partition shrink, iterate the remaining candidates: for each axiom `a`, test if the set without `a` still entails the target (same buffer-selection rule); if yes, remove `a` permanently. This pass guarantees the result is truly minimal.
4. Result is one minimal justification

*HSDAG for multiple justifications (when `maxJustifications > 1`):*
- Standard Hitting Set DAG: maintain a set of open nodes (unresolved partial hitting sets); for each justification found, expand HSDAG; terminate when `|found| === maxJustifications` or queue exhausted
- Each HSDAG iteration reuses the single-justification shrink sub-routine on a reduced candidate set
- Default `maxJustifications = 1` means HSDAG is never entered

*Queue ownership:*
- `explain()` holds exactly one `_queue` slot for its entire duration (outer `_queue.then(async () => {...})`). All `_callDirect` invocations happen within that slot. Calling the public methods `classify()` or `materialize()` from inside the slot is prohibited.

*`explainInconsistency(store, opts?)` approach:*
- Semantic anchor: a classically inconsistent ontology entails `owl:Thing rdfs:subClassOf owl:Nothing`. `explainInconsistency` exploits this by calling `explain(store, DataFactory.quad(OWL.Thing, RDFS.subClassOf, OWL.Nothing), opts)` internally from within its own `_queue` slot.
- Fast-path: call `_consistencyCheckInternal(store)` (same as `checkConsistency(store)` but without queue gating); if `true` (consistent), return `[]` immediately — no BlackBox iterations needed.
- The `_queue` slot is held by `explainInconsistency`; the `explain` sub-call must use `_callDirect` (same invariant as `explain`'s inner loop). Do NOT call the public `explain()` from inside `explainInconsistency` — that would enqueue behind the held slot and deadlock.
- `opts.axiomFilter` and `opts.maxJustifications` pass through to the inner BlackBox loop unchanged.
- Return: same `Quad[][]` shape as `explain` — each inner array is a MIPS (Minimally Inconsistent Sub-ontology).

**Patterns to follow:**
- `_materializeOnStore` for the outer queue-gating structure
- `decodeBuffers` for decoding sub-call results
- `RdfReasoner.store.test.ts` scaffolding for the unit test file

**Test scenarios (`explain`):**
- Happy path: `explain(store, quad(':Penguin rdfs:subClassOf :Bird'))` returns at least one non-empty `Quad[]` when the entailment holds
- Happy path: each quad in a returned justification set is a member of the original store's base quads
- Happy path: each returned justification set is minimal — given ontology `{ A ⊑ B, B ⊑ C }`, `explain(store, quad(':A rdfs:subClassOf :C'))` returns a justification containing both axioms and not just one
- Happy path: `explain(store, axiom)` returns `[]` when axiom is not entailed
- Happy path: `{ maxJustifications: 1 }` → at most one justification returned
- Happy path: `{ maxJustifications: 3 }` → up to three justifications returned for an ontology with multiple proofs
- Edge case: `axiomFilter` restricting to TBox quads only → explain operates only over TBox; returns `[]` if proof requires ABox quads
- Edge case: unsupported predicate → throws (not returns null)
- Edge case: `explain` called with `maxJustifications: 0` → returns `[]` immediately (no Worker calls)
- Note: `explain()` returns `Quad[][]` with no truncation indicator in the array itself. Callers can detect potential truncation via `result.length === (opts.maxJustifications ?? 1)` — equal length means the result may have been capped.
- Integration: `explain` followed immediately by `classify` → `classify` runs correctly after `explain` releases the queue slot (no queue stall)
- Integration: calling `explain` twice sequentially on the same instance → both complete without hang

**Test scenarios (`explainInconsistency`):**
- Happy path: `explainInconsistency(store)` on a consistent ontology → returns `[]`
- Happy path: `explainInconsistency(store)` on `alice a Person, Organization; Person disjointWith Organization` → returns at least one non-empty `Quad[]` containing the disjointWith axiom and the conflicting type assertions
- Integration: `explainInconsistency` followed by `classify` → `classify` runs correctly (no queue stall)
- Integration: `explainInconsistency` on each of the six OWL-DL violation examples from ontosphere issue #13 → returns non-empty result for all six (disjointWith direct, disjointWith-by-inference, AsymmetricProperty, IrreflexiveProperty, maxQualifiedCardinality+differentFrom, allValuesFrom+disjointWith)

**Verification:**
- `npm test` passes
- Integration test confirms at least one justification for known entailments; `[]` for non-entailments
- Sequential `explain` + `classify` on same instance completes (regression check for queue-slot release)
- `explainInconsistency` returns `[]` for consistent ontologies and non-empty for each issue #13 example

---

- [ ] **Unit 7: validate — high-level consistency + satisfiability report (G1–G3)**

**Goal:** Add `validate(store: Store, opts?: ValidateOptions): Promise<ValidationResult>` that combines consistency checking, unsatisfiable-class detection, and justification extraction into a single call. Returns a structured result with `errors` (inconsistency justifications) and `warnings` (unsatisfiable-class justifications).

**Requirements:** R-G

**Dependencies:** Unit 1 (consistency cache), Unit 5 (`getUnsatisfiableClasses` — WASM rebuild required), Unit 6 (`explainInconsistency`, `explain`)

**Files:**
- Modify: `ts/index.ts` — add `validate` public method; add `_getUnsatisfiableClassesInternal` (already planned in Unit 5 — reuse)
- Modify: `ts/types.ts` — add `ValidationResult`, `ClassWarning`, `ValidateOptions` interfaces
- Test: `tests/unit/RdfReasoner.validate.test.ts` — new unit test file
- Test: `tests/integration/validate.test.ts` — new integration test file (gated on `wasmExists`)

**Approach:**

*Return types:*
```ts
interface ClassWarning {
  classIRI: string;
  justifications: Quad[][];
}

interface ValidationResult {
  consistent: boolean;
  errors: Quad[][];        // justifications for inconsistency; [] when consistent
  warnings: ClassWarning[]; // unsatisfiable classes + justifications; [] when none
}

interface ValidateOptions {
  maxJustificationsPerError?: number;   // default: 1
  maxJustificationsPerWarning?: number; // default: 1
  axiomFilter?: (q: Quad) => boolean;
}
```

*Algorithm (held in a single `_queue` slot):*
1. Compute fingerprint; run consistency via `_callDirect` pipeline (reuses `_consistencyCache` logic — same hash, same result)
2. If inconsistent: call the BlackBox loop (same as `explainInconsistency`) with `maxJustifications = opts.maxJustificationsPerError ?? 1`; store results in `errors`
3. Always call `_getUnsatisfiableClassesInternal(store)` (Unit 5); for each unsatisfiable class IRI, call the BlackBox loop with axiom `quad(classIRI, rdfs:subClassOf, owl:Nothing)` and `maxJustifications = opts.maxJustificationsPerWarning ?? 1`; store in `warnings`
4. Return `{ consistent, errors, warnings }`

*Rationale for errors vs warnings:*
- **Error** = ontology inconsistent (no model exists; ABox + TBox together are contradictory). Examples: individual in two disjoint classes (issue #13 examples 1–6).
- **Warning** = unsatisfiable class in otherwise-consistent ontology (class can have no instances, but ABox may be satisfiable). Example: `EmptyClass ⊑ owl:Nothing` in an ontology with no `EmptyClass` individuals.
- An inconsistent ontology trivially makes every class unsatisfiable; in that case `errors` is populated and `warnings` may be large but is less meaningful. Callers should check `consistent` first.

*Queue ownership:*
- `validate()` holds one `_queue` slot. All inner calls use `_callDirect`. Calling public methods (`checkConsistency`, `explain`, `getUnsatisfiableClasses`) from inside is prohibited.

**Patterns to follow:**
- `explain`'s `_queue.then(async () => {...})` outer structure
- `_getUnsatisfiableClassesInternal` from Unit 5 for the class list

**Test scenarios:**
- Happy path: `validate(store)` on consistent ontology with no unsatisfiable classes → `{ consistent: true, errors: [], warnings: [] }`
- Happy path: `validate(store)` on `alice a Person, Organization; Person disjointWith Organization` → `{ consistent: false, errors: [[...]], warnings: [] }`
- Happy path: `validate(store)` on ontology with `EmptyClass ⊑ owl:Nothing` and no individuals → `{ consistent: true, errors: [], warnings: [{ classIRI: ':EmptyClass', justifications: [[...]] }] }`
- Happy path: `{ maxJustificationsPerError: 2 }` → `errors.length <= 2`
- Happy path: `{ maxJustificationsPerWarning: 0 }` → `warnings[i].justifications = []` for each warning (no explain calls for warnings)
- Integration: `validate(store)` on each of the six OWL-DL violation examples from ontosphere issue #13 → `consistent: false` for all six; `errors` non-empty
- Integration: `validate(store)` followed by `classify(store)` → `classify` runs correctly (no queue stall)
- Edge case: `validate(store)` before any prior reasoning → triggers full pipeline; correct result
- Edge case: `validate(store)` on ontology inconsistent enough that every class is unsatisfiable → `consistent: false`; `warnings` may be populated but `errors` is the primary signal

**Verification:**
- `npm test` passes
- Integration tests cover all six issue #13 examples plus satisfiable/unsatisfiable class cases
- Sequential `validate` + `classify` on same instance completes

---

## System-Wide Impact

- **Interaction graph:** All new public methods gate on `_queue` — they serialize correctly with `classify()`, `materialize()`, `classifyProperties()`. `explain()`'s `_callDirect` sub-calls run within its held slot, avoiding any queue interaction. No middleware or observers exist in the TS layer.
- **Error propagation:** Errors thrown within a `_queue.then()` body are propagated to the returned Promise. The queue's error-swallowing tail (`result.then(()=>{},()=>{})`) prevents a single method failure from stalling subsequent calls — this invariant must be maintained in all new methods.
- **State lifecycle risks:** `whatIf` must never mutate `INFERRED_GRAPH_IRI`. Cache slots must be invalidated when `store` content changes (fingerprint change = cache miss). `explain`'s sub-calls run against the Worker's live WASM instance — the WASM state is reset via `loadTripleBuffer` at each iteration, so no inter-iteration state leaks.
- **API surface parity:** The new public methods extend `RdfReasoner`'s interface. Type definitions in `ts/types.ts` are re-exported from `ts/index.ts` — `InferenceDelta`, `ExplainOptions`, `WhatIfOptions`, `ValidationResult`, `ClassWarning`, `ValidateOptions` must be added to the barrel export.
- **Integration coverage:** The `explain` deadlock scenario (sequential calls after `explain` releases the queue slot) cannot be proven by unit tests alone — an integration test against the live WASM is required.
- **Unchanged invariants:** `materialize()`, `classify()`, and `classifyProperties()` store-mutation behavior is unchanged. The `returnDelta: false` default means no breaking change. `INFERRED_GRAPH_IRI` semantics are unchanged — it still reflects the last real (non-hypothetical) reasoning result. `encodeToBuffers` wire format is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| UAF crash in realizer (`project_realization_classify_dependency.md`) blocks sequential ABox tests for `explain` and `whatIf` | Gate integration tests for sequential ABox scenarios on `wasmExists` and confirm the UAF fix (`takeCallback` atomic exchange) is merged before enabling them |
| WASM rebuild breaks existing `patch-wasm` patching | Run `npm run patch-wasm` immediately after `make build-wasm`; smoke-test with `make smoke` before running full suite |
| `buildUnsatisfiableClassBuffer` taxonomy walk hits stale pointers for defunct merged-away nodes | Apply stale-pointer guard (check node presence in `getConceptHierarchyNodeHash()`) per documented learning |
| `explain` BlackBox calls accumulate Worker latency; large ontologies may time out in CI | Default `maxJustifications = 1` limits call count; CI integration test uses a small ontology with ≤10 TBox axioms |
| `whatIf` inadvertently mutates store if `outputGraph` clashes with `INFERRED_GRAPH_IRI` | Validate that `outputGraph !== INFERRED_GRAPH_IRI` at call start; throw if equal |
| `_callDirect` misuse — a future contributor calls a public method from inside `explain`'s or `validate`'s slot | Document the prohibition in a JSDoc comment on `_callDirect`; the naming alone is the primary safeguard |
| `validate` on an inconsistent ontology with many classes triggers O(classes) BlackBox explain calls | Default `maxJustificationsPerWarning: 1` limits per-class cost; CI integration tests use small ontologies |

## Documentation / Operational Notes

- Re-export `InferenceDelta`, `ExplainOptions`, `WhatIfOptions`, `ValidationResult`, `ClassWarning`, `ValidateOptions`, `HYPOTHETICAL_IRI` from the package entry point so consumers don't need to import from `ts/types.ts` directly
- Update package README (if maintained) with brief examples for `isEntailed`, `explain`, `explainInconsistency`, `validate`, and `whatIf`
- After WASM rebuild: `sudo chown -R $USER dist/` before `npm run build` (Docker ownership issue documented in CLAUDE.md)
- Both C++ units (4 and 5) must be fully implemented before triggering the single `make build-wasm` run

## Phased Delivery

### Phase 1 — TypeScript-only (no WASM rebuild)

Units 1 → 2 → 3 (linear dependency). Unit 6 can start once Unit 2 is done. Unit 7 depends on Units 5 and 6 — its TS implementation can be written in Phase 1 but full integration testing requires Phase 2 WASM.

- Unit 1 (fingerprint cache + consistency cache) is the foundation; implement and test first
- Units 2 and 3 can be implemented in parallel once Unit 1 is merged
- Unit 6 (explain + explainInconsistency) depends on Unit 2; implement after Unit 2 is merged
- Unit 7 TS skeleton can be written after Unit 6; integration tests are gated on Phase 2

### Phase 2 — C++ + WASM rebuild (batch both units)

- Implement Unit 4 C++ changes and Unit 5 C++ changes in the same session
- Run single `make build-wasm` + `npm run patch-wasm`
- Implement Unit 5 TS wrapper after the WASM binary is available
- Enable Unit 7 integration tests (validate) — they depend on `getUnsatisfiableClasses` from Unit 5
- Add all six ontosphere issue #13 examples as integration tests in `tests/integration/validate.test.ts` and `tests/integration/consistency.test.ts`
- Integration test Phase 2 features before committing

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-22-009-axiom-work-api-requirements.md](docs/brainstorms/2026-05-22-009-axiom-work-api-requirements.md)
- C++ extraction pattern: `src/KoncludeReasoner.cpp` (ABox block, `buildInferredTripleBuffer`)
- Taxonomy walk learning: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- Threading architecture: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- Memory files: `project_sequential_call_fix.md`, `project_manager_thread_lifecycle.md`, `project_realization_classify_dependency.md`, `project_backend_asscache_pattern.md`
- **User issue with OWL-DL violation examples (6 test cases):** [ontosphere #13](https://github.com/ThHanke/ontosphere/issues/13) — disjointWith, domain/range inference, AsymmetricProperty, IrreflexiveProperty, maxQualifiedCardinality+differentFrom, allValuesFrom+disjointWith
