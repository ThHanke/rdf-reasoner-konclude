---
title: "feat: Add normalizeDeclarations option — auto-inject OWL class declarations"
type: feat
status: active
date: 2026-05-19
---

# feat: Add normalizeDeclarations option — auto-inject OWL class declarations

## Overview

Konclude's RDF-to-OWL mapper requires explicit `rdf:type owl:Class` on every class URI before it registers that URI as an OWL concept. Bare `rdfs:subClassOf` triples without class declarations produce zero inferred triples — even when the RDFS or OWL vocabulary is present in the store (confirmed by investigation 2026-05-19).

This is spec-correct OWL 2 DL behaviour (OWL 2 RDF Mapping §3.2, CE(x) guard). Real OWL ontologies serialized by Protege, ROBOT, or the OWL API always carry explicit declarations. But naive RDF/Turtle input — including SPARQL query results, hand-written Turtle, and the user's prior n3-rule-based reasoning output — often omits them.

This feature adds an opt-in `normalizeDeclarations` preprocessing step that scans the input quads and injects the missing declarations before calling Konclude, matching what systems like GraphDB, OWLIM, and RDFox do as a materialization preprocessing step.

## Problem Frame

A user with a plain Turtle file containing only `rdfs:subClassOf` triples gets 0 inferred quads from `reason(store)`. The fix should not change default behaviour (no silent mutation, no surprise for OWL-expert users), but should be one option away for everyone else.

## Requirements Trace

- R1. `reason(store, { normalizeDeclarations: true })` on a store with only `rdfs:subClassOf` (no `rdf:type owl:Class`) produces non-empty inferred quads.
- R2. Default behaviour unchanged — `reason(store)` without the option still produces 0 inferred quads for undeclared input (no regression).
- R3. All existing 112 Node.js unit+integration tests continue to pass.
- R4. The option applies to all public API paths: `reason(store)`, `reason(quads)`, `checkConsistency(store)`, `checkConsistency(quads)`, `classify(quads)`.
- R5. Input is never mutated — the caller's Store and quad arrays are unchanged.
- R6. Performance overhead when option is `false` (default) is zero.

## Scope Boundaries

- MVP injects `rdf:type owl:Class` only. Object property / data property declarations are deferred.
- Does not run RDFS entailment rules. Injects declarations only, does not add domain/range inferences.
- Does not change the WASM binary or wire protocol.
- Does not change default API behaviour.

### Deferred to Separate Tasks

- `owl:ObjectProperty` / `owl:DatatypeProperty` declaration injection (separate PR, once class MVP is validated)
- `owl:NamedIndividual` injection for ABox individuals (separate PR)
- Full OWL 2 RL preprocessing pipeline (much larger scope; this is the first building block)

## Context & Research

### Relevant Code and Patterns

- `ts/types.ts` lines 8–19: `ReasoningOptions` interface — add `normalizeDeclarations?: boolean` here
- `ts/types.ts` lines 26–34: `StoreReasoningOptions` extends `ReasoningOptions`; new option is inherited automatically
- `ts/index.ts` `_reasonOnStore` (~line 197): insert normalization call before `encodeToBuffers()`
- `ts/index.ts` `_reasonOnQuads` (~line 222): insert normalization call before `encodeToBuffers()`
- `ts/index.ts` `checkConsistency` (~line 293): insert normalization call before `encodeToBuffers()`
- `ts/intern.ts` `encodeToBuffers(quads: Iterable<Quad>)`: accepts any iterable — a new `Quad[]` from the normalizer drops in cleanly
- `tests/unit/RdfReasoner.test.ts` lines 129–143: `decodeStrTableEntries` helper — intercepts `loadTripleBuffer` args; use this to verify injected IRIs appear in the string table
- `tests/unit/RdfReasoner.store.test.ts` lines 109–123: same pattern for the Store path

### Institutional Learnings

- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`: confirms mapper requires explicit `rdf:type owl:Class`; preprocessing in TS layer is the safe approach
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`: Konclude config flags have dual effects — no new WasmConfigProvider flag needed here (pure TS layer)

## Key Technical Decisions

