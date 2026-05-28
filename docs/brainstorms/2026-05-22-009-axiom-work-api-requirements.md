---
date: 2026-05-22
topic: axiom-work-api
---

# Axiom-Work API — isEntailed, explain, whatIf, incremental, owl:sameAs

## Problem Frame

The current `RdfReasoner` API is purely batch and stateless: load quads → reason → dump inferred quads. This leaves common ontology-engineering workflows without support:

- **Testing new axioms** — "If I add this axiom, what new entailments follow?"
- **Debugging missing entailments** — "I expected SubClassOf(A B) but it wasn't inferred — why not?" No justification mechanism exists.
- **Incremental use** — Every call fully resets the reasoner and re-reasons from scratch, even if only one triple changed.
- **owl:sameAs is computed but discarded** — `OPSSAMEINDIVIDUALSREALIZE` runs during `realization()`, but the output is never extracted.

These gaps make the reasoner hard to use in interactive or iterative contexts (ontology editors, debugging pipelines, KG enrichment loops) despite Konclude being a full OWL 2 DL engine.

## Architecture Context

The Worker + n3.Store model is the natural carrier for these features:

```
n3.Store {
  default graph         ← user's base ontology (input axioms)
  INFERRED_GRAPH_IRI    ← last computed inferences (current output)
  HYPOTHETICAL_IRI      ← scratch space for what-if queries (new)
}
```

The Worker already serializes all calls. The TS layer can maintain "last seen input fingerprint" across calls to skip full re-reasoning when nothing changed. Named graphs cleanly separate concerns.

---

## Requirements

### A. Incremental Reasoning (TS-layer caching)

**A1.** The TS layer (index.ts) maintains a fingerprint cache keyed on **(operationType × inputContentHash)**. `classify()`, `materialize()`, and `classifyProperties()` each maintain a separate cache slot — their outputs differ for identical input, so they must not share a key. If the same operation is called with base triples identical to the last run of that operation, the call returns immediately without dispatching to WASM. The fingerprint is computed over default-graph + all user named graphs, explicitly excluding `INFERRED_GRAPH_IRI` (and any other managed output graphs) so that previously-inferred triples do not cause spurious cache misses.

**A2.** On change: re-reason fully (Tier 1, current model) and update `INFERRED_GRAPH_IRI` with the result. The TS caller receives a `{ added: Quad[], removed: Quad[] }` delta object alongside the standard store mutation. This delta is useful for consumers (UI rendering, diff display) without them needing to compare the inferred graph themselves.

**A3.** `materialize(store)` and `classify(store)` accept an optional `{ returnDelta: true }` flag to opt into receiving the delta (default: `false` for backward compat). Store-mutation behavior is unchanged regardless of flag.

**A4.** _(Tier 2 — deferred to a later plan)_ True incremental via Konclude's `OPSPREPROCESSDELTA`: keep the C++ `Impl` alive across calls, pass only the axiom delta to `prepareOntology`. Gated on resolving BackendAssCache collision issues from the sequential-call fix.

### B. isEntailed

**B1.** `isEntailed(store: Store, axiom: Quad): Promise<boolean | null>` — after reasoning over `store`, check whether `axiom` is an entailed consequence. Returns `null` for unsupported axiom types (see B4). Reasoning is triggered automatically if the store has changed since the last call (uses the caching from A1).

**B2.** `isEntailed(store, axioms: Quad[]): Promise<(boolean | null)[]>` — batch overload, checks all axioms in one reasoning run.

**B3.** For supported axiom types (SPO triples whose predicate is `rdfs:subClassOf`, `owl:equivalentClass`, `rdf:type`, `rdfs:subPropertyOf`, `owl:ObjectProperty` assertions): answered by lookup in the inferred graph (O(1) n3.Store query). No new WASM calls needed.

**B4.** For unsupported axiom types (complex class expressions, arbitrary OWL axioms not representable as a single triple): `isEntailed` returns `null` (not `false`) and logs a warning. Callers can detect `null` to know the axiom type isn't yet supported.

### C. explain — Justification Sets

