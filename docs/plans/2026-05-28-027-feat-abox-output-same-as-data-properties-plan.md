---
title: "feat: emit owl:sameAs entailments and data property assertions from materialize()"
type: feat
status: complete
date: 2026-05-28
---

# feat: emit owl:sameAs entailments and data property assertions from materialize()

## Overview

`materialize(store)` currently emits `rdf:type` entailments and object property assertions.
Two ABox output types are computed by Konclude but never surfaced: `owl:sameAs` equivalence
entailments and data property assertions (`individual dataProperty "value"^^datatype`). Both fold
into the existing `buildInferredTripleBuffer()` C++ function using the same visitor/buffer pattern
already established for `rdf:type` and object properties. A single WASM rebuild is required.

## Problem Frame

From the README "Known output gaps" table: users who load an ontology with sameAs-merged
individuals or data property assertions into `materialize()` receive incomplete ABox output.
`owl:sameAs` is computable from `CSameRealization`; data property assertions are pass-through
echoes of asserted input (Konclude does not infer new data property values, so pass-through
IS the complete answer). The gaps exist because the corresponding visitor calls were never
wired up in `buildInferredTripleBuffer()`.

## Requirements Trace

- R1. `materialize(store)` emits `owl:sameAs` pairs for all Konclude-merged individuals
- R2. `materialize(store)` emits asserted data property triples `(s, p, literal)` for all
  named individuals
- R3. No regression in existing `rdf:type`, object property, or TBox classification output
- R4. README "Known output gaps" table updated to reflect closed gaps
- R5. Both new triple types always emitted (consistent with existing `rdf:type` behaviour);
  no new opt-in options required

## Scope Boundaries

- Emit `owl:sameAs` pairs from realization output; do NOT emit `owl:differentFrom` entailments
  (Konclude has no output model for differentness — it uses differentFrom as a constraint, not
  a computable output set)
- Echo asserted data property triples; do NOT attempt to infer new data property values
  (Konclude SROIQ(D) does not materialise new data fillers; pass-through is complete)
- `owl:AllDifferent` entailments: out of scope
- Inferred data property values via datatype reasoning: out of scope

### Deferred to Separate Tasks

