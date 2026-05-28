---
title: "fix: owl:differentFrom and ABox assertions not reaching Konclude via WASM mapper (issue #13 case 5)"
type: fix
status: complete — all units implemented; consistencyOnly() reverted (full pipeline ≤300ms)
date: 2026-05-28
---

# fix: owl:differentFrom and ABox assertions not reaching Konclude via WASM mapper (issue #13 case 5)

## Overview

`owl:maxQualifiedCardinality` + `owl:differentFrom` violations (issue #13 case 5) are undetectable in
WASM because `owl:differentFrom` axioms are silently dropped by the mapper. Without
`DifferentIndividuals` axioms, the OWL tableau can assume `vinA = vinB`, making the cardinality
constraint satisfiable — so it returns consistent (wrong) or hangs in saturation.

The fix is a targeted C++ change to the mapper instance created in `loadTripleBuffer()`: enable
`mConfExtractSimpleABoxAssertions` so `buildSimpleABoxAxioms()` runs and registers
`differentFrom` (and other simple ABox axioms) into the ontology. A WASM rebuild is required.
A post-fix judgment step decides whether `consistencyOnly()` is still the right pipeline for
`checkConsistency()`.

## Problem Frame

`CConcreteOntologyRedlandTriplesDataExpressionMapper::mapTriples()` drives a fixed pipeline of
build steps. `buildSimpleABoxAxioms()` — the step that processes `owl:differentFrom`,
`owl:sameAs`, named-individual type assertions, and object property assertions — is gated on the
boolean flag `mConfExtractSimpleABoxAssertions` (default: `false`). The WASM path instantiates
the base class `CConcreteOntologyRedlandTriplesDataExpressionMapper` directly, which never sets
this flag to `true`. The subclass `CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper`
sets it to `true` in its constructor, but is not used in the WASM `loadTripleBuffer()` path.

Basic ABox data (type assertions, object property assertions) does reach Konclude for cases 1, 2,
and 6 via the pipeline's `OPSTRIPLESINDEXING` step
(`CRedlandStoredTriplesIndividualAssertionConvertionIndexer::indexABoxIndividuals()`). But
`owl:differentFrom` is handled **only** in `buildSimpleABoxAxioms()` — it is not present in the
indexer path. This asymmetry explains why cases 1/2/6 work (no differentFrom dependency) while
case 5 fails.

## Requirements Trace

- R1. `checkConsistency()` returns `false` for case 5 (maxQualifiedCardinality + differentFrom) matching native Konclude
- R2. `owl:differentFrom` assertions are correctly registered in Konclude's ontology model
- R3. No regression in existing consistency, classify, or materialize tests
- R4. ABox assertions are not duplicated (mapper path + indexer path do not double-insert)
- R5. `consistencyOnly()` pipeline is evaluated for necessity after the fix lands; outcome documented

## Scope Boundaries

- Fix `owl:differentFrom` extraction — the minimum change to unblock case 5
- Do not touch `owl:sameAs`, property assertions, or other ABox extraction beyond what is needed
- No changes to the pipeline step ordering or `WasmConfigProvider`
- Cases 3 and 4 (AsymmetricProperty, IrreflexiveProperty) are upstream limitations — out of scope

### Deferred to Separate Tasks

- `owl:sameAs` extraction: separate PR if needed after this fix is verified
- Possible duplication between mapper ABox and indexer ABox for other assertion types: defer unless
  a specific regression surfaces after enabling the flag

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` lines 583–590 — mapper instantiation and `mapTriples()` call
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp`
  lines 112–180 — `buildSimpleABoxAxioms()` implementation; line 602 header default `mConfExtractSimpleABoxAssertions = false`
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper.cpp`
  line 33 — sets `mConfExtractSimpleABoxAssertions = true`; this is the pattern to follow
- `tests/integration/issue13-owl-violations.test.ts` — case 5 is `it.todo`; case 6 PARITY
- `tests/integration/owl-dl-capabilities.test.ts` — exercises `someValuesFrom`, `minCardinality` (passing); regression baseline
- `ts/index.ts` `checkConsistency()` — currently calls `consistencyOnly` (minimal pipeline)
- `src/KoncludeReasoner.cpp` `consistencyOnly()` — minimal pipeline added in this session

### Institutional Learnings

- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — gap matrix showing case 5 as WASM_PORT_GAP; case 6 now PARITY; update after fix
- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` — stale-pointer guard pattern: test blank-node set membership against live `nodeToIris` index, not pointer validity; applies if blank-node restriction nodes appear in ABox output
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md` — `WasmConfigProvider` flags can gate two independent behaviors; audit before adding any new flag

### Key Technical Facts from Research

- **Blank nodes survive the JS→WASM boundary correctly.** `ts/intern.ts` encodes `BlankNode` with typeTag 1; C++ decodes via `librdf_new_node_from_blank_identifier`. No gap here.
- **Restriction discovery works.** `getOWLRestrictionInstanceNodesStream()` queries `(?, rdf:type, owl:Restriction)`. Case 6 (`allValuesFrom`) is PARITY, confirming the full restriction blank-node pipeline works for that path.
- **`buildSimpleABoxAxioms()` handles `owl:differentFrom` at line 144.** The ABox indexer (`indexABoxIndividuals`) does NOT handle differentFrom. This is the only path missing.
- **Potential duplication risk.** If `mConfExtractSimpleABoxAssertions = true` AND the `OPSTRIPLESINDEXING` indexer also runs, type assertions and object property assertions would be processed twice. The plan's diagnostic unit must verify whether double-insertion causes errors or is idempotent in Konclude.

## Key Technical Decisions

- **Setter approach over subclass approach**: Add a `setConfExtractSimpleABoxAssertions(bool)` public setter (or call via a protected-access workaround) on the existing mapper instance rather than switching to the Querying subclass. The Querying subclass has a wider responsibility surface (line 33 is not the only change it makes). A targeted setter limits blast radius.
- **Patch rather than override for the setter**: The setter is a one-line addition to the mapper header and is not a wholesale behavioral change — a patch is the correct mechanism per the project's "patch vs override" decision rule.
- **Minimal ABox scope**: Enable the flag for the WASM `loadTripleBuffer()` path only; leave the querying/inference path unchanged. The goal is to add `differentFrom` recognition, not to replicate the full querying mapper.
- **Deferred duplication audit**: If enabling `mConfExtractSimpleABoxAssertions` causes type/property assertion duplicates with the indexer, a follow-on fix can guard against double-insertion. This is intentionally deferred rather than pre-solved without data.

## Open Questions

### Resolved During Planning

- **Is blank node encoding the cause?** No — confirmed by research. Blank nodes encode correctly.
- **Why does case 6 work but not case 5?** Case 6 (`allValuesFrom + disjointWith`) requires no `differentFrom`; the type assertion and property assertion paths handled by the indexer are sufficient. Case 5 uniquely requires `DifferentIndividuals` which lives only in `buildSimpleABoxAxioms()`.
- **Does enabling the flag risk saturation hang?** With `differentFrom` properly registered, the cardinality clash should be detectable in `OPSCONSISTENCY` before saturation completes. The hang was caused by the tableau attempting to satisfy an unsatisfiable constraint with no ground to reject it. With the correct axiom, the clash is found quickly.

### Deferred to Implementation

- Whether double-insertion of type assertions (mapper + indexer) is idempotent or causes errors — verify in diagnostic unit before enabling the flag broadly.
- Whether `consistencyOnly()` (without `OPSCLASSCLASSIFY`) is sufficient for correct cardinality detection after the fix, or whether some additional pipeline step is needed.
- Exact API for the setter: check if `mConfExtractSimpleABoxAssertions` is already accessible or needs a patch; if the field is `private`, a one-line patch adding a public setter is the minimum change.

## Implementation Units

- [ ] **Unit 1: Diagnostic — verify differentFrom reaches (or doesn't reach) Konclude's ABox**

**Goal:** Confirm the root cause by adding temporary C++ debug logging that dumps which DifferentIndividuals axioms are registered in the ontology after `mapTriples()` and after the pipeline completes for a case-5 input.

**Requirements:** R1 (prerequisite for confident fix)

**Dependencies:** None

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (temporary diagnostic logging, removed in Unit 3)

**Approach:**
- After the `mapper->mapTriples()` call in `loadTripleBuffer()`, query `mImpl->mOntology->getABox()` for the `DifferentIndividuals` axiom list and log its size
- Also log the count of `owl:Restriction` nodes found by running a manual librdf query against the model for `(?, rdf:type, owl:Restriction)` to confirm the restriction blank node is present
- Use `fprintf(stderr, ...)` with a `{diag}` prefix so logs are visible but grepable
- Run with the case-5 Turtle from the integration test via a one-off Node.js script (no WASM rebuild needed if logging is added to the TypeScript/worker layer instead, but C++ logging requires rebuild)

**Execution note:** Add logging, rebuild, observe output before committing to the fix direction. Discard logging in the same session before committing.

**Test scenarios:**
- Test expectation: none — diagnostic artifact; no new test file

**Verification:**
- Log shows `DifferentIndividuals count = 0` before fix (confirms root cause)
- Log shows `owl:Restriction node count ≥ 1` (confirms restriction blank node is present)

---

- [ ] **Unit 2: Fix — enable `buildSimpleABoxAxioms()` for differentFrom extraction**

**Goal:** Set `mConfExtractSimpleABoxAssertions = true` on the mapper instance created in `loadTripleBuffer()` so `buildSimpleABoxAxioms()` registers `DifferentIndividuals` axioms into the ontology.

**Requirements:** R1, R2, R4

**Dependencies:** Unit 1 (diagnostic confirms root cause)

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.h` (add public setter; OR use a patch)
- Create: `patches/016-mapper-simple-abox-setter.patch` (if header is patched)
- Modify: `src/KoncludeReasoner.cpp` (call setter before `mapTriples()`)

**Approach:**
- Check whether `mConfExtractSimpleABoxAssertions` is already accessible (public or has a setter). If not, add a one-line setter via patch: `void setConfExtractSimpleABoxAssertions(bool v) { mConfExtractSimpleABoxAssertions = v; }` or simply mark the field `public` in the patch.
- In `src/KoncludeReasoner.cpp` inside `loadTripleBuffer()`, call the setter on the mapper instance before `mapper->mapTriples()`.
- Rebuild WASM and run the case-5 integration test.
- If double-insertion of type/property assertions causes issues (duplicate ABox entries), scope the setter call to only affect `DifferentIndividuals` by subclassing or using a narrower `setExtractDifferentIndividuals(bool)` setter.

**Patterns to follow:**
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper.cpp` line 33 — sets the same flag to `true`
- `patches/001-all-wasm-changes.patch` — example minimal patch format

**Test scenarios:**
- Happy path: case 5 Turtle → `checkConsistency()` returns `false` (inconsistent), matching native verdict
- Regression: existing consistency.test.ts cases (cases 1–4, roberts-family) — no change in results
- Regression: `owl-dl-capabilities.test.ts` — `someValuesFrom`, `minCardinality` tests unaffected
- Edge case: empty `differentFrom` list (ontology with no `owl:differentFrom`) — no crash, no change in ABox output
- Integration: case 5 + case 6 in the same `RdfReasoner` session (sequential calls) — both return correct verdict

**Verification:**
- `npm test` passes: 154+ tests pass, case 5 `it.todo` removed (or converted to passing test)
- No timeout on case 5 within 30 s

---

- [ ] **Unit 3: Activate case 5 integration test and update gap doc**

**Goal:** Remove the `it.todo` on case 5, make it a live test, and update the gap classification doc.

**Requirements:** R1, R3

**Dependencies:** Unit 2 (fix verified)

**Files:**
- Modify: `tests/integration/issue13-owl-violations.test.ts`
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`

**Approach:**
- In `issue13-owl-violations.test.ts`, replace the `it.todo` for case 5 with a full `it(...)` test following the same pattern as cases 1, 2, 6.
- Update the block comment at the top of the test file: change case 5 from `WASM_PORT_GAP` to `PARITY`.
- In the gap doc, update the case 5 row from `WASM_PORT_GAP` to `PARITY` and add a brief `Resolution:` note citing the `mConfExtractSimpleABoxAssertions` fix and the plan file.

**Test scenarios:**
- Test expectation: test file changes are verified by `npm test` passing with 155+ tests

**Verification:**
- `npm test` shows case 5 test passing (not todo)
- Gap doc case 5 row updated

---

- [ ] **Unit 4: Judgment step — evaluate whether `consistencyOnly()` is still needed**

**Goal:** After the fix, determine whether the original `classification()` pipeline (full TBox + saturation + KPSet classify) now also completes within 30 s for cases 5 and 6, or whether `consistencyOnly()` remains necessary for performance.

**Requirements:** R5

**Dependencies:** Unit 2

**Files:**
- Modify: `ts/index.ts` (revert `checkConsistency` to use `classification` + `consistency` if performance is acceptable)
- Modify: `src/KoncludeReasoner.cpp` (remove `consistencyOnly()` if judgment says revert)
- Modify: `src/KoncludeReasoner.h` (remove declaration if reverting)
- Modify: `src/bindings.cpp` (remove binding if reverting)
- Modify: `ts/worker.ts` (remove case if reverting)
- Modify: `ts/konclude.d.mts` (remove from type if reverting)
- Modify: `tests/unit/RdfReasoner.test.ts` (revert mock expectations if reverting)
- Modify: `tests/unit/RdfReasoner.store.test.ts` (revert mock expectations if reverting)

**Approach:**
- Time `checkConsistency()` on cases 5 and 6 using the full classification pipeline (temporarily change `checkConsistency` back to `classification + consistency`).
- Decision criteria:
  - If full pipeline completes ≤ 10 s for both cases: revert to `classification + consistency`. Remove `consistencyOnly()` entirely (it was an intermediate workaround).
  - If full pipeline takes 10–30 s: keep `consistencyOnly()` for performance but document the tradeoff.
  - If full pipeline still times out (> 30 s): keep `consistencyOnly()` as the permanent approach and update the docstring.
- The judgment outcome must be documented in a comment in `ts/index.ts` and in this plan file (update the `status` frontmatter field with a note).

**Test scenarios:**
- Timing test: run case 5 and case 6 with full pipeline 3× each, record median time
- If reverting: `npm test` must pass with the old `classification + consistency` pipeline

**Verification:**
- A documented decision with timing data exists (code comment or plan update)
- `npm test` passes regardless of which pipeline is chosen

---

## System-Wide Impact

- **Affected surface:** `checkConsistency()` only — `classify()`, `materialize()`, `classifyProperties()` are unaffected
- **Potential ABox duplication:** `buildSimpleABoxAxioms()` (mapper) + `indexABoxIndividuals` (pipeline indexer) could register the same type/property assertions twice. Konclude's internal OntologyBuilder may tolerate duplicates idempotently (same-IRI deduplication), but this must be verified empirically in Unit 1 diagnostic.
- **Unchanged invariants:** The NTriples wire format, the binary buffer protocol, the TS public API surface (`RdfReasoner`) — none change.
- **WASM rebuild required:** Any C++ change to `KoncludeReasoner.cpp` or a new patch requires `make build-wasm` + `npm run patch-wasm`. Incremental via ccache (~5 min).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Double-insertion of ABox assertions causes wrong output | Diagnose in Unit 1; if duplicates cause errors, scope the setter to `differentFrom` only |
| `consistencyOnly()` + `mConfExtractSimpleABoxAssertions=true` still hangs for some ontology | Unit 4 judgment step captures this; full pipeline revert is always available |
| Patch conflicts with future upstream Konclude update | Patch is one line (setter); minimal context lines means low conflict probability |
| `buildSimpleABoxAxioms()` processes more than `differentFrom` and causes unexpected ABox changes in existing tests | Unit 2 runs full regression (`npm test`) before committing |

## Sources & References

- Issue: [ontosphere #13](https://github.com/ThHanke/ontosphere/issues/13) — violation test cases
- Plan: `docs/plans/2026-05-28-025-feat-native-vs-wasm-capability-comparison-plan.md` — gap matrix origin
- Gap doc: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Mapper: `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp`
- Querying subclass (pattern): `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper.cpp`
- Learnings: `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
- Learnings: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
