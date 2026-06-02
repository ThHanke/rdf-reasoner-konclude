---
title: "feat: Axiom API integration tests + README OWL 2 DL coverage update"
type: feat
status: active
date: 2026-06-02
origin: docs/brainstorms/2026-06-02-010-axiom-api-integration-tests-requirements.md
---

# feat: Axiom API integration tests + README OWL 2 DL coverage update

## Overview

Add a new integration test file covering `isEntailed()`, `whatIf()`, `explain()`,
`explainInconsistency()`, and `validate()` against the real WASM binary. Add sequential
call state-isolation tests. Fix the README OWL 2 DL coverage table: add cases 7–14,
correct cases 3/4/10 from `UPSTREAM_LIMITATION` to `PARITY`, remove the stale footnote,
and add return-type signatures for the axiom API methods.

## Problem Frame

Four shipped API methods — `isEntailed`, `whatIf`, `explain`, `explainInconsistency` — have
zero integration coverage against real WASM. `validate` has three integration tests in
`consistency.test.ts` but no scenario against a real-world ontology (Roberts Family). Sequential
calls across operation types have no explicit state-isolation tests.

The README OWL 2 DL coverage table shows only six of fourteen consistency cases. Cases 3 and 4
are labelled `UPSTREAM_LIMITATION` with a note claiming they cannot be fixed in this package —
both are factually wrong after patches 027-028 and 029 landed. Case 10 has the same problem.

(see origin: `docs/brainstorms/2026-06-02-010-axiom-api-integration-tests-requirements.md`)

## Requirements Trace

- R1. `isEntailed(quads)` returns `true` for entailments derivable from `classify()` output
- R2. `isEntailed(quads)` returns `false` for triples not entailed
- R3. `isEntailed(quads)` works for rdf:type assertions derived from object property chains
- R4. `whatIf(additions)` returns `{ added, removed }` delta without mutating base store state
- R5. `whatIf` with contradicting triple yields a non-empty `added` (inconsistency makes everything entailed) or `removed` delta, confirming the hypothetical pipeline ran
- R6. Two independent `whatIf` calls on the same base store produce correct independent results
- R7. `explain(store, axiom)` returns a non-empty `Quad[][]` for an entailed axiom
- R8. `explainInconsistency(store)` returns a non-empty `Quad[][]` for an inconsistent ontology
- R9. `explain(store, axiom)` returns `[]` for a non-entailed axiom
- R10. `validate(store)` returns `{ consistent: true, errors: [], warnings: [] }` for Roberts Family
- R11. `validate(store)` with a class explicitly subsumed by `owl:Nothing` produces a warning with a non-empty justification
- R12. `classify()` then `materialize()` on the same `RdfReasoner` instance produce correct results
- R13. `checkConsistency()` then `classify()` on the same instance produces correct results
- R14. `whatIf()` does not affect subsequent `classify()` or `materialize()` results
- R15. README consistency table shows all 14 cases; cases 3, 4, 10 show `PARITY (WASM surpasses native v0.7.0)`
- R16. README axiom API section includes return-type signatures for all five methods
- R17. Stale footnote "Cases 3 and 4 cannot be fixed in this package without upstream changes" removed

## Scope Boundaries

- No new WASM kernel changes — tests verify existing behavior only
- `classifyProperties()` data-property tests are out of scope (sibling plan 011)
- Performance / timing characteristics are out of scope
- Browser integration is out of scope
- `validate()` inconsistency-error tests that duplicate `consistency.test.ts` lines 97–131 are not added

### Deferred to Separate Tasks

- `classifyProperties()` full integration suite: sibling plan 011

## Context & Research

### Relevant Code and Patterns