**C1.** `explain(store: Store, axiom: Quad): Promise<Quad[][]>` — returns all minimal justification sets (MUSes) for `axiom`: each inner array is a minimal subset of the input quads that alone entails `axiom`. Returns `[]` if the axiom is not entailed.

**C2.** For "why didn't this fire" debugging: an empty result `[]` means the axiom is not entailed by the current store. The consumer can use this to identify missing axioms.

**C3.** Implementation: **BlackBox algorithm** in TypeScript, no C++ changes:
1. Verify `isEntailed(store, axiom)` = true (fast path exit if false).
2. Expand: find a single justification via binary-search axiom subset shrinking.
3. Enumerate all justifications: HSDAG (Hitting Set DAG) from Pellet/HermiT literature.
Each BlackBox step uses `_callDirect` (see C6) to dispatch to the Worker. The Worker operation is selected by axiom type: `rdfs:subClassOf` / `owl:equivalentClass` targets → `classification()`; `rdf:type` / object property assertion targets → `realization()`; `rdfs:subPropertyOf` targets → `classification()` + property walk. All steps within one `explain()` call use the same operation — mixing operation types within a single justification search is not allowed.

**C4.** `explain` accepts an optional `{ maxJustifications?: number }` cap (default: 5) to bound the number of reasoning calls for large ontologies.

**C5.** `explain` accepts an optional `{ axiomFilter?: (q: Quad) => boolean }` to restrict the search space to a subset of axioms (e.g., only TBox triples). This dramatically cuts the call count for large ABoxes when explaining TBox entailments.

**C6.** `explain()` occupies a single `_queue` slot for its entire duration. Sub-calls within the BlackBox loop use a private `_callDirect` path that posts Worker messages directly without touching `_queue`. Calling the public `classify()`/`materialize()` methods from inside `explain()` is prohibited — they would enqueue behind the slot `explain()` already holds, deadlocking.

### D. whatIf — Hypothetical Reasoning

**D1.** `whatIf(store: Store, additions: Quad[], opts?: { removals?: Quad[] }): Promise<{ added: Quad[], removed: Quad[] }>` — materializes inferences over `store ∪ additions \ removals` without modifying the store or its inferred graph. Returns the delta vs. the current inferred state.

**D2.** Internally: serialize `store` base triples + additions (minus removals), run reasoning in the Worker, diff against the current `INFERRED_GRAPH_IRI`, return delta. The store is not mutated. `INFERRED_GRAPH_IRI` (and any `outputGraph` from a prior `whatIf` call) must be stripped from the encoding — exactly as all existing Store-based methods do — to prevent previously-inferred triples from being fed back to Konclude as input axioms. If `INFERRED_GRAPH_IRI` is empty (no prior reasoning), the returned `added` array contains all hypothetical inferences and `removed` is empty.

**D3.** Optionally writes the hypothetical inferences into a caller-supplied named graph: `whatIf(store, additions, { outputGraph: 'https://example.org/hypothetical' })`. Useful for displaying hypothetical entailments in a UI alongside real ones.

### E. owl:sameAs Extraction

**E1.** `materialize()` must extract `owl:sameAs` triples from `CSameRealization` after `OPSSAMEINDIVIDUALSREALIZE` completes. These are included in the `INFERRED_GRAPH_IRI` output alongside `rdf:type` and object property assertions.

**E2.** Self-pairs (`<x> owl:sameAs <x>`) are suppressed. Both directions are emitted (`<a> owl:sameAs <b>` and `<b> owl:sameAs <a>`) for symmetry with OWL semantics.

**E3.** C++ extraction path: `CSameRealization* sameReal = mImpl->mOntology->getRealization()->getSameRealization()` → `visitSameIndividuals(indi, visitor)` via `CSameRealizationIndividualVisitor`. Pattern mirrors existing rdf:type extraction in `buildInferredTripleBuffer`.

### F. isSatisfiable