- Investigating whether `owl:sameAs` output can be computed from `CSameRealization` for
  non-realised TBox-only ontologies (no individuals): deferred; `hasPotentiallySameIndividuals()`
  guard handles the empty case

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` lines 808–1128: current TBox +
  ABox emission; visitor pattern uses anonymous `struct FooVisitor : CXxxVisitor` capturing
  `&intern`, `&tripleIds`, `&emittedTriples` by ref; `emitTriple(sId, pId, oId)` deduplicates
  via `emittedTriples` unordered_set
- `vendor/konclude/Source/Reasoner/Realization/CRealization.h` — `getSameRealization()` getter
  (not yet called in `buildInferredTripleBuffer()`)
- `vendor/konclude/Source/Reasoner/Realization/CSameRealization.h` —
  `visitSameIndividuals(CRealizationIndividualInstanceItemReference, CSameRealizationIndividualVisitor*)`;
  convenience overload `visitSameIndividuals(CIndividual*, visitor*)` available;
  `hasPotentiallySameIndividuals()` for fast-path guard
- `vendor/konclude/Source/Reasoner/Realization/CSameRealizationIndividualVisitor.h` —
  `visitIndividual(const CIndividualReference& indiRef, CSameRealization*)`: **indiRef.getIndividual()
  returns nullptr**; only `indiRef.getIndividualID()` is valid; resolve IRI via
  `mOntology->getABox()->getIndividualVector(false)->getData(indiRef.getIndividualID())`
- `vendor/konclude/Source/Reasoner/Ontology/COntologyTriplesAssertionsAccessor.h` —
  `visitIndividualAssertions(...)` with `COntologyTriplesIndividualAssertionsVisitor` implementing
  `visitDataAssertion(CRole* role, CDataLiteral* dataLiteral, ...)` — reads from the asserted
  triple store
- `vendor/konclude/Source/Reasoner/Ontology/CDataLiteral.h` —
  `getLexicalDataLiteralValueString()` → lexical value;
  `getDatatype()->getDatatypeIRI()` → XSD datatype IRI
- `ts/intern.ts` `decodeBuffers()` — literal encoding already supported: type tag 2,
  string entry `"value\0datatype\0language"` → `DataFactory.literal(value, namedNode(datatype))`
- `ts/index.ts` `_materializeOnQuads` / `_materializeOnStore` — TS-side filter only strips
  `rdfs:subClassOf` and `owl:equivalentClass`; `owl:sameAs` and data property predicates flow
  through automatically without TS changes

### Institutional Learnings

- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
  — stale-pointer guard pattern: guard every `parentNodeSet` pointer with `nodeToIris.count(parentNode)`
  check; use `CConcept::getConceptTag()` for canonical representative; the `emittedTriples` set
  deduplicates across all triple types in the same buffer pass
- `docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md` —
  input mapping vs output emission are separate concerns; enabling a flag for ABox input does
  not give output; dual-effect flag audit required when enabling new config flags
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
  — WasmConfigProvider flag dual-effect pattern; audit before adding any new config flag

## Key Technical Decisions

- **Fold both into `buildInferredTripleBuffer()`** rather than adding separate buffer methods:
  `owl:sameAs` and data properties belong to the ABox output that `materialize()` already owns;
  a separate buffer/command (like `buildPropertyTripleBuffer`) would require new TS API surface
  with no user benefit. The existing deduplication set handles all types uniformly.

- **owl:sameAs pair emission strategy**: Call `visitSameIndividuals()` for each individual in
  the per-individual realization loop; accumulate all IRIs in the same-group callback; emit
  all ordered pairs `(a, owl:sameAs, b)` where `a < b` (IRI lexicographic order) to emit
  each pair exactly once. The `emittedTriples` set provides a correctness backstop regardless
  of which strategy the implementer chooses. Gate the entire block with
  `sameReal->hasPotentiallySameIndividuals()`.

- **Data property path via `COntologyTriplesAssertionsAccessor`**: `CRoleRealization::visitSourceIndividualRoles()`
  explicitly guards `!role->isDataRole()` in the KPSet realizer — data roles never reach
  the existing role visitor. `getRoleDataInstancesIterator()` yields subject individuals
  only (no literal values). The only viable path is `COntologyTriplesAssertionsAccessor`,
  which reads asserted data properties from the loaded triple store. This is correct and
  complete because Konclude does not infer new data property values.

- **Always-on output**: Both new triple types emit unconditionally like `rdf:type` and object
  property assertions. No new `MaterializeOptions` fields needed. This is a minor additive
  change to `materialize()` output.

- **Single WASM rebuild**: Both C++ changes are in `src/KoncludeReasoner.cpp` only. Batch
  into one `docker compose run --rm build` to minimise rebuild time.

## Open Questions

### Resolved During Planning

- **Is there a visitor path for data property literals on `CRoleRealization`?** No — confirmed
  by research. `visitSourceIndividualRoles()` has an explicit `!isDataRole()` guard. Use
  `COntologyTriplesAssertionsAccessor` instead.
- **Does `decodeBuffers()` support literals?** Yes — type tag 2 with `"value\0datatype\0language"`
  format is already implemented in `ts/intern.ts`.
- **Should `owl:sameAs` be opt-in?** No — consistent with existing ABox output behaviour.

### Deferred to Implementation

- Exact method signature and include path for `COntologyTriplesAssertionsAccessor`: confirm
  whether it is accessible from `mImpl->mOntology->getOntologyTriplesData()->getAssertionsAccessor()`
  or similar. If the accessor is unavailable post-reasoning (triples may be consumed), fall
  back to iterating the librdf model directly for data property patterns.
- Whether `visitSameIndividuals` for each individual in the loop is efficient enough, or
  whether a separate outer pass over the sameAs graph is needed to avoid redundant group
  traversal. The `emittedTriples` set ensures correctness either way; efficiency is an
  implementation concern.
- Whether `CRoleRealizationInstantiatedVisitor` can be reused for data properties if the
  `isDataRole()` guard is bypassed in the WASM layer rather than in the vendor code. Prefer
  `COntologyTriplesAssertionsAccessor` unless that path proves inaccessible.

## Implementation Units

- [x] **Unit 1: C++ — owl:sameAs visitor in buildInferredTripleBuffer()**

**Goal:** Emit `owl:sameAs` pairs for all Konclude-merged individual equivalence classes.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Test: `tests/unit/RdfReasoner.materialize.test.ts`
- Test: `tests/integration/abox-realization.test.ts`

**Approach:**
- In `buildInferredTripleBuffer()`, inside the `mImpl->mRealized` block, obtain
  `CSameRealization* sameReal = real->getSameRealization()`
- Gate the entire block on `sameReal && sameReal->hasPotentiallySameIndividuals()`
- For each individual `indiRef` in the existing per-individual loop (or a dedicated outer loop),
  call `sameReal->visitSameIndividuals(indiRef, &sameVisitor)`
- The visitor receives all members of the same-individual group including the source;
  `indiRef.getIndividual()` is nullptr — resolve IRI via
  `mOntology->getABox()->getIndividualVector(false)->getData(indiRef.getIndividualID())`
- Collect all IRIs in the group; emit `(a, owl:sameAs, b)` for all ordered pairs
  where `a < b` (or rely on `emittedTriples` for deduplication)
- `owl:sameAs` predicate IRI: `"http://www.w3.org/2002/07/owl#sameAs"`

**Patterns to follow:**
- Existing `struct RoleInstVisitor` / `struct RoleInstItemVisitor` anonymous struct pattern
  in `buildInferredTripleBuffer()` (lines 984–1086)
- `emittedTriples` deduplication: `emittedTriples.insert({sId, pId, oId})` returns false if
  already present — use as early-exit guard before `tripleIds.push_back`

**Test scenarios:**
- Happy path: ontology with `owl:sameAs :alice :bob` → `materialize()` returns
  `(:alice, owl:sameAs, :bob)` and `(:bob, owl:sameAs, :alice)` (or canonical pair only)
- Happy path: ontology with no sameAs merges → no `owl:sameAs` triples in output; no crash
- Happy path: `owl:sameAs` triples appear alongside `rdf:type` triples in same result
- Edge case: three individuals merged in one sameAs group → all three cross-pairs emitted
- Edge case: ontology with only TBox axioms (no individuals) → no `owl:sameAs` output, no crash
- Regression: existing `rdf:type` and object property assertion output unchanged

**Verification:**
- Unit tests pass with mock binary buffer containing `owl:sameAs` predicate IDs
- Integration test on WASM with a minimal two-individual sameAs ontology returns the expected pair
- `npm test` 156+ tests pass

---

- [x] **Unit 2: C++ — data property assertions via COntologyTriplesAssertionsAccessor**

**Goal:** Emit `(individual, dataProperty, literal)` triples for all asserted data properties
on named individuals.

**Requirements:** R2, R3

**Dependencies:** Unit 1 (batched rebuild; can be implemented before Unit 1 if more convenient)

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Test: `tests/unit/RdfReasoner.materialize.test.ts`
- Test: `tests/integration/abox-realization.test.ts`

**Approach:**
- Confirm `COntologyTriplesAssertionsAccessor` is reachable: check
  `mImpl->mOntology->getOntologyTriplesData()` or `getOntology()` for an accessor getter;
  fall back to iterating the librdf model directly if the post-reasoning accessor is unavailable
- Implement `COntologyTriplesIndividualAssertionsVisitor::visitDataAssertion(role, dataLiteral, ...)`
  to extract predicate IRI from `role->getPropertyNameLinker()` / `CIRIName::getRecentIRIName()`
  and literal value from `dataLiteral->getLexicalDataLiteralValueString()` and
  `dataLiteral->getDatatype()->getDatatypeIRI()`
- Encode literal in InternTable with type tag 2: `"value\0datatype\0language"` format
  (language = empty string for datatype literals)
- Call `emitTriple(subjectId, predicateId, literalId)` via the shared buffer mechanism
- Include: `COntologyTriplesAssertionsAccessor.h`, `COntologyTriplesIndividualAssertionsVisitor.h`,
  `CDataLiteral.h`, `CDatatype.h`

**Patterns to follow:**
- Literal InternTable encoding: look for any existing literal `intern.internLiteral()` or
  similar helper in `buildInferredTripleBuffer()`; if absent, model on the C++ `InternTable`
  class (type tag 2, `"value\0datatype\0language"` format matching `decodeBuffers()`)
- Role IRI resolution: follow the object-property role IRI pattern in `buildInferredTripleBuffer()`
  lines ~1010–1040

**Test scenarios:**
- Happy path: ontology with `alice :age "30"^^xsd:integer` → `materialize()` returns
  `(:alice, :age, "30"^^xsd:integer)`
- Happy path: multiple data properties on same individual → all emitted
- Happy path: data property with language tag (if applicable) → correct language preserved
- Edge case: individual with no data properties → no data property triples; no crash
- Edge case: ontology with only TBox axioms → no data property output
- Edge case: datatype IRI is not a standard XSD type → literal emitted with that IRI
- Regression: `rdf:type`, object property, and `owl:sameAs` output unchanged

**Verification:**
- Integration test on WASM with a minimal ontology including `alice :age "30"^^xsd:integer`
  returns the expected literal triple
- Literal decoded by `decodeBuffers()` matches `DataFactory.literal("30", DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#integer"))`
- `npm test` 156+ tests pass

---

- [x] **Unit 3: WASM rebuild + integration baseline + docs update**

**Goal:** Rebuild WASM to include both new features; update README and integration test baseline.

**Requirements:** R3, R4, R5

**Dependencies:** Units 1 and 2 complete

**Files:**
- Rebuild: `dist/konclude.wasm`, `dist/konclude.mjs` (via `docker compose run --rm build` + `npm run patch-wasm`)
- Modify: `README.md` — update "Known output gaps" table
- Modify: `tests/integration/abox-realization.test.ts` — add owl:sameAs and data property cases
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — if relevant
  to the output capability classification

**Approach:**
- After WASM rebuild and `npm run patch-wasm && npm run build`, run `npm test` to confirm no regressions
- Update the "Known output gaps" section in `README.md`: remove `owl:sameAs` and data property
  assertion rows, or mark them as supported
- Add a concrete integration test for each new feature to `tests/integration/abox-realization.test.ts`
  following the existing `describe.skipIf(!wasmExists)` pattern

**Test scenarios:**
- Full test suite (`npm test`) passes with 156+ tests; no regressions in consistency,
  classify, materialize, or classifyProperties
- `owl:sameAs` integration test: two individuals declared `owl:sameAs` → pair in output
- Data property integration test: one individual with one typed literal → triple in output
- Smoke test: `docker compose run --rm smoke-test` passes

**Verification:**
- `npm test` reports all tests passing; new integration tests are not `it.todo`
- README "Known output gaps" table no longer lists `owl:sameAs` and data property assertions

## System-Wide Impact

- **Affected surface:** `materialize()` only — `classify()`, `classifyProperties()`, and
  `checkConsistency()` are unaffected
- **Output expansion:** `materialize()` will return more triples for ontologies with sameAs
  merges or data properties. This is additive; existing predicate-specific consumers are
  unaffected unless they assumed exhaustive output
- **Wire format unchanged:** `buildInferredTripleBuffer()` appends to the same combined buffer;
  no changes to the binary protocol or `decodeBuffers()`
- **TS filter unchanged:** The `rdfs:subClassOf`/`owl:equivalentClass` filter in `_materializeOnQuads`
  does not need updating; neither new predicate is in the filter
- **Unchanged invariants:** `classify()` and `classifyProperties()` do not call
  `buildInferredTripleBuffer()` — they use a separate TBox output path. ABox additions here
  do not affect TBox-only output

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `COntologyTriplesAssertionsAccessor` not accessible post-reasoning | Fall back to iterating the librdf model for `(s, p, o)` where `p` is a data property IRI; data properties were loaded via `mapTriples()` and remain in the model |
| `visitSameIndividuals` includes source individual, causing self-referential `owl:sameAs` pairs | Skip pair emission when both IRIs are identical; `emittedTriples` deduplication also prevents `(a, sameAs, a)` insertion |
| Data property literal encoding mismatch with `decodeBuffers()` | Verify the `"value\0datatype\0language"` format against `ts/intern.ts` lines 162–175 before C++ implementation; write a unit test with known literal value before running integration test |
| WASM rebuild breaks existing tests due to buffer size or alignment changes | `buildInferredTripleBuffer()` uses a dynamic buffer (vector); no alignment impact; any test failures indicate logic errors, not ABI issues |

## Sources & References

- ABox realization gap memory: `project_missing_konclude_components.md` (items 3 and 2)
- `CSameRealization` API: `vendor/konclude/Source/Reasoner/Realization/CSameRealization.h`
- `COntologyTriplesAssertionsAccessor`: `vendor/konclude/Source/Reasoner/Ontology/COntologyTriplesAssertionsAccessor.h`
- `CDataLiteral`: `vendor/konclude/Source/Reasoner/Ontology/CDataLiteral.h`
- Existing output pattern: `src/KoncludeReasoner.cpp` lines 808–1128
- Over-materialization guard pattern: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- Binary decode: `ts/intern.ts` lines 103–175