- `ts/index.ts` — all five axiom methods fully implemented; confirmed return types:
  - `isEntailed(store, quad)` → `Promise<boolean | null>` (`null` for unsupported predicates)
  - `isEntailed(store, quads)` → `Promise<(boolean | null)[]>`
  - `whatIf(store, additions, opts?)` → `Promise<{ added: Quad[], removed: Quad[] }>`
    - Delta is relative to current `INFERRED_GRAPH_IRI` content
    - Does NOT mutate base store; invalidates all operation caches after running
  - `explain(store, axiom, opts?)` → `Promise<Quad[][]>`
    - Returns `[]` if axiom is not entailed (confirmed: `ts/index.ts:1071–1072`)
    - Throws for unsupported predicates
  - `explainInconsistency(store, opts?)` → `Promise<Quad[][]>`
    - Returns `[]` if ontology is consistent
  - `validate(store, opts?)` → `Promise<ValidationResult>`
    - `{ consistent: boolean, errors: Quad[][], warnings: ClassWarning[] }`
- `ts/types.ts` — `ValidationResult`, `ClassWarning`, `InferenceDelta`, `WhatIfOptions`, `ExplainOptions`, `ValidateOptions`
- `INFERRED_GRAPH_IRI = "urn:konclude:inferred"` — named graph where inferred triples are written
- `tests/integration/consistency.test.ts` — canonical WASM guard + lifecycle pattern
- `tests/integration/roberts-family.test.ts` — Store-based call, fresh instance for ABox test
- `tests/helpers/fixture.ts` — `loadFixture(name)` returns `Quad[]`
- `tests/fixtures/roberts-family.nt` — primary fixture: rich ABox + TBox, 405 individuals
- `tests/fixtures/inconsistent.nt` — two-triple ontology: `owl:Ontology` + `ex:a rdf:type owl:Nothing`
- `tests/fixtures/issue13/` — per-case OWL fixtures for cases 1–14

### Institutional Learnings

- **BackendAssCache n=3 bug** (`docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`): sequential `materialize()` calls at exactly n=3 ABox calls + 1 `classify()` + `materialize()` with `owl:sameAs` produces silent wrong results. Unfixed. Tests involving `owl:sameAs` must use a fresh `RdfReasoner` instance.
- **UPSTREAM_LIMITATION scope** (`docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`): `UPSTREAM_LIMITATION` now applies only to `materialize()` hangs (AllDisjointClasses blank-node, disjointUnionOf, NPA consistent) and FunctionalProperty ALIF+ hang. All 14 `checkConsistency()` cases are PARITY. Cases 3, 4, 10 are WASM-surpasses-native.
- **fileParallelism: false** (vitest config): each integration test file creates a WASM Worker that spawns pthreads; running files in parallel deadlocks the pthread pool. New file must not change this config.
- **isEntailed supported predicates** (`ts/index.ts:626–638`): only `rdfs:subClassOf`, `owl:equivalentClass`, `rdf:type`, `rdfs:subPropertyOf`. All others return `null`.

### External References

None — established codebase patterns are sufficient.

## Key Technical Decisions

- **Inline Turtle fixtures for axiom API tests**: predictable justification structure; easier to control ABox+TBox axioms than reading a 400-individual fixture file. `inconsistent.nt` and `case1-disjoint-direct.owl` are used for `explainInconsistency` (small, known structure). Roberts Family store is used for `isEntailed`/`validate` at scale.
- **Fresh `RdfReasoner` per describe block**: each `describe.skipIf` block in `axiom-api.test.ts` creates its own `RdfReasoner` in `beforeAll` / `afterAll`. This avoids cross-test state pollution and the n=3 BackendAssCache bug.
- **R3 interpretation**: `isEntailed` does not support arbitrary property IRIs (returns `null`). R3 tests rdf:type entailment derived from an object property chain: a TransitiveProperty + `rdfs:domain` axiom makes `isEntailed(store, alice rdf:type Person)` work via the materialize pipeline.
- **R5 (whatIf + contradiction) expectation**: adding an axiom that makes the ontology inconsistent. The delta direction (`added` vs `removed`) is unknown until runtime. Pre-condition: establish a non-empty `INFERRED_GRAPH_IRI` via `materialize(store)` before running `whatIf` — the R5 assertion (`added.length + removed.length > 0`) is only meaningful if the base state had quads to compare against. The implementer should confirm empirically what the inconsistent hypothetical produces, then write a direction-specific assertion (e.g., `expect(removed.length).toBeGreaterThan(0)`) rather than the weaker total-length check. Note: `whatIf` does NOT return an `isConsistent` flag — this is not exposed by the current API.
- **Validate duplication guard**: `consistency.test.ts` lines 97–131 already cover: inconsistent → `consistent: false, errors non-empty`; unsatisfiable class → warning with IRI; validate+classify sequential no-stall. Unit 4 adds different scenarios (Roberts Family at scale, justification non-empty for warning).

