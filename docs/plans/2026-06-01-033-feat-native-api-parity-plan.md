---
title: "feat: Comprehensive API parity with native Konclude OWLlink surface"
type: feat
status: active
date: 2026-06-01
---

# feat: Comprehensive API parity with native Konclude OWLlink surface

## Overview

Native Konclude exposes a rich OWLlink query surface: per-entity class and individual
queries (`GetSubClasses`, `GetFlattenedTypes`, `GetObjectPropertyTargets`, …), boolean
queries (`IsClassSatisfiable`, `IsClassSubsumedBy`, `AreClassesEquivalent`, …), and
full-hierarchy dumps. Our WASM port currently only exposes bulk-dump operations
(`classify`, `materialize`, `classifyProperties`, `checkConsistency`, `isEntailed`,
`explain`). Per-entity queries and satisfiability are missing entirely; inverse property
queries (`GetObjectPropertySources`, `GetObjectPropertiesOfTarget`) are not in the output
buffer.

This plan closes that gap in six units, two of which require a WASM rebuild.

## Problem Frame

Three concrete problems motivate this work:

1. **Benchmark comparability**: native-runner.mjs uses the CLI `realization` command,
   which only writes `ClassAssertion` to its OWL/XML output — dropping role assertions
   and `owl:sameAs`. Native inferred counts cannot be compared to WASM counts. Switching
   to OWLlink queries gives us the same triple set as WASM.
2. **API expressiveness gap**: downstream users who want "what are the types of individual
   X?" or "is class A subsumed by class B?" must run the full reasoning pipeline and
   scan the entire inferred graph manually. Native Konclude answers these queries directly.
3. **Completeness assertion**: we claim to port Konclude but don't expose the bulk of
   its query surface. The plan formalises which queries are supported, which are
   JS-derivable, which need a C++ extension, and which are explicitly out of scope.

## Requirements Trace

- R1. Every native OWLlink query type is classified: Supported / JS-derivable / Needs-C++ / Out-of-scope. Classification is documented in the gap matrix (Unit 1).
- R2. Per-entity read queries that are derivable from the existing inferred-triple dump are exposed as first-class TS methods without requiring a WASM rebuild.
- R3. The `direct` flag (OWLlink `direct="true"`) is supported for subclass and instance queries, filtering to the Hasse-diagram layer in JS using the taxonomy already in `INFERRED_GRAPH_IRI`.
- R4. Boolean convenience queries (`isClassSubsumedBy`, `areClassesEquivalent`, `isInstanceOf`) are exposed in TS.
- R5. `isClassSatisfiable(classIri)` is exposed with a C++ query method; no full-hierarchy dump required.
- R6. Inverse property direction (`getObjectPropertySources`, `getObjectPropertiesOfSource`, `getObjectPropertiesOfTarget`) is exposed via C++ extension to the realization extraction loop.
- R7. `tests/bench/native-runner.mjs` uses the OWLlink API (`owllinkfile` command) to extract all entailed triples (TBox + ABox + roles + sameAs), producing counts directly comparable to WASM.
- R8. All new TS methods carry JSDoc consistent with the OWLlink spec vocabulary.
- R9. 199/199 existing tests continue to pass after each unit.

## Scope Boundaries

- No SPARQL query API — requires Rasqal, excluded from the WASM build; separate initiative.
- No `GetNondeterministicIndividuals` / `GetPossibleClassAssertions` — Konclude proprietary extension.
- No `areClassesDisjoint` — requires a separate disjointness-specific Konclude query path not yet wired up.
- No OWLlink server mode — not relevant for the WASM/npm target.
- No data property *inference* chains — asserted literals are already in the buffer; inferred data property values from property chains are a separate gap.
- No WASM persistent-KB session API — the current one-shot load→reason→dump model is unchanged; per-entity queries read from the store, not from a live Konclude KB.

### Deferred to Separate Tasks