- **New file `ts/normalize.ts`, not inline in `ts/index.ts`**: Pure function with no Worker dependency → can be unit-tested without any Worker mock. Keeps `ts/index.ts` readable.
- **Option on `ReasoningOptions`, not a new interface**: All public method signatures already accept `ReasoningOptions`. Adding the flag here propagates to all paths with zero signature churn.
- **Predicate set for class injection (MVP)**: Subjects and objects of `rdfs:subClassOf`, `owl:equivalentClass`, `owl:disjointWith` → `rdf:type owl:Class`. Objects of `rdfs:domain`, `rdfs:range` → `rdf:type owl:Class` (these positions are always class expressions in OWL 2 mapping). Subjects of `rdfs:domain`/`rdfs:range` are property positions — deferred.
- **Skip IRIs already declared**: If `(X, rdf:type, owl:Class)` already present in input — do not emit a duplicate. Build a set of already-declared class IRIs first.
- **Return new array, never mutate input**: The normalizer signature is `(quads: Quad[]) => Quad[]`. The caller in `ts/index.ts` passes the result to `encodeToBuffers()`.
- **Zero overhead when option is false**: Gate behind `if (opts?.normalizeDeclarations)` before calling the normalizer. No collection allocation on the default path.
- **DataFactory from n3**: Already imported in `ts/intern.ts`; import in `ts/normalize.ts` the same way.

## Open Questions

### Resolved During Planning

- *"Should normalizeDeclarations also apply to checkConsistency?"* — Yes. A user with undeclared classes trying `checkConsistency` faces the same 0-result silent failure.
- *"Should the option be on ReasoningOptions or a new NormalizationOptions type?"* — `ReasoningOptions` — no indirection needed for a single boolean.
- *"What about rdfs:subPropertyOf subjects/objects?"* — Deferred. Property kind (object vs data) is ambiguous without type context. MVP covers only class positions.
- *"Should the default be true or false?"* — False (opt-in). Silent declaration injection surprises OWL experts and changes semantics. Opt-in matches the principle of least surprise.

### Deferred to Implementation

- Exact IRI constant definitions (whether to inline as string literals or import from a constants module).
- Whether `classify(quads)` (deprecated overload) automatically gets the option — check if it passes opts through or hard-codes `{mode:'classify'}`.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
normalizeOwlDeclarations(quads: Quad[]): Quad[]
  given: quads = input from caller (may include rdfs:subClassOf, no rdf:type owl:Class)
  
  declared = Set of IRIs already typed as owl:Class in input
  candidates = Set of IRIs that need owl:Class declaration
  
  for each quad in quads:
    if quad.predicate ∈ CLASS_SUBJECT_PREDICATES:   // subClassOf, equivalentClass, disjointWith
      candidates.add(quad.subject.value)
      candidates.add(quad.object.value)
    if quad.predicate ∈ CLASS_OBJECT_PREDICATES:    // rdfs:domain, rdfs:range
      candidates.add(quad.object.value)
    if quad.predicate == rdf:type AND quad.object == owl:Class:
      declared.add(quad.subject.value)
  
  inject = candidates - declared
  return [...quads, ...inject.map(iri => quad(namedNode(iri), RDF_TYPE, OWL_CLASS, defaultGraph()))]