## Open Questions

### Resolved During Planning

- **whatIf() return type**: `{ added: Quad[], removed: Quad[] }` delta relative to current INFERRED_GRAPH_IRI. Confirmed from `ts/index.ts:848–921`. Base store is never mutated; all operation caches are invalidated after running (must re-load on the next real call).
- **explain() on non-entailed triple**: returns `[]` (empty array). Confirmed from `ts/index.ts:1071–1072`. Throws (rejects) for unsupported predicates — does NOT return `null` like `isEntailed` does.
- **README cases 3, 4, 10 status**: currently shown as `UPSTREAM_LIMITATION` with `consistent ✗` for WASM. Both are factually wrong — WASM correctly reports `inconsistent ✓`. Status should be `PARITY (WASM surpasses native v0.7.0)` with a note that native Konclude v0.7.0 has the bug.

### Open Questions from Document Review (2026-06-02)

- **R3 gap — brainstorm requires property-assertion entailment checking**: brainstorm R3 states "isEntailed works for object property assertions e.g. [alice, hasAncestor, eve] via transitive property chain." The current `isEntailed` API returns `null` for non-standard predicates — property assertion entailment is genuinely unsupported. R3 as written in this plan tests rdf:type via domain inference as a proxy. Either close brainstorm R3 as "not achievable with current API" and create a separate work item for a property-assertion `isEntailed` overload, or accept the proxy test as the R3 coverage.
- **R5 whatIf realization on inconsistent ontology**: `whatIf()` unconditionally calls `realization` on the hypothetical (ts/index.ts:887). Realization on an inconsistent ontology is an untested code path. Before writing R5 as a normal test, spike the exact contradiction fixture in an isolated Node.js script to confirm realization completes without hanging. If it hangs (similar to AllDisjointClasses/NPA UPSTREAM_LIMITATION patterns), mark R5 as `it.skip` with a TODO.
- **Validate duplication guard drift risk**: the plan describes `tests/integration/consistency.test.ts:97–131` contents (3 scenarios). If that file changes, the deduplication claim silently becomes inaccurate. Implementer should verify those lines still cover the stated scenarios before adding Unit 4 tests.
- **R16 brainstorm scope — examples per method**: brainstorm R16 specifies "type signatures and one example each." This plan delivers type signatures only. Either add one short code snippet per method to README (5 examples total) in Unit 6, or document this reduction explicitly here and create a follow-up plan.

### Deferred to Implementation

- **Exact Roberts Family individuals for isEntailed**: the implementer should inspect `tests/fixtures/roberts-family.nt` to find a concrete `(individual, rdf:type, class)` triple that is provably entailed and one that is provably not, rather than guessing IRIs. The test setup already materializes roberts-family in `beforeAll`; use `tests/fixtures/roberts-native-abox.nt` as a reference for provably-entailed rdf:type triples.
- **R10 Roberts Family `validate()` warnings**: run `validate(robertsFamilyStore)` once against the current WASM binary before hardcoding `warnings: []`. If any unsatisfiable class appears, document its IRI and adjust the assertion. Roberts Family's disjoint axioms (Female/Male, Person/Sex, Marriage/Sex) should not produce unsatisfiable classes, but this has not been machine-verified.
- **R5 whatIf contradiction delta direction**: run the R5 `whatIf` test once against the real WASM binary to observe whether adding an inconsistency-inducing axiom changes `added`, `removed`, or both. Then replace the total-length check with a direction-specific assertion. The pre-condition (non-empty base INFERRED_GRAPH_IRI before calling `whatIf`) must be verified first.
- **R6 independence test construction**: use `additions1 = [axiom entailing ClassX rdf:type SomeType]` and `additions2 = [axiom entailing ClassY rdf:type SomeType]` where X ≠ Y. After each `whatIf` call, assert the returned delta contains entailments involving X but not Y (or vice versa), rather than asserting both are merely non-empty.