- `areClassesDisjoint` boolean query: separate plan once disjointness query path is confirmed.
- Open `BackendAssCache` sameAs bug (plan-030): tracked independently; `owl:sameAs` output from Unit 6 is subject to that known limitation.
- Data property entailment (inference chains): separate plan.

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` — all C++ reasoning methods; `buildInferredTripleBuffer()` emits subClassOf, equivalentClass, rdf:type, object property assertions, owl:sameAs; `buildPropertyTripleBuffer()` emits rdfs:subPropertyOf. Current role extraction only goes source→target.
- `src/bindings.cpp` — Embind registration; all new C++ methods must be registered here.
- `ts/index.ts` — public `RdfReasoner` class (≈1250 lines); all new TS methods go here. Fingerprint-cache pattern (`_classifyCache`, `_materializeCache`) must be consulted by new methods that auto-trigger reasoning.
- `ts/worker.ts` — worker dispatch table; new C++ methods require a new worker command case.
- `ts/types.ts` — exported interfaces and constants; new option/return types go here.
- `vendor/konclude/Tests/` — OWLlink request XML examples (`galen-classify-request.xml`, `roberts-family-full-D-classify-realize-request.xml`, `test-request.xml`).
- `tests/bench/native-runner.mjs` — Docker-based benchmark harness to be updated in Unit 4.
- `tests/integration/` — all integration tests; new methods need test files here.

### Institutional Learnings

- **subClassOf over-materialization** (`docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`): iterate unique `CHierarchyNode` objects, never `CConcept`-keyed structures; guard stale raw pointers. Any new C++ extraction path must follow the same four-fix pattern.
- **ABox mapper flag gaps** (`docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md`): audit `buildXxx()` methods on `CConcreteOntologyRedlandTriplesDataExpressionMapper` for flag guards before claiming any ABox axiom type is supported.
- **Consistency pipeline** (`docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`): `checkConsistency()` uses the correct `consistencyOnly()` pipeline (skips `OPSCLASSCLASSIFY`); do not change it.
- **BackendAssCache sameAs limit** (`docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`): owl:sameAs output is subject to an open bug after ≥3 mixed ABox+classify sequences; new tests involving sameAs should use fresh `RdfReasoner` instances.

### External References

- OWLlink specification: http://www.owllink.org/owllink-20111012/#
- Konclude paper (Steigmiller et al., 2014): https://arxiv.org/abs/1404.4171 — describes satisfiability query pipeline.

## Key Technical Decisions

- **Per-entity queries are JS-side filters on INFERRED_GRAPH_IRI**, not new C++ methods. After `classify(store)` or `materialize(store)`, all inferred quads are already in `INFERRED_GRAPH_IRI`. Per-entity queries (`getSubClasses`, `getTypes`, `getObjectPropertyTargets`, …) are N3 Store lookups with fixed subject/predicate/object patterns. This avoids a WASM rebuild for the majority of query types.

- **`direct` flag for subclasses is trivially correct** — `buildInferredTripleBuffer` already emits the Hasse-diagram layer (direct parents only, no transitive closure). `getSubClasses(C, { direct: true })` equals `getSubClasses(C)` with no additional filter. For `direct: false` (all descendants), we compute the transitive closure in JS using BFS/DFS over the Hasse diagram in `INFERRED_GRAPH_IRI`.

- **`direct` flag for types/instances requires JS taxonomy filter** — `buildInferredTripleBuffer` emits all types (including supertypes). `getTypes(i, { direct: true })` must remove types t for which a more specific type t′ of i exists such that `t′ rdfs:subClassOf t` is in `INFERRED_GRAPH_IRI`. Algorithm: collect all types T of i, collect all subClassOf edges, remove types with a strict descendant in T.

- **Inverse property queries require C++ extension** — the current `buildInferredTripleBuffer` role extraction loop walks source→target only. Adding target→source direction requires a second pass over `CRoleRealization::visitSourceIndividuals` (or equivalent), and new methods `buildInversePropertyTripleBuffer()` or inline reverse emission in the existing loop. Chosen: inline reverse emission with a flag parameter to avoid buffer duplication.

- **`isClassSatisfiable` requires a dedicated C++ method** — unlike hierarchy/type queries, satisfiability of an arbitrary class expression requires submitting a custom `OPSSATISFIABILITY` processing requirement for the specific class IRI to Konclude's pipeline. No JS-side derivation is possible. New C++ method: `isSatisfiable(classIri: string): bool`.

- **Native benchmark OWLlink approach**: generate an OWLlink request XML that (1) creates KB, (2) loads the ontology, (3) triggers `Classify` + `Realize`, (4) queries `GetSubClassHierarchy` + `GetAllIndividuals` + `GetAllObjectProperties` + per-individual `GetFlattenedTypes` + per-individual×property `GetFlattenedObjectPropertyTargets` + per-individual `GetSameIndividuals`, (5) releases KB. Parse the XML response to construct the triple set. For large ontologies (LUBM+data: 17k individuals), the per-individual loop will produce a large request; cache the generated XML keyed on ontology file mtime.

## Open Questions

### Resolved During Planning

- **Can JS derive `getObjectPropertiesOfSource(individual)`?** — Yes: after `materialize(store)`, all object property assertions `individual ?p ?target` are in `INFERRED_GRAPH_IRI`. Enumerate distinct predicates for the given subject. No C++ needed.
- **Can JS derive `getObjectPropertiesOfTarget(individual)`?** — Only if target→source direction is in `INFERRED_GRAPH_IRI` (Unit 6). Without C++ extension, this query is not answerable.
- **Is `getAllClasses` / `getAllIndividuals` derivable from the store without a full classify?** — From the input store (base quads), yes: enumerate subjects/objects of `rdf:type owl:Class` / `rdf:type owl:NamedIndividual` and infer from domain assertions. This is input-side enumeration, not inferred. Consistent with OWLlink semantics (GetAllClasses returns classes mentioned in the KB, not necessarily the inferred hierarchy members). For inferred individuals, `materialize(store)` is required first.
- **Does OWLlink `GetFlattenedObjectPropertyTargets` cover all SROIQ role chains?** — Yes, Konclude's realization computes role filler closure under property chains; `GetFlattenedObjectPropertyTargets` returns the full entailed target set.

### Deferred to Implementation

- Exact Konclude C++ method signatures for `isClassSatisfiable` and reverse role extraction — depends on Konclude's `COntologyProcessingStep` vocabulary for satisfiability and the `CRoleRealization` API for reverse traversal.
- Whether per-individual OWLlink loops in the native benchmark are fast enough for LUBM+data (17 174 individuals × many properties) — may need to cap at `GetSubClassHierarchy + SPARQL SELECT *` fallback if too slow.
- Whether `transitiveClosure` in JS for `getSubClasses(C, { direct: false })` is fast enough at GALEN scale (3287 subClassOf edges) — benchmark in integration test; fall back to iterative BFS if depth-first recursion causes stack overflow.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### New TS method groups

```
// Group A: JS-derivable per-entity reads (no WASM rebuild)
reasoner.getSubClasses(store, classIri, opts?)  → NamedNode[]   // direct: bool
reasoner.getSuperClasses(store, classIri, opts?) → NamedNode[]
reasoner.getEquivalentClasses(store, classIri)  → NamedNode[]
reasoner.getInstances(store, classIri, opts?)   → NamedNode[]   // direct: bool
reasoner.getTypes(store, individual, opts?)     → NamedNode[]   // direct: bool
reasoner.getSameIndividuals(store, individual)  → NamedNode[]
reasoner.getObjectPropertyTargets(store, individual, property) → NamedNode[]
reasoner.getObjectPropertiesOfSource(store, individual) → NamedNode[]  // after materialize
reasoner.getAllClasses(store)                   → NamedNode[]   // from input quads
reasoner.getAllIndividuals(store)               → NamedNode[]   // from input quads
reasoner.getAllObjectProperties(store)          → NamedNode[]   // from input quads