```

Decision matrix for predicates:

| Predicate | Subject position | Object position |
|-----------|-----------------|-----------------|
| `rdfs:subClassOf` | → `owl:Class` | → `owl:Class` |
| `owl:equivalentClass` | → `owl:Class` | → `owl:Class` |
| `owl:disjointWith` | → `owl:Class` | → `owl:Class` |
| `rdfs:domain` | (property — deferred) | → `owl:Class` |
| `rdfs:range` | (property — deferred) | → `owl:Class` |

## Implementation Units

- [ ] **Unit 1: Add `normalizeDeclarations` to `ReasoningOptions`**

**Goal:** Expose the new option in the public TypeScript API surface.

**Requirements:** R2, R4

**Dependencies:** None

**Files:**
- Modify: `ts/types.ts`

**Approach:**
- Add `normalizeDeclarations?: boolean` field to `ReasoningOptions` with a JSDoc comment explaining: when true, injects `rdf:type owl:Class` for all IRIs appearing in class positions (`rdfs:subClassOf`, `owl:equivalentClass`, `owl:disjointWith`, `rdfs:domain`/`rdfs:range` objects) before calling the reasoner. Default false.
- `StoreReasoningOptions` extends `ReasoningOptions` — inherits automatically.

**Test scenarios:**
- Test expectation: none — type-only change, verified by TypeScript compilation

**Verification:**
- `npm run build` exits clean; new field appears in generated `.d.ts`

---

- [ ] **Unit 2: Implement `normalizeOwlDeclarations` in `ts/normalize.ts`**

**Goal:** Pure function that takes a quad array and returns it augmented with any missing `rdf:type owl:Class` declarations.

**Requirements:** R1, R2, R5

**Dependencies:** Unit 1 (option type must exist to know what to implement)

**Files:**
- Create: `ts/normalize.ts`
- Create: `tests/unit/normalize.test.ts`

**Approach:**
- Single exported function: `normalizeOwlDeclarations(quads: Quad[]): Quad[]`
- Two-pass implementation: first pass collects already-declared class IRIs and candidate IRIs; second pass emits injection quads for candidates not already declared
- Injected quads use `DataFactory.defaultGraph()` as graph (matches existing convention in `ts/intern.ts`)
- Returns the original array unmodified when no injections needed (identity or spread with empty extras)
- Import `DataFactory` from `n3` (same pattern as `ts/intern.ts`)

**Patterns to follow:**
- `ts/intern.ts` — `DataFactory` import, `Quad` type usage, pure function style

**Test scenarios:**
- Happy path: 2 quads `A subClassOf B`, `B subClassOf C` → output includes `A rdf:type owl:Class`, `B rdf:type owl:Class`, `C rdf:type owl:Class` as additional quads; original 2 quads preserved
- Happy path: `owl:equivalentClass` and `owl:disjointWith` also trigger injection on both subject and object
- Happy path: `rdfs:domain` object gets `owl:Class`; `rdfs:range` object gets `owl:Class`
- Happy path: already-declared class IRI (`X rdf:type owl:Class` present) → no duplicate declaration emitted for X
- Happy path: quads with unrelated predicates (e.g. `rdf:type owl:Ontology`) pass through unchanged, no extra injection
- Edge case: empty input → returns `[]`
- Edge case: blank node as class position → injected as blank node `rdf:type owl:Class` (DataFactory.blankNode)
- Edge case: all class IRIs already declared → returns original array reference unchanged (or array equal to original)
- Edge case: `owl:Thing` and `owl:Nothing` appear as objects of `subClassOf` → injected (they are valid class IRIs)
- Integration: output fed to `encodeToBuffers()` produces a string table containing `http://www.w3.org/2002/07/owl#Class` and `http://www.w3.org/1999/02/22-rdf-syntax-ns#type`

**Verification:**
- `tests/unit/normalize.test.ts` passes under `npm test`

---

- [ ] **Unit 3: Thread `normalizeDeclarations` through `ts/index.ts`**

**Goal:** All public reasoning API paths apply normalization when the option is set.

**Requirements:** R1, R2, R4, R5, R6

**Dependencies:** Units 1, 2

**Files:**
- Modify: `ts/index.ts`

**Approach:**
- Import `normalizeOwlDeclarations` from `./normalize.js`
- In `_reasonOnStore`: after `store.getQuads(null, null, null, null)` collect, before `encodeToBuffers()`, gate: `const inputQuads = opts?.normalizeDeclarations ? normalizeOwlDeclarations(rawQuads) : rawQuads`
- In `_reasonOnQuads`: same gate before `encodeToBuffers(quads)`
- In `checkConsistency`: both the Store and quads overloads — same gate
- Check whether `classify(quads)` (deprecated overload) threads `opts` or hard-codes `{mode:'classify'}` and fix if needed so the option reaches `_reasonOnQuads`
- The Store passed to `reason(store)` is never modified — normalization result is a local variable only

**Patterns to follow:**
- `opts?.mode` usage in `_reasonOnQuads` (~line 220) — same null-safe access pattern for the new flag