## Implementation Units

- [ ] **Unit 1: isEntailed() integration tests**

**Goal:** Integration tests for `isEntailed()` covering R1, R2, R3.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `tests/integration/axiom-api.test.ts`

**Approach:**
- One `describe.skipIf(!wasmExists)("isEntailed() integration")` block with its own `RdfReasoner`
- Load Roberts Family as a `Store` in `beforeAll`; call `await reasoner.materialize(store, { includeClassHierarchy: true })` — this writes rdf:type AND rdfs:subClassOf/owl:equivalentClass to `INFERRED_GRAPH_IRI` in a single call
- Note: `isEntailed(rdfs:subClassOf)` always runs `_classifyInline` internally regardless of materialize output (per `_opForPredicate` at `ts/index.ts:626-638`). After `materialize`, `_classifyCache` is null, so the subClassOf check triggers an additional classify Worker call — this is expected behavior, not a bug. The `includeClassHierarchy:true` ensures subClassOf triples are available in `INFERRED_GRAPH_IRI` for inspection, but `isEntailed` will re-run classify via the cache-miss path regardless.
- For R3: inline Turtle ontology with a `owl:TransitiveProperty` + `rdfs:domain` axiom; ABox assertions `alice hasAncestor bob`, `bob hasAncestor carol`; after materialize, `alice rdf:type Person` is entailed via domain inference. Note: `isEntailed` cannot check raw property assertions (e.g. `[alice, hasAncestor, carol]`) — it returns `null` for non-standard predicates. R3 tests rdf:type entailment as a proxy for property chain reasoning.

**Patterns to follow:**
- `tests/integration/consistency.test.ts` — WASM guard, lifecycle, `Store` construction
- `tests/integration/roberts-family.test.ts` — `loadFixture` + `new Store(quads)`

**Test scenarios:**
- Happy path: `isEntailed(store, [alice, rdf:type, SomeClass])` → `true` for a class entailed in Roberts Family materialize output
- Happy path: `isEntailed(store, [ClassA, rdfs:subClassOf, ClassB])` → `true` for a relation in the TBox hierarchy
- Happy path (R2): `isEntailed(store, [alice, rdf:type, NonExistentClass])` → `false`
- Happy path: batch `isEntailed(store, [quad1, quad2])` → returns array of the same length with correct booleans
- Edge case: unsupported predicate `owl:sameAs` → single returns `null`, batch entry is `null`
- Integration (R3): inline Turtle with TransitiveProperty + domain; `isEntailed(store, [alice, rdf:type, Person])` → `true` after materialize on the hypothetical chain

**Verification:**
- All `isEntailed` tests pass with no WASM mocks; `npm test` includes the file

---

- [ ] **Unit 2: whatIf() integration tests**

**Goal:** Integration tests for `whatIf()` covering R4, R5, R6.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 1 (same file)

**Files:**
- Modify: `tests/integration/axiom-api.test.ts`

**Approach:**
- One `describe.skipIf(!wasmExists)("whatIf() integration")` block with a fresh `RdfReasoner`
- Use an inline Turtle ontology with a few classes and one individual; pre-establish a known `INFERRED_GRAPH_IRI` state via `materialize(store)`
- R4: call `whatIf(store, [newAxiom])`, verify `{ added, removed }` is returned; then call `materialize(store)` again and verify it produces the same result as the first materialize (base not mutated). Key check: store's base-graph quads are unchanged after `whatIf`.
- R5: call `whatIf(store, [contradictingAxiom])` where the addition makes the ontology inconsistent; verify that the returned delta (added + removed) has non-zero total length, confirming the hypothetical pipeline ran with a different result than the base.
- R6: call `whatIf(store, additions1)` and `whatIf(store, additions2)` where `additions1 ≠ additions2`; verify each returns results consistent only with its own additions (delta from additions1 is not present in delta from additions2).