// Group B: JS boolean convenience (no WASM rebuild)
reasoner.isClassSubsumedBy(store, sub, sup)    → Promise<boolean>
reasoner.areClassesEquivalent(store, c1, c2)   → Promise<boolean>
reasoner.isInstanceOf(store, individual, cls)  → Promise<boolean>

// Group C: C++ satisfiability query (WASM rebuild required)
reasoner.isClassSatisfiable(store, classIri)   → Promise<boolean>

// Group D: C++ inverse property extraction (WASM rebuild required)
reasoner.getObjectPropertySources(store, individual, property) → NamedNode[]
reasoner.getObjectPropertiesOfTarget(store, individual)        → NamedNode[]
```

### Native benchmark OWLlink flow

```
owllinkfile request XML (per ontology):
  CreateKB
  LoadOntologies(path)
  Classify
  Realize                          ← only for ABox cases
  GetSubClassHierarchy             ← full TBox dump
  [for each individual]:
    GetFlattenedTypes(ind)         ← all types
    [for each property]:
      GetFlattenedObjectPropertyTargets(prop, ind)  ← role fillers
    GetSameIndividuals(ind)        ← sameAs
  ReleaseKB

Parse response → count triples using same pairwise-symmetric expansion as
countOwlXmlTriples() already implements for EquivalentClasses / SameIndividual.
```

## Implementation Units

- [ ] **Unit 1: API gap matrix document**

**Goal:** Produce a formal reference document mapping every native OWLlink query type to its WASM/TS status, so implementers know exactly what is covered, what is JS-derivable, what needs C++, and what is out of scope.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `docs/solutions/capability-gaps/owllink-api-parity-matrix.md`

**Approach:**
- List all ~40 OWLlink query types found in `vendor/konclude/Source/Parser/COWLlinkQtXMLCommandParser.cpp`
- For each, assign one of: `Supported` (already in TS API), `JS-derivable` (Units 2–3), `Needs-C++` (Units 5–6), `Out-of-scope` (with reason)
- Include a column for `direct` flag support and whether a WASM rebuild is required
- Cross-reference plan-033 units

**Test scenarios:**
- Test expectation: none — documentation unit only

**Verification:**
- Every OWLlink query type has an assigned status
- No "Needs-C++" entry without a corresponding Unit in this plan or a deferred-task reference

---

- [ ] **Unit 2: JS per-entity read API — Group A (no WASM rebuild)**

**Goal:** Expose per-entity query methods on `RdfReasoner` that read from `INFERRED_GRAPH_IRI` after `classify(store)` or `materialize(store)`. Methods auto-trigger reasoning if the store fingerprint has changed since the last operation.

**Requirements:** R2, R3, R4, R8

**Dependencies:** Unit 1 (gap matrix confirms JS-derivable set)

**Files:**
- Modify: `ts/index.ts`
- Modify: `ts/types.ts` (add `SubClassQueryOptions`, `InstanceQueryOptions`, `TypeQueryOptions`)
- Test: `tests/integration/per-entity-queries.test.ts` (new file)

**Approach:**
- Each method checks whether the appropriate inferred cache is populated (same fingerprint); if not, auto-triggers `classify` or `materialize` before reading.
- `getSubClasses(store, classIri, { direct = true })`:
  - `direct: true` → store.getSubjects(RDFS_SUBCLASSOF, classIri, INFERRED_GRAPH) (Hasse-diagram layer; already direct)
  - `direct: false` → BFS over subClassOf edges, transitive closure
- `getSuperClasses(store, classIri, { direct = true })`:
  - `direct: true` → store.getObjects(classIri, RDFS_SUBCLASSOF, INFERRED_GRAPH)
  - `direct: false` → BFS upward
- `getEquivalentClasses(store, classIri)` → store.getObjects(classIri, OWL_EQUIVALENTCLASS, INFERRED_GRAPH)
- `getInstances(store, classIri, { direct = true })`:
  - `direct: false` → store.getSubjects(RDF_TYPE, classIri, INFERRED_GRAPH)
  - `direct: true` → filter: keep only individuals whose type set has no strict subtype of classIri also in their type set
- `getTypes(store, individual, { direct = true })`:
  - `direct: false` → store.getObjects(individual, RDF_TYPE, INFERRED_GRAPH)
  - `direct: true` → remove types t where any other type t′ of individual has `t′ rdfs:subClassOf t` in INFERRED_GRAPH
- `getSameIndividuals(store, individual)` → store.getObjects(individual, OWL_SAMEAS, INFERRED_GRAPH)
- `getObjectPropertyTargets(store, individual, property)` → store.getObjects(individual, property, INFERRED_GRAPH)
- `getObjectPropertiesOfSource(store, individual)` → enumerate distinct predicates for (individual, ?, ?) in INFERRED_GRAPH, excluding rdf:type/rdfs:subClassOf/owl:equivalentClass/owl:sameAs
- `getAllClasses(store)` → enumerate objects of rdf:type owl:Class in base quads
- `getAllIndividuals(store)` → enumerate subjects with any rdf:type or owl:NamedIndividual in base quads
- `getAllObjectProperties(store)` → enumerate objects of rdf:type owl:ObjectProperty in base quads
- Boolean methods trigger classify/materialize then filter:
  - `isClassSubsumedBy(store, sub, sup)`: auto-classify, check `sub rdfs:subClassOf sup` in INFERRED_GRAPH
  - `areClassesEquivalent(store, c1, c2)`: auto-classify, check `c1 owl:equivalentClass c2` in INFERRED_GRAPH
  - `isInstanceOf(store, ind, cls)`: auto-materialize, check `ind rdf:type cls` in INFERRED_GRAPH

**Patterns to follow:**
- Fingerprint + cache pattern: `_classifyCache` / `_materializeCache` in `ts/index.ts` (lines ~218–253)
- `store.getSubjects()` / `store.getObjects()` / `store.getQuads()` N3 Store API (used throughout `ts/index.ts`)

**Test scenarios:**
- Happy path, getSubClasses direct: Roberts family — `hasFather` direct subclasses match native `GetSubClasses direct=true` output
- Happy path, getSubClasses indirect: GALEN — transitive closure count matches Hasse-diagram BFS result
- Happy path, getTypes direct=true: Roberts individual has ≥1 type; direct types exclude all superclasses also in the type set
- Happy path, getTypes direct=false: Roberts individual — count matches `materialize(store)` INFERRED_GRAPH rdf:type count for that individual
- Happy path, getInstances: LUBM+data — `UndergraduateStudent` instances match individuals with that type
- Happy path, getObjectPropertyTargets: Roberts individual has expected role fillers
- Happy path, getObjectPropertiesOfSource: Roberts individual enumerated properties non-empty
- Happy path, isClassSubsumedBy: `GraduateStudent rdfs:subClassOf Student` → true for LUBM
- Happy path, areClassesEquivalent: a known equivalent pair in GALEN → true
- Happy path, isInstanceOf: Roberts individual is instance of its asserted class → true
- Happy path, getAllClasses: LUBM schema — count matches owl:Class declarations in input
- Edge case: getSubClasses on owl:Thing → returns all named classes
- Edge case: getSubClasses on owl:Nothing → empty
- Edge case: getTypes on unknown individual IRI → empty array, no throw
- Edge case: direct=true with no subclass relationships → same as direct=false
- Error path: store not yet classified → auto-triggers classify, then answers
- Integration: isInstanceOf after materialize → consistent with getTypes result for same individual

**Verification:**
- All new methods return correct results against Roberts, LUBM schema, GALEN, LUBM+data fixtures
- 199/199 existing tests unchanged
- TypeScript compiles with no new errors

---

- [ ] **Unit 3: `direct` flag transitive-closure implementation and edge-case coverage**

**Goal:** Ensure `direct: false` for `getSubClasses` / `getSuperClasses` / `getInstances` / `getTypes` is correct at scale (GALEN: 3287 subClassOf edges, LUBM+data: 138 522 inferred triples).

**Requirements:** R2, R3

**Dependencies:** Unit 2

**Files:**
- Modify: `ts/index.ts` (refine BFS/DFS implementation)
- Test: `tests/integration/per-entity-queries.test.ts` (extend)

**Approach:**
- BFS transitive closure for subClasses/superClasses: build an adjacency list from INFERRED_GRAPH subClassOf edges once per fingerprint and cache it; BFS from the query node. Cache lifetime tied to `_classifyCache` fingerprint.
- Validate BFS output against the full INFERRED_GRAPH set: `getSuperClasses(A, { direct: false })` should equal the set of all X where `A rdfs:subClassOf X` exists transitively, which equals `store.getObjects(A, RDFS_SUBCLASSOF, INFERRED_GRAPH_IRI)` IF the buffer emitted the full transitive closure — but it doesn't (Hasse only). So BFS is required.
- Direct-types filter: share the adjacency list from classify cache; filter is O(types² × adjacency lookup).

**Patterns to follow:**
- Existing fingerprint cache invalidation pattern in `ts/index.ts`

**Test scenarios:**
- Happy path: `getSuperClasses('GraduateStudent', { direct: false })` for LUBM includes `Student`, `Person`, `owl:Thing` (full ancestor chain)
- Happy path: `getSubClasses('Person', { direct: false })` for Roberts includes all descendant classes
- Performance: GALEN `getSubClasses(owl:Thing, { direct: false })` completes in < 200 ms
- Edge case: cyclic equivalences — verify BFS terminates (guard visited set)
- Edge case: LUBM direct=true vs false for `Professor`: direct returns only immediate subtypes; false includes all descendants

**Verification:**
- GALEN `getSubClasses(owl:Thing, { direct: false })` count equals number of named classes minus owl:Nothing
- No infinite loop on any tested ontology

---

- [ ] **Unit 4: Native benchmark OWLlink integration**

**Goal:** Replace CLI `classification` / `realization` calls in `tests/bench/native-runner.mjs` with `owllinkfile` requests that query all inferred triples (TBox hierarchy + individual types + role assertions + sameAs). Native inferred counts should then match WASM counts.

**Requirements:** R7

**Dependencies:** Unit 1 (gap matrix confirms OWLlink query set)

**Files:**
- Modify: `tests/bench/native-runner.mjs`

**Approach:**
- Add `generateOwllinkRequest(owlFile, individuals, properties, command)` function that writes an OWLlink XML request:
  - For `classification` cases (TBox-only): `CreateKB + LoadOntologies + Classify + GetSubClassHierarchy + ReleaseKB`
  - For `realization` cases (ABox): additionally `Realize + GetAllIndividuals + GetAllObjectProperties` then per-individual `GetFlattenedTypes + GetSameIndividuals` and per-individual×property `GetFlattenedObjectPropertyTargets`
- Two-pass approach for realization: first request gets `GetAllIndividuals` + `GetAllObjectProperties`; second request uses those lists to build per-entity queries in one large `owllinkfile` call.
- Write the request XML to a temp file in the mounted output dir; run `docker ... owllinkfile -i /out/request.xml -o /out/response.xml`; parse response.
- Parse OWL XML response to count triples using the same pairwise-symmetric expansion as the existing `countOwlXmlTriples` — extend it to handle `ClassHierarchy`, `SetOfClasses`, `SetOfIndividuals` response elements.
- Timing: OWLlink calls run only for inferred triple counting (first run), not for timing measurement. Timing runs continue to use CLI classification/realization (fastest path, no output generation overhead).
- Fallback: if OWLlink response parsing fails, `inferredTriples = null` with a warning; timing still reported.

**Patterns to follow:**
- Existing `countOwlXmlTriples` function in `tests/bench/native-runner.mjs`
- Existing temp-dir pattern (`mkdtempSync` / `rmSync`) in `tests/bench/native-runner.mjs`
- `spawnSync('docker', [...], { encoding: 'utf8', timeout: 120000 })` pattern

**Test scenarios:**
- Happy path: LUBM schema native inferred count = 44 (matches WASM; already verified with current approach)
- Happy path: GALEN native inferred count = 3287 (matches WASM exactly)
- Happy path: Roberts family native inferred count = WASM inferred count (≈353 200)
- Happy path: LUBM+data native inferred count = WASM inferred count (≈138 522)
- Error path: Docker unavailable → graceful null, timing still reported
- Error path: OWLlink response XML parse failure → inferredTriples = null, no crash

**Verification:**
- All four native inferred counts match WASM inferred counts in `bench-results.md`
- Timing columns are unchanged (OWLlink query overhead not included in timing)

---

- [ ] **Unit 5: C++ `isClassSatisfiable` method (WASM rebuild required)**

**Goal:** Expose `isClassSatisfiable(store, classIri): Promise<boolean>` — a per-class satisfiability check that submits a targeted `OPSSATISFIABILITY` requirement to Konclude's pipeline without a full hierarchy dump.

**Requirements:** R5, R8

**Dependencies:** Unit 2 (establishes JS method pattern)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (new `isSatisfiable(classIri)` method)
- Modify: `src/bindings.cpp` (register `isSatisfiable`)
- Modify: `ts/worker.ts` (add `isSatisfiable` worker command)
- Modify: `ts/index.ts` (public `isClassSatisfiable(store, classIri)`)
- Modify: `ts/types.ts` (no new types needed; uses `Promise<boolean>`)
- Test: `tests/integration/satisfiability.test.ts` (new file)

**Approach:**
- C++ method `KoncludeReasoner::isSatisfiable(const std::string& classIri): bool`:
  - Requires a prior `classification()` call (i.e., `mClassified` must be true); return an error state if not classified.
  - Locate the concept corresponding to `classIri` in the ontology's concept hash.
  - If concept not found → return `true` (open-world: unknown class is satisfiable).
  - Query the post-classification taxonomy: an unsatisfiable class is placed as an equivalent of `owl:Nothing` in the hierarchy. Check if `classIri`'s taxonomy node is the Nothing node or equivalent to it.
  - No new `prepareOntology()` call needed — satisfiability is determined by the taxonomy produced during `classification()`.
- TS: `isClassSatisfiable(store, classIri)` auto-triggers `classify(store)` if needed, then calls worker `isSatisfiable(classIri)`.

**Patterns to follow:**
- `KoncludeReasoner::consistency()` (reads directly from ontology object post-classification)
- Worker command pattern in `ts/worker.ts` for methods returning a scalar

**Test scenarios:**
- Happy path: `isClassSatisfiable(store, 'owl:Nothing')` → false for any ontology
- Happy path: `isClassSatisfiable(store, 'owl:Thing')` → true for any consistent ontology
- Happy path: GALEN — all named classes satisfiable (GALEN is consistent)
- Happy path: an ontology with `SubClassOf(A And(B, ComplementOf(B)))` → `A` is unsatisfiable → false
- Edge case: unknown classIri (not in ontology) → true (open-world)
- Edge case: call before classify → auto-triggers classify, then answers
- Integration: `isSatisfiable(C) = false` implies `C` appears below `owl:Nothing` in the hierarchy from `classify(store)` → verified both ways

**Verification:**
- Results match native `IsClassSatisfiable` OWLlink responses for LUBM, GALEN, Roberts test fixtures
- WASM rebuild succeeds, `npm run patch-wasm` runs cleanly, 199/199 tests pass

---

- [ ] **Unit 6: C++ inverse property extraction (WASM rebuild required)**

**Goal:** Add target→source direction to role extraction in `buildInferredTripleBuffer`, enabling `getObjectPropertySources(store, individual, property)` and `getObjectPropertiesOfTarget(store, individual)` in the TS layer.

**Requirements:** R6, R8

**Dependencies:** Unit 2 (JS methods read from buffer), Unit 5 (shares WASM rebuild)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (extend role extraction loop in `buildInferredTripleBuffer`)
- Modify: `ts/index.ts` (implement `getObjectPropertySources`, `getObjectPropertiesOfTarget`)
- Modify: `ts/types.ts` (no new types needed)
- Test: `tests/integration/per-entity-queries.test.ts` (extend with sources tests)

**Approach:**
- In `buildInferredTripleBuffer`, the current role extraction loop calls `CRoleRealization::visitTargetIndividuals` for each source individual and property. After emitting `source → target`, also emit `target → source` using the same triple format but with subjects and objects swapped.
- This effectively doubles the role assertion count in the buffer — matching what native Konclude returns from `GetObjectPropertySources`.
- The inverse triples use the same property IRI; the subject/object swap makes them `target property source` quads in `INFERRED_GRAPH_IRI`.
- JS `getObjectPropertySources(store, individual, property)` then reads `store.getSubjects(property, individual, INFERRED_GRAPH)` — same lookup pattern as `getObjectPropertyTargets` but with subject/object reversed.
- JS `getObjectPropertiesOfTarget(store, individual)` enumerates distinct predicates in `INFERRED_GRAPH` where individual appears as object (excluding rdf:type, rdfs:subClassOf, owl:equivalentClass, owl:sameAs).
- **Warning**: emitting both directions doubles the role count in `buildInferredTripleBuffer`. This will change WASM and TS `inferredTriples` counts for Roberts and LUBM+data. Update bench expected values accordingly.

**Patterns to follow:**
- Existing `CRoleRealization` visitation in `src/KoncludeReasoner.cpp` (source→target pass)
- Four-fix invariants from `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`

**Test scenarios:**
- Happy path: `getObjectPropertySources(store, target, prop)` for Roberts individual — returns all sources that have `prop target` in INFERRED_GRAPH
- Happy path: `getObjectPropertyTargets(store, source, prop)` and `getObjectPropertySources(store, target, prop)` are inverses — if A is in targets(S, p), then S is in sources(A, p)
- Happy path: `getObjectPropertiesOfTarget(store, target)` returns all properties for which target appears as an object
- Edge case: individual with no incoming role assertions → `getObjectPropertySources` returns empty
- Integration: Roberts family — sum of `|targets(s, p)|` over all s, p equals sum of `|sources(t, p)|` over all t, p (conservation of role assertion count across both directions)

**Verification:**
- Roberts WASM role assertion count doubles as expected (sources + targets both directions)
- Bench expected values updated in plan and verified in bench run
- 199/199 tests pass after rebuild

## System-Wide Impact

- **Unchanged invariants**: `classify(store)`, `materialize(store)`, `checkConsistency(store)`, `classifyProperties(store)`, `isEntailed`, `explain`, `explainInconsistency`, `whatIf` — signatures, semantics, and worker commands all unchanged.
- **INFERRED_GRAPH_IRI content change (Unit 6)**: adding inverse role triples doubles the role assertion count. Any code reading all quads from `INFERRED_GRAPH_IRI` will see more triples. `_materializeCache` fingerprint remains correct (it keys on input quads, not output). Benchmark expected values must be updated.
- **Bench timing unaffected**: OWLlink queries (Unit 4) run only for triple counting, not in the timing loop.
- **WASM binary changes in Units 5 and 6**: both can be built in a single `make build-wasm` pass since they are in the same translation unit.
- **Worker dispatch table**: Units 5 adds one new command (`isSatisfiable`); worker.ts command map must be extended.
- **API surface parity**: after Units 1–6, the gap matrix documents exactly what is and is not covered. `explain`/`explainInconsistency` and `isEntailed` are not part of the OWLlink standard but are extensions beyond native parity.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `CRoleRealization` API for reverse traversal differs from forward — `visitSourceIndividuals` may not exist or may have different semantics | Audit C++ source for `CRoleRealization` before implementing Unit 6; if missing, emit inverse by building an inverted map during the forward pass |
| Roberts OWLlink request with 3866 individuals × many properties produces a very large XML — Docker OWLlink parsing is slow | Measure first run; add a size cap and fallback to ClassAssertion-only count if > 10 MB request |
| `isClassSatisfiable` implementation reading from taxonomy may not correctly handle open-world cases where a class is absent from the hierarchy | Add an explicit "absent class → true" guard; write test fixture for unknown IRI |
| Unit 6 inverse emission doubles role count, breaking existing integration tests that check exact `inferredTriples` values | Audit all integration tests for role count assertions before landing Unit 6; update expected values as part of the unit |
| BackendAssCache sameAs bug (plan-030) causes owl:sameAs count to drop to zero after mixed call sequences | Document limitation in `getObjectPropertySources` and `getSameIndividuals` JSDoc; use fresh instance in tests |

## Sources & References

- Native OWLlink query vocabulary: `vendor/konclude/Source/Parser/COWLlinkQtXMLCommandParser.cpp`
- CLI command registry: `vendor/konclude/Source/Control/Interface/CommandLine/CCommandLinePreparationTranslatorSelector.cpp`
- OWLlink request examples: `vendor/konclude/Tests/*.xml`
- Current WASM API: `src/KoncludeReasoner.cpp`, `src/bindings.cpp`, `ts/index.ts`
- Gap analysis: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- subClassOf extraction patterns: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- ABox mapper flags: `docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md`
- BackendAssCache sameAs: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