**Test scenarios:**
- Happy path (Store path): `reason(store, { normalizeDeclarations: true })` with store containing only `A subClassOf B` (no owl:Class) → `loadTripleBuffer` receives string table containing `owl#Class` and `rdf-syntax-ns#type` IRIs (verified via `decodeStrTableEntries`)
- Happy path (quads path): `reason(quads, { normalizeDeclarations: true })` — same string-table check
- Happy path (checkConsistency): `checkConsistency(store, { normalizeDeclarations: true })` — string-table check
- Default off: `reason(store)` without option → string table does NOT contain `owl#Class` for an input with no explicit declarations (no injection by default)
- Non-mutation: caller's Store still contains only the original quads after `reason(store, { normalizeDeclarations: true })`
- Integration: end-to-end with real WASM — `reason(store, { normalizeDeclarations: true })` on store with bare `rdfs:subClassOf` quads returns non-empty inferred quads (requires WASM binary)

**Patterns to follow:**
- `decodeStrTableEntries` helper in `tests/unit/RdfReasoner.test.ts` lines 129–143 for string-table inspection tests
- `mockWorkerSequence` / `autoRespond` helpers for happy-path scaffolding

**Test scenarios:**
- (see above)

**Verification:**
- `npm test` passes with same or better counts; no new test failures

---

- [ ] **Unit 4: Integration test — end-to-end with real WASM**

**Goal:** Confirm that `normalizeDeclarations: true` produces real inferred quads from a minimal bare-subClassOf input, and that the default still returns 0.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1–3

**Files:**
- Modify: `tests/integration/pizza.test.ts` or create `tests/integration/normalize.test.ts`

**Approach:**
- Add a new describe block (or new test file) guarded by `wasmExists`
- Test: a Store with only `A rdfs:subClassOf B` + `B rdfs:subClassOf C` (no `rdf:type owl:Class`) + `reason(store, { normalizeDeclarations: true })` → inferred graph contains at least `A subClassOf B` and `B subClassOf C`
- Test: same input without option → 0 inferred quads (default unchanged)
- Test: pizza fixture (already has declarations) + `normalizeDeclarations: true` → same output as without option (no regression for well-formed input)

**Patterns to follow:**
- `tests/integration/pizza.test.ts` structure — `describe.skipIf(!wasmExists)`, `beforeAll` with `new RdfReasoner()`, `afterAll` with `reasoner.terminate()`

**Test scenarios:**
- Happy path: bare subClassOf → 0 without option, >0 with option
- Happy path: well-formed input (pizza) → same result with and without option
- Edge case: empty store + option enabled → 0 inferred quads, no error

**Verification:**
- `npm test` passes; new integration tests run and pass when WASM binary exists

## System-Wide Impact

- **Interaction graph:** `normalizeOwlDeclarations` is called in `_reasonOnStore`, `_reasonOnQuads`, and `checkConsistency`. No Worker, no WASM change.
- **Error propagation:** Normalizer is a pure function with no failure modes. No new error paths introduced.
- **State lifecycle risks:** None — normalizer works on a fresh array each call; no shared state.
- **API surface parity:** `reason(quads)` (deprecated overload) must also receive the option — verify the `classify(quads)` delegate path threads `opts` through.
- **Unchanged invariants:** Binary wire format, WASM API, and all existing test assertions are unchanged. The normalizer only adds quads to the input side; it does not affect output decoding.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Duplicate owl:Class injections if input already has declarations → extra triples sent to WASM | Normalizer first-pass collects already-declared IRIs; skip injection for those |
| `owl:Thing` / `owl:Nothing` injected unnecessarily (they are built-in) | Harmless — Konclude ignores redundant declarations; no functional impact |
| `classify(quads)` deprecated overload silently drops the option | Check implementation in Unit 3; fix the opts threading if needed |
| Blank node in class position injected as `_:x rdf:type owl:Class` | Correct OWL behaviour; blank node class expressions are anonymous classes |

## Sources & References

- OWL 2 Mapping to RDF Graphs §3.2 Table 9/16 — CE(x) guard requiring explicit class declarations
- Investigation 2026-05-19: owl.ttl + rdfs.ttl loading does not help; domain axiom present but mapper is syntactic
- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- GraphDB/OWLIM RDFS+OWL preprocessing shim pattern (standard in triple store ecosystem)