**Patterns to follow:**
- `ts/index.ts:856–920` — whatIf implementation (base quads exclude INFERRED/HYPOTHETICAL graphs; all caches invalidated after)

**Test scenarios:**
- Happy path (R4): `whatIf` returns `{ added: Quad[], removed: Quad[] }`; subsequent `materialize(store)` produces the pre-whatIf result (cache invalidation means re-running, but result is same because base store didn't change)
- Happy path (R4): `store.getQuads(null, null, null, INFERRED_GRAPH_IRI)` contents are unchanged after `whatIf` — `whatIf` does NOT write to `INFERRED_GRAPH_IRI` unless `opts.outputGraph` is provided (`ts/index.ts:902-908`). The subsequent `materialize()` re-run comparison is the primary isolation check.
- Edge case (R5): pre-condition — assert base `materialize(store)` produces non-empty `INFERRED_GRAPH_IRI` before calling `whatIf`; then call `whatIf(store, [axiom making ontology inconsistent])`; empirically observe delta direction on first run, then write direction-specific assertion (see Deferred to Implementation)
- Integration (R6): two independent `whatIf` calls on same base using `additions1 = [ClassX rdfs:subClassOf SomeDomain]` and `additions2 = [ClassY rdfs:subClassOf SomeDomain]` (X ≠ Y); assert delta1 contains entailments involving X but not Y, and delta2 contains entailments involving Y but not X

**Verification:**
- `whatIf` tests pass; no store mutation observed; deltas are non-empty when additions change the inferred set

---

- [ ] **Unit 3: explain() and explainInconsistency() integration tests**

**Goal:** Integration tests for `explain()` and `explainInconsistency()` covering R7, R8, R9.

**Requirements:** R7, R8, R9

**Dependencies:** Unit 1 (same file)

**Files:**
- Modify: `tests/integration/axiom-api.test.ts`

**Approach:**
- One `describe.skipIf(!wasmExists)("explain() integration")` block
- For R7: use a small inline Turtle with `ClassA rdfs:subClassOf ClassB` (single axiom); call `explain(store, [ClassA, rdfs:subClassOf, ClassB])`; expect `justs.length >= 1` and `justs[0].length >= 1`. The justification should contain the subClassOf axiom itself.
- For R8: use `inconsistent.nt` fixture (2 triples: `owl:Ontology` + `ex:a rdf:type owl:Nothing`); call `explainInconsistency(store)`; expect `justifications.length >= 1` and `justifications[0].length >= 1`. The justification should contain the `rdf:type owl:Nothing` triple.
- For R9: use the same store as R7 but check a non-entailed axiom like `[ClassB, rdfs:subClassOf, ClassA]` (reverse direction); expect `justs` to be `[]`.
- Use 360s timeout for all tests since BlackBox issues many Worker round-trips.

**Patterns to follow:**
- `ts/index.ts:1038–1177` — explain() implementation; `[]` returned when `!entailedByAll`
- `ts/index.ts:1190–1308` — explainInconsistency() implementation; `[]` returned when consistent

**Test scenarios:**
- Happy path (R7): `explain(store, A rdfs:subClassOf B)` on inline ontology → `Quad[][]` with length ≥ 1; inner array has length ≥ 1
- Happy path (R7): justification inner array contains the subClassOf axiom (the axiomatic source)
- Happy path (R8): `explainInconsistency(store)` on `inconsistent.nt` → `justifications[0].length >= 1`
- Happy path (R8): `explainInconsistency(store)` on consistent ontology → returns `[]`
- Edge case (R9): `explain(store, B rdfs:subClassOf A)` where that direction is NOT entailed → returns `[]`

**Verification:**
- All explain / explainInconsistency tests pass; `[]` returned for non-entailed and consistent cases

---

- [ ] **Unit 4: validate() integration tests**

**Goal:** Integration tests for `validate()` covering R10 and R11 scenarios NOT already in `consistency.test.ts`.

**Requirements:** R10, R11

**Dependencies:** Unit 1 (same file)

**Files:**
- Modify: `tests/integration/axiom-api.test.ts`

**Approach:**
- One `describe.skipIf(!wasmExists)("validate() integration")` block
- R10: load Roberts Family as a `Store`; call `validate(store)`; expect `consistent: true`, `errors: []`, `warnings: []` (Roberts Family has no unsatisfiable classes; confirms no false warnings on a large real-world ontology)
- R11: inline Turtle with `ex:EmptyClass a owl:Class ; rdfs:subClassOf owl:Nothing` and actual ABox individuals triggering the class; call `validate(store, { maxJustificationsPerWarning: 1 })`; expect `warnings` contains an entry for `EmptyClass` with `justifications.length >= 1` (tests that justification is non-empty, not just the IRI list — this is NOT covered by the existing test in `consistency.test.ts` line 106–122 which only checks `warnIRIs.includes(...)`)

**Execution note:** Do not duplicate: `consistent: false → errors non-empty`, `consistent ontology with EmptyClass → warnIRIs.contains`, `validate + classify sequential` — all three already in `tests/integration/consistency.test.ts:97–131`.

**Patterns to follow:**
- `tests/integration/consistency.test.ts:106–131` — validate pattern with inline Turtle

**Test scenarios:**
- Happy path (R10): `validate(robertsFamilyStore)` → `{ consistent: true, errors: [], warnings: [] }`
- Happy path (R11): inline ontology with `ExplicitlyEmpty rdfs:subClassOf owl:Nothing`; `validate(store, { maxJustificationsPerWarning: 1 })` → `warnings[0].justifications[0].length >= 1` (justification is populated)
- Edge case (R11): `validate(store, { maxJustificationsPerWarning: 0 })` on same ontology → `warnings[0].justifications` is `[]` (IRI-only mode)

**Verification:**
- `validate` on Roberts Family passes within 360s; warning justification is non-empty for unsatisfiable class

---

- [ ] **Unit 5: Sequential call state isolation tests**

**Goal:** Integration tests for R12, R13, R14 — confirming no cross-contamination between operation types on a single `RdfReasoner` instance.

**Requirements:** R12, R13, R14

**Dependencies:** Units 1–4 (same file)

**Files:**
- Modify: `tests/integration/axiom-api.test.ts`

**Approach:**
- One `describe.skipIf(!wasmExists)("Sequential call state isolation")` block with a fresh `RdfReasoner`
- Use lightweight inline Turtle ontologies (not Roberts Family) so the tests complete quickly and isolation is obvious without fixture side-effects
- R12 (`classify → materialize`): load a TBox+ABox ontology into a `Store`; call `classify(store)` → **immediately** assert inferred subClassOf count > 0 in `INFERRED_GRAPH_IRI` **before** calling materialize (because `_materializeOnStore` calls `store.removeQuads()` on `INFERRED_GRAPH_IRI` before rewriting it — subClassOf triples written by classify will be gone after materialize unless `includeClassHierarchy:true`); then call `materialize(store)` → assert inferred rdf:type count > 0. Alternatively, use only `materialize(store, { includeClassHierarchy: true })` and assert both subClassOf and rdf:type are present in a single assertion block.
- R13 (`checkConsistency → classify`): call `checkConsistency(store)` on a consistent store → `true`; call `classify(store)` → assert inferred triples count > 0; no hang, no stale state
- R14 (`whatIf → classify`): call `whatIf(store, additions)` → note the delta; call `classify(store)` on the SAME store (no additions) → inferred triples should match pre-whatIf classify result (whatIf invalidated caches, so classify re-loads and produces correct output for the unmodified base)

**Critical constraint:** Do NOT test `owl:sameAs` entailment in sequential tests (BackendAssCache n=3 bug: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`).

**Patterns to follow:**
- `tests/integration/roberts-family.test.ts:97–104` — sequential call stability test pattern
- `tests/integration/consistency.test.ts:124–131` — validate+classify sequential pattern

**Test scenarios:**
- Integration (R12): `classify(store)` → assert inferred subClassOf count > 0 immediately; then `materialize(store)` → assert inferred rdf:type count > 0 (subClassOf triples written by classify are cleared by materialize — assert subClassOf BEFORE calling materialize, or use `materialize({ includeClassHierarchy: true })` and assert both predicates after a single call)
- Integration (R13): `checkConsistency(store)` → `true`; then `classify(store)` → inferred triples count > 0; no queue stall
- Integration (R14): `whatIf(store, additions)` returns a delta; then `classify(store)` returns inferred triples matching what classify alone would produce on the unmodified store

**Verification:**
- All three sequential call combinations produce correct results; no hangs; test completes within 360s

---

- [ ] **Unit 6: README OWL 2 DL coverage table + axiom API return types**

**Goal:** Fix the README consistency table (R15, R17) and add axiom API return-type signatures (R16).

**Requirements:** R15, R16, R17

**Dependencies:** None (documentation-only change)

**Files:**
- Modify: `README.md` (lines 419–475 — OWL 2 DL coverage section)
- Modify: `README.md` (lines 174–196 — axiom API options section, to add return types)

**Approach:**

**Consistency table changes** (lines 425–440):
1. Replace the 6-row table with a 14-row table covering all cases from `tests/fixtures/issue13-native-verdicts.json`
2. Cases 3, 4, 10: change WASM column from `consistent ✗` → `inconsistent ✓`; change status from `UPSTREAM_LIMITATION` → `PARITY (WASM surpasses native v0.7.0)`
3. Cases 7–14: add rows (see table below)
4. Remove the stale footnote (lines 438–440): "UPSTREAM_LIMITATION means native Konclude v0.7.0 also misses... Cases 3 and 4 cannot be fixed..."
5. Replace with an accurate footnote explaining: `UPSTREAM_LIMITATION` = `materialize()` pipeline hangs (AllDisjointClasses/disjointUnionOf/NPA blank-node) and FunctionalProperty ALIF+ hang. The "(WASM surpasses native v0.7.0)" note means native Konclude v0.7.0 has the bug; this package fixes it.

Full replacement table content (directional guidance):

| #   | Violation pattern                                    | Native               | WASM               | Status                              |
| --- | ---------------------------------------------------- | -------------------- | ------------------ | ----------------------------------- |
| 1   | `owl:disjointWith` (direct)                          | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 2   | `owl:disjointWith` (via domain/range inference)      | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 3   | `owl:AsymmetricProperty` bidirectional assertion     | consistent ✗ (bug)   | inconsistent ✓     | **PARITY (WASM surpasses native)**  |
| 4   | `owl:IrreflexiveProperty` self-reference             | consistent ✗ (bug)   | inconsistent ✓     | **PARITY (WASM surpasses native)**  |
| 5   | `owl:maxQualifiedCardinality` + `owl:differentFrom`  | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 6   | `owl:allValuesFrom` + `owl:disjointWith`             | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 7   | `owl:ReflexiveProperty` + `ObjectComplementOf(HasSelf)` | inconsistent ✓    | inconsistent ✓     | **PARITY**                          |
| 8   | `owl:InverseFunctionalProperty` + `DifferentIndividuals` | inconsistent ✓   | inconsistent ✓     | **PARITY**                          |
| 9   | `owl:AllDisjointClasses` (3-way) + double membership | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 10  | `DisjointObjectProperties` + `EquivalentObjectProperties` | consistent ✗ (bug) | inconsistent ✓   | **PARITY (WASM surpasses native)**  |
| 11  | `owl:disjointUnionOf` + double membership            | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 12  | `owl:NegativeObjectPropertyAssertion` contradiction  | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |
| 13  | `DataAllValuesFrom xsd:minInclusive` (consistent)    | consistent ✓         | consistent ✓       | **PARITY**                          |
| 14  | `DataAllValuesFrom xsd:minInclusive` (inconsistent)  | inconsistent ✓       | inconsistent ✓     | **PARITY**                          |

New footnote replacing lines 438–440:
> **PARITY (WASM surpasses native v0.7.0)** means native Konclude v0.7.0 has a kernel bug for this
> construct; this package fixes it via patches 027–029. **UPSTREAM_LIMITATION** (not shown in the
> table above — applies to `materialize()` only) means the realization pipeline hangs on these
> constructs: `owl:AllDisjointClasses`/`owl:disjointUnionOf`/`NegativePropertyAssertion` blank-node
> NTriples format, and `owl:FunctionalProperty` → `owl:sameAs` (ALIF+ precompute). Use
> `checkConsistency()` for these where possible.

**Axiom API return types** (lines 174–196):
Add TypeScript return-type annotations for the five methods in the existing API reference section.
The options section at lines 174–196 shows input types; add a companion block showing return types:

```typescript
// Return types
isEntailed(store, axiom: Quad):    Promise<boolean | null>
isEntailed(store, axioms: Quad[]): Promise<(boolean | null)[]>
whatIf(store, additions):          Promise<{ added: Quad[], removed: Quad[] }>
explain(store, axiom):             Promise<Quad[][]>   // [] if not entailed; throws for unsupported predicate
explainInconsistency(store):       Promise<Quad[][]>   // [] if consistent
validate(store):                   Promise<ValidationResult>
// where:
interface ValidationResult {
  consistent: boolean;
  errors:     Quad[][];        // MIPS; non-empty only when consistent === false
  warnings:   ClassWarning[];  // one per unsatisfiable class
}
interface ClassWarning {
  classIRI:       string;
  justifications: Quad[][];
}
```

**Test expectation:** none — documentation-only change.

**Verification:**
- All 14 cases visible in the table; cases 3, 4, 10 show correct native/WASM columns and PARITY status
- Stale footnote about upstream changes for cases 3/4 is gone
- Return-type block appears after the options block in the API reference section
- `npm test` still passes (no code changes)

## System-Wide Impact

- **Interaction graph:** New test file creates its own `RdfReasoner` instances; no shared state with existing test files. `fileParallelism: false` ensures no pthread pool contention.
- **Error propagation:** Tests assert on WASM output; if WASM binary is absent the suite is skipped via `describe.skipIf(!wasmExists)`.
- **State lifecycle risks:** Each `describe` block in `axiom-api.test.ts` has its own `beforeAll`/`afterAll` lifecycle. `whatIf` invalidates all caches — tests after a `whatIf` call must not assume stale cache state.
- **API surface parity:** No API changes; tests only call public methods.
- **Integration coverage:** The new tests are the first to exercise `isEntailed`, `whatIf`, `explain`, `explainInconsistency` against real WASM. They validate that the BlackBox algorithm actually shrinks justifications via the real Konclude kernel, not mocked responses.
- **Unchanged invariants:** `consistency.test.ts` validate tests (lines 97–131) are not modified. The new tests are additive.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| BlackBox explain iterations slow on large ontology | Use small inline Turtle fixtures for explain/explainInconsistency; 360s timeout |
| whatIf contradiction delta shape unknown | Assert `added.length + removed.length > 0` rather than specific counts; see deferred note |
| Roberts Family validate() warning check may produce false warnings for unexpected unsatisfiable classes | Test only `consistent: true, errors: [], warnings: []` — no class should be unsatisfiable in Roberts Family |
| BackendAssCache n=3 sameAs bug triggered in sequential tests | Excluded sameAs from sequential tests; documented constraint in Unit 5 |
| README table markdown alignment | Follow existing table column widths; run `trunk fmt` after editing |

## Documentation / Operational Notes

- Run `npm test` after Unit 6 to confirm no test regressions from README-only edits.
- The 14-row table replaces the 6-row table entirely; preserve the `### Consistency checking` heading.
- After this plan: the README `UPSTREAM_LIMITATION` label no longer appears in the consistency table — it is only relevant for the `materialize()` gap table which is not part of this plan.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-02-010-axiom-api-integration-tests-requirements.md](docs/brainstorms/2026-06-02-010-axiom-api-integration-tests-requirements.md)
- Related code: `ts/index.ts:626–831` (isEntailed, whatIf), `ts/index.ts:1038–1308` (explain, explainInconsistency, validate)
- Related code: `tests/integration/consistency.test.ts` — validate tests already present (lines 97–131)
- Related code: `tests/integration/roberts-family.test.ts` — Store-based lifecycle pattern
- Ground truth: `tests/fixtures/issue13-native-verdicts.json`
- Gap matrix: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- BackendAssCache bug: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