**F1.** `isSatisfiable(store: Store, classIRI: string): Promise<boolean>` — after classification, returns whether the named class is satisfiable (can have instances). Returns `true` for classes not in the taxonomy (open-world assumption: absence of unsatisfiability doesn't imply satisfied).

**F2.** `getUnsatisfiableClasses(store: Store): Promise<string[]>` — returns IRIs of all classes Konclude has determined to be equivalent to `owl:Nothing`.

**F3.** Implementation: post-`classification()`, walk the taxonomy's `owl:Nothing` node to collect all equivalent concepts mapped to it. No new WASM pipeline steps — the data is present after `classify()`.

---

## Scope Boundaries

- **No arbitrary class expression inputs** for `isEntailed` or `isSatisfiable` in this iteration — only named classes and ground SPO triples. Complex class expressions (intersections, restrictions) require new C++ query infrastructure.
- **No true incremental Konclude** (OPSPREPROCESSDELTA) in this iteration — A4 is deferred.
- **No data property value entailments** — data property assertions aren't materialized by Konclude's realization layer (open investigation from prior session).
- **No `owl:differentFrom`** extraction — computed during realization but low practical demand.
- **`explain`'s BlackBox algorithm** is worst-case O(N²) classify calls for N axioms. Large ontologies (>1000 TBox axioms) may be slow. Performance profiling deferred to planning.

---

## Success Criteria

- `isEntailed(store, quad(':Penguin rdf:type :Bird'))` returns `true` after `materialize()` on an ontology where Penguin ⊑ Bird.
- `explain(store, quad(':Penguin rdf:subClassOf :Bird'))` returns at least one non-empty justification set when the entailment holds; returns `[]` when it does not.
- `whatIf(store, [newAxiom])` returns a non-empty `added` array when `newAxiom` triggers new entailments, without modifying `store`.
- `materialize(store)` includes `<a> owl:sameAs <b>` when the ontology entails individual equivalence.
- `isSatisfiable(store, ':EmptyClass')` returns `false` when EmptyClass is declared disjoint with itself.
- `materialize(store, { returnDelta: true })` returns `{ added: [], removed: [] }` on a second call with identical input (caching proof).

---

## Key Decisions

- **BlackBox justify in TypeScript, not C++**: Portable, zero WASM rebuild, uses the existing classification/materialize primitives. Slower per-call than a native proof tracer but ships without Konclude internals changes.
- **Named graphs as architectural boundary**: `INFERRED_GRAPH_IRI` is stable output; `HYPOTHETICAL_IRI` is scratch. Callers can use n3.Store's named graph API to read either without special accessors.
- **`isEntailed` returns `null` (not `false`) for unsupported axiom types**: Avoids false negatives that look like entailment failures.
- **Tier 1 caching is input-content-based, not structural**: Hash over sorted NTriples is portable and doesn't require exposing Konclude internals.

---

## Dependencies / Assumptions

- `CSameRealizationIndividualVisitor` is accessible after `realization()` completes — analogous to `CConceptRealizationInstantiatedVisitor` which is already used.
- `CTaxonomy`'s `owl:Nothing` node aggregates all unsatisfiable classes — verified by existing `buildInferredTripleBuffer` taxonomy walk.
- `explain`'s performance bound is acceptable for typical ontologies (<500 TBox axioms). Larger use cases are covered by `axiomFilter` option (C5).

---

## Outstanding Questions

### Resolve Before Planning

_(none — all product decisions resolved)_

### Deferred to Planning

- [Affects A1] **Fingerprint hash function**: sorted NTriples string hash vs. Set-equality comparison of intern IDs — both are O(N); pick during planning.
- [Affects C3] **Default justification count**: `maxJustifications` defaults to 1 (single MUS, O(N log N) calls) or 5 (HSDAG, up to O(N²) calls). Recommend defaulting to 1 for interactive use; callers opt into full enumeration.

- [Affects E3] Exact visitor header: `CSameRealizationIndividualVisitor.h` — verify path in vendor/konclude/Source/Reasoner/Realization/.
- [Affects F3] Verify `getConceptHierarchyNodeHash()` on CTaxonomy returns nodes equivalent to owl:Nothing cleanly, or if a dedicated `getBottomHierarchyNode()` is the right entry point.
- [Affects C3] Axiom subset generation for BlackBox: use full quad set, or filter to only non-built-in quads (drop `rdf:type owl:Class`, etc.)?

## Next Steps

-> `/ce-plan` for implementation planning
