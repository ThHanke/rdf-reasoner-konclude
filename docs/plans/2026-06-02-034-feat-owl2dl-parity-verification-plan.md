---
title: "feat: OWL 2 DL parity verification and gap closure"
type: feat
status: in-progress
date: 2026-06-02
session_cutoff: 2026-06-02
---

## Session State (2026-06-02 — continue in next session)

**Test count at cutoff:** 211 passing, 4 failing, 1 skipped (total 216)

### Completed
- Unit 1 ✅ — Mapper flag audit: no flags missing. Doc at `docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md`
- Unit 2 ✅ — property-characteristics.test.ts: SymmetricProperty, inverseOf, hasValue, domain, range all PARITY. FunctionalProperty skipped (UPSTREAM_LIMITATION: ALIF+ hang)
- Unit 3 ✅ — Cases 7–12 added to issue13-owl-violations.test.ts. Cases 7–9, 11 PARITY. Case 10 UPSTREAM_LIMITATION. Case 12 pending (see below)
- Unit 5 ✅ — Cases 13–14 (datatype restriction) added and verified PARITY

### Patch 025 — NegativePropertyAssertion filter fix
- Bug found: filter statement variable assignments scrambled in `CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp` lines 2441–2444
- Patch created: `patches/025-negative-prop-assertion-filter-fix.patch`
- Patch infrastructure fixed: deleted redundant `patches/001-qt-compat-header.patch` (was conflicting with `001-all-wasm-changes.patch` which is baked into vendor submodule)
- WASM rebuilt WITH patch 025 applied
- **STILL FAILING**: Case 12 test fails (86ms — not a timeout). Patch 025 applied correctly but test still shows WASM returning consistent. Root cause unknown — next session must investigate

### Pending failures (4 tests)

1. **Case 12** (issue13-owl-violations.test.ts): NegativeObjectPropertyAssertion. Patch 025 applied; WASM still returns consistent. Investigate: is the Turtle encoding correctly parsed? The blank-node RDF structure for `owl:NegativePropertyAssertion` in Turtle may not match what `getOWLAllNegativePropertyAssertionInstanceNodesStream()` expects. Check what the n3 parser produces for the Turtle blank node structure.

2. **Unit 4 test: AllDisjointClasses ABox** — 5s timeout. NTriples blank-node RDF list for `owl:AllDisjointClasses` causes WASM to hang during `materialize()`. Likely: the blank node list encoding doesn't work in NTriples format for this construct. Mitigation: use Turtle format or skip test (mark as known behavior note).

3. **Unit 4 test: disjointUnionOf ABox** — 5s timeout. Same root cause as above. Blank node RDF list in NTriples hangs WASM.

4. **Unit 4 test: NegativePropertyAssertion in consistent ontology** — 5s timeout. Blank node NTriples for `owl:NegativePropertyAssertion` hangs WASM materialize (same as case 12 issue but for materialize path).

### Investigation guide for next session

**Case 12 / NPA tests**: The Turtle ONTOLOGIES[12] uses `owl:NegativePropertyAssertion` blank node. After patch 025 fixes the filter statements, verify:
```bash
# Check what the n3 parser produces for the Turtle
# Specifically: does it produce rdf:type owl:NegativePropertyAssertion on the blank node?
# Check: grep OWL_ALL_NEGATIVE_PROPERTY_ASSERTION in mapper
```

The `getOWLAllNegativePropertyAssertionInstanceNodesStream()` searches for `rdf:type owl:NegativePropertyAssertion`. But the Turtle parser might produce `owl:NegativePropertyAssertion` as the type. Check the exact IRI used.

**Hang tests**: Use `parseTurtle()` instead of `parseNTriples()` for Unit 4 tests that use blank node lists. The Turtle format works for case 9 and case 11 in the consistency tests, so it should work for the ABox tests too.

### Unit 6 not started
Update `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` with all findings from this session.

# feat: OWL 2 DL parity verification and gap closure

## Overview

The WASM port passes overall TBox parity tests against native Konclude, but eleven OWL 2 DL
axiom types are either unverified (present in fixtures, no targeted test) or have zero
fixture coverage. Before building the API parity layer (plan-033), every OWL 2 DL construct
that Konclude supports must have a targeted native-comparison test, and any mapper flag gaps
must be closed. This plan covers that verification and closure work.

## Problem Frame

The Roberts TBox parity test (`assertExactMatch` against `roberts-native-tbox.nt`) passes,
which proves the combined output of all 405 individuals and the full TBox is correct. It
does NOT prove that each property characteristic (SymmetricProperty, FunctionalProperty,
`inverseOf`, `hasValue`) produces the right ABox entailments individually, because a count
match can hide compensating errors. The zero-coverage constructs (ReflexiveProperty,
AllDisjointClasses, NegativePropertyAssertion, etc.) have no ground truth at all.

Undetected mapper flag gaps (like the `mConfExtractSimpleABoxAssertions` issue fixed in
plan-028) could silently drop entire axiom categories. Those must be audited before writing
any new tests so we do not test a broken mapper and record wrong verdicts.

## Requirements Trace

- R1. Every unverified OWL 2 DL axiom type has a targeted minimal fixture and a native-comparison integration test.
- R2. Every zero-coverage construct has a minimal fixture, a native verdict, and an integration test verifying our output matches native (or documents a confirmed upstream limitation).
- R3. All `buildXxx()` mapper methods relevant to the gap list are confirmed enabled or patched to be enabled before any test is recorded.
- R4. No new mapper flags are enabled without a regression run over the full existing test suite.
- R5. Upstream limitations (AsymmetricProperty, IrreflexiveProperty, and any newly confirmed) are documented in `docs/solutions/capability-gaps/` with native evidence.
- R6. `npm test` passes 199+N tests after each unit (N = new tests added).

## Scope Boundaries

- No SPARQL query support — separate initiative.
- No datatype inference chains — only datatype restriction consistency checking (e.g., `owl:minExclusive` in a class expression), not entailed data property value propagation.
- No OWL 2 Full or OWL 2 RL — Konclude is OWL 2 DL; metamodelling and rules are out of scope.
- No output changes for confirmed upstream limitations — document only, do not patch Konclude kernel.

### Deferred to Separate Tasks

- `owl:equivalentProperty` entailment output — plan-033 Unit 1 gap matrix will classify this.
- `owl:differentFrom` entailment output — explicitly deferred in plan-032 scope.
- Inverse property direction in output buffer — plan-033 Unit 6.

## Context & Research

### Relevant Code and Patterns

- `tests/integration/issue13-owl-violations.test.ts` — canonical pattern: WASM guard, inline OWL/XML fixture, pre-recorded JSON verdict from `tests/fixtures/issue13-native-verdicts.json`, assert agreement with native
- `tests/integration/abox-realization.test.ts` — ABox materialize pattern: inline NTriples fixture, `parseNTriples()`, `materialize(quads)`, assert specific inferred triples
- `tests/helpers/compare-native.ts` — `assertExactMatch(wasm, fixtureFile, predicates)` and `assertMatchExcluding()` for NTriples golden-file comparison
- `tests/helpers/fixture.ts` — `loadFixture(name)` for reading `tests/fixtures/*.nt`
- `scripts/run-native-issue13.sh` — runs native binary for consistency verdicts; output committed to `tests/fixtures/issue13-native-verdicts.json`
- `src/KoncludeReasoner.cpp` `loadTripleBuffer()` — where mapper flags are set before `mapTriples()`; the `setConfExtractSimpleABoxAssertions(true)` call is already present (plan-028)
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp` — all `buildXxx()` methods; cross-reference constructor of `CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper` to find flags that are `true` in the querying subclass but `false` by default in the base class
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — existing gap matrix for AsymmetricProperty and IrreflexiveProperty; this plan extends it

### Institutional Learnings

- **Mapper flag gaps** (`docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md`): every `buildXxx()` method on the mapper base class is a potential silent-drop risk. Audit `buildNegativePropertyAssertions()`, `buildDisjointUnion()`, and AllDisjointClasses paths before trusting any test result for those axiom types.
- **Native verdict before WASM diagnosis** (`docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`): classify AsymmetricProperty and IrreflexiveProperty as UPSTREAM_LIMITATION only after confirming native also fails. Apply same methodology to every new construct.
- **Mapper class detection requires explicit `rdf:type owl:Class`** (project memory): for domain/range ABox inference to fire, domain and range classes must appear as `?x rdf:type owl:Class` in the fixture. Bare `rdfs:domain`/`rdfs:range` without class declarations produce 0 inferred triples.
- **`hasValue` + subrole fixed** (commit 0c86d54, May 2026): the "7 missing *OfRobert" bug is resolved. A targeted hasValue test is still needed to confirm and guard against regression.
- **sameAs isolation** (`docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`): FunctionalProperty and InverseFunctionalProperty entailments can produce `owl:sameAs`. Write those tests against a fresh `RdfReasoner` instance, not one shared with prior object-property-assertion calls (n=3 corruption risk).
- **subClassOf over-materialization pattern** (`docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`): disjointUnionOf and AllDisjointClasses introduce new hierarchy constraints; any new equivalences they create are handled by the existing CHierarchyNode iteration — no code change required unless the mapper silently drops them.

## Key Technical Decisions

- **Mapper flag audit is Unit 1 and must complete before any other unit.** If mapper flags are missing, recorded test verdicts will be wrong. A WASM rebuild in Unit 1 (if flags need enabling) propagates to all subsequent units automatically.

- **Consistency tests use the existing issue13 JSON pattern.** New consistency cases extend `tests/fixtures/issue13-native-verdicts.json` and `tests/integration/issue13-owl-violations.test.ts`. OWL/XML input format is used for native runs (Konclude CLI reads OWL/XML). NTriples is used for WASM input.

- **ABox inference tests use inline NTriples fixtures** rather than committed golden files. The constructs under test are simple enough (2-5 individuals, 1-3 properties) that inline assertions are more readable and maintainable than golden file diffs.

- **Property-characteristic ABox entailments are tested via `materialize(quads)`**, not `classify()`. SymmetricProperty, FunctionalProperty, inverseOf, domain/range, and ReflexiveProperty all affect the ABox realization output. The TBox-only `classify()` output (subClassOf/equivalentClass) is already verified by the existing parity tests.

- **Zero-coverage constructs are tested for consistency first, inference second.** Consistency is the simpler signal: an inconsistent ontology returns `false` from `checkConsistency()`. ABox inference output (specific entailed triples) is tested only when the construct has meaningful inference output beyond a boolean verdict.

- **Upstream limitations are documented with native evidence, not patched.** For any construct where both native and WASM produce the same (wrong) answer, classify as UPSTREAM_LIMITATION in the capability gap document and do not attempt a fix.

## Open Questions

### Resolved During Planning

- **Is `hasValue` fixed?** Yes — commit 0c86d54 resolves "7 missing *OfRobert". A regression test is still needed (Unit 2).
- **Does `buildSimpleABoxAxioms()` cover NegativePropertyAssertion?** Unclear — the method name suggests it handles simple ABox axioms, but NegativePropertyAssertion may be in a separate `buildNegativePropertyAssertions()` that is flag-gated. Must verify in Unit 1.
- **Does AllDisjointClasses use a separate mapper method?** Unknown — the mapper's AllDisjointClasses path must be traced in Unit 1.
- **Is FunctionalProperty checked as a consistency constraint or as an entailment trigger?** Both: a property being functional can trigger `sameAs` merging (entailment) AND inconsistency (if two different individuals are forced to be same but declared different). Unit 3 tests both.

### Deferred to Implementation

- Exact OWL/XML encoding for new issue13 cases — depends on which constructs need consistency testing; implementer writes minimal OWL/XML following the existing issue13 case files.
- Whether `buildDisjointUnion()` in the mapper is flag-gated — discovered in Unit 1 by reading the mapper source.
- Whether datatype restriction consistency (Unit 5) requires any mapper changes — discovered during implementation.

## Implementation Units

- [ ] **Unit 1: Mapper flag audit and enablement**

**Goal:** Confirm which `buildXxx()` methods in `CConcreteOntologyRedlandTriplesDataExpressionMapper` are gated by boolean flags that are `false` by default, then enable any flags covering axiom types in this plan's scope.

**Execution note:** Read the mapper source and the querying subclass constructor before writing any test in Units 2–5. If flags need enabling, do the C++ change + WASM rebuild here.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Read (vendor, do not edit): `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp`
- Read (vendor, do not edit): `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper.cpp`
- Modify if flags missing: `src/KoncludeReasoner.cpp` (add flag setter calls in `loadTripleBuffer()` before `mapTriples()`)
- Possibly create: `patches/025-mapper-flags-enablement.patch` (if change must be a patch rather than a C++ override)
- Create: `docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md` (record findings)

**Approach:**
- List every `buildXxx()` method in the mapper. For each, check: does the querying subclass constructor set a flag to `true` that the base class leaves `false`?
- Focus on: `buildNegativePropertyAssertions()`, `buildDisjointUnion()`, any AllDisjointClasses path, `buildNominalSchemaAxioms()`, any role-characteristic flag
- If a flag is missing and the axom type is in scope for this plan: add `mapper->setConfXxx(true)` in `loadTripleBuffer()` following the `setConfExtractSimpleABoxAssertions` pattern already present
- Run the full test suite after any change before proceeding

**Patterns to follow:**
- `setConfExtractSimpleABoxAssertions(true)` call in `src/KoncludeReasoner.cpp` `loadTripleBuffer()` (the differentFrom fix from plan-028)

**Test scenarios:**
- Test expectation: none — this is an audit and configuration unit. Regression: `npm test` continues to pass 199 tests after any flag change.

**Verification:**
- A written record in `docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md` lists every `buildXxx()` method, its gating flag, and whether it is now enabled.
- `npm test` passes with all previously passing tests after any C++ change.

---

- [ ] **Unit 2: ABox entailment tests for unverified property characteristics**

**Goal:** Write targeted integration tests confirming that SymmetricProperty, FunctionalProperty, `owl:inverseOf`, `owl:hasValue`, and `rdfs:domain`/`rdfs:range` produce correct ABox entailments in `materialize()` output, compared to native Konclude.

**Execution note:** Record native verdicts first (run Docker manually for each fixture), then write the integration test.

**Requirements:** R1, R6

**Dependencies:** Unit 1 (mapper flags confirmed enabled)

**Files:**
- Create: `tests/fixtures/sym-prop.nt` (minimal: 1 SymmetricProperty, 1 sibling assertion)
- Create: `tests/fixtures/func-prop.nt` (minimal: 1 FunctionalProperty, 2 assertions to same individual from same source)
- Create: `tests/fixtures/inverse-of.nt` (minimal: 1 inverseOf pair, 1 directional assertion)
- Create: `tests/fixtures/has-value.nt` (minimal: 1 hasValue restriction, 1 matching individual)
- Create: `tests/fixtures/domain-range.nt` (minimal: domain + range + property assertion; explicit `rdf:type owl:Class` for both ends)
- Create: `tests/integration/property-characteristics.test.ts`

**Approach:**
- SymmetricProperty: ontology with `directSiblingOf rdf:type owl:SymmetricProperty; Alice directSiblingOf Bob`. After `materialize`, WASM must emit `Bob directSiblingOf Alice` in object property assertions.
- FunctionalProperty: `hasMother rdf:type owl:FunctionalProperty; Alice hasMother Eve; Alice hasMother Carol`. Expecting `Eve owl:sameAs Carol`. Use a fresh `RdfReasoner` instance (sameAs isolation rule).
- `inverseOf`: `hasChild owl:inverseOf hasParent; Alice hasChild Bob`. Expecting `Bob hasParent Alice` in object property assertions.
- `hasValue`: class restriction `C owl:equivalentClass (restriction: hasFriend owl:hasValue Alice)`. Individual `Bob rdf:type C`. Expecting `Bob hasFriend Alice`. Verify hasValue-triggered type assertions also work in the other direction.
- `rdfs:domain`/`rdfs:range`: `teaches rdfs:domain Professor; teaches rdfs:range Course; Alice teaches Math`. Expecting `Alice rdf:type Professor` and `Math rdf:type Course`. Include explicit `rdf:type owl:Class` for Professor and Course.
- For each: get native OWL/XML output via `docker run konclude/konclude:latest realization -i <fixture.owl.xml> -o /out/result.owl.xml`, convert to NTriples, verify WASM output contains the expected triples.

**Patterns to follow:**
- `tests/integration/abox-realization.test.ts` — inline NTriples fixture, `parseNTriples()`, `materialize(quads)`, filter by predicate, assert triple presence
- sameAs isolation: wrap FunctionalProperty sameAs assertions in a fresh `new RdfReasoner()` instance per the BackendAssCache workaround

**Test scenarios:**
- Happy path, SymmetricProperty: `Alice directSiblingOf Bob` → `Bob directSiblingOf Alice` in WASM ABox output
- Happy path, FunctionalProperty: `hasMother` functional + two assertions → `Eve owl:sameAs Carol` (fresh instance)
- Happy path, inverseOf: `Alice hasChild Bob` + `hasChild owl:inverseOf hasParent` → `Bob hasParent Alice`
- Happy path, hasValue: class with hasValue restriction matched by individual → hasValue role assertion emitted
- Happy path, domain: `Alice teaches Math; teaches rdfs:domain Professor` → `Alice rdf:type Professor`
- Happy path, range: `Alice teaches Math; teaches rdfs:range Course` → `Math rdf:type Course`
- Edge case, SymmetricProperty already asserted in both directions: no duplicate triples emitted
- Edge case, domain/range without explicit `owl:Class` declaration: no inferred type (verify silent-drop behavior is expected)
- Integration: SymmetricProperty result survives sequential `materialize()` calls on same store (cache invalidation test)

**Verification:**
- Each minimal fixture produces the expected entailment matching native Konclude output
- No duplicate triples in WASM output for symmetric cases

---

- [ ] **Unit 3: Consistency tests for zero-coverage constructs**

**Goal:** Add consistency/inconsistency integration tests for OWL 2 DL constructs with no existing fixture coverage: ReflexiveProperty, InverseFunctionalProperty, AllDisjointClasses, AllDisjointProperties, disjointUnionOf, NegativePropertyAssertion.

**Execution note:** Run each minimal OWL/XML fixture through the native binary first; record verdict in `tests/fixtures/issue13-native-verdicts.json` before writing integration test assertions.

**Requirements:** R2, R5, R6

**Dependencies:** Unit 1 (mapper flags)

**Files:**
- Create: `tests/fixtures/issue13/case7-reflexive-property.owl`
- Create: `tests/fixtures/issue13/case8-inverse-functional.owl`
- Create: `tests/fixtures/issue13/case9-all-disjoint-classes.owl`
- Create: `tests/fixtures/issue13/case10-all-disjoint-properties.owl`
- Create: `tests/fixtures/issue13/case11-disjoint-union.owl`
- Create: `tests/fixtures/issue13/case12-negative-property-assertion.owl`
- Modify: `tests/fixtures/issue13-native-verdicts.json` (add cases 7–12)
- Modify: `tests/integration/issue13-owl-violations.test.ts` (add cases 7–12)

**Approach:**
- Each OWL/XML fixture should be a minimal inconsistent ontology that exercises exactly one construct:
  - case7: `p rdf:type owl:IrreflexiveProperty; Alice p Alice` — expects inconsistent. Or: `p rdf:type owl:ReflexiveProperty; Alice p Alice; Alice owl:differentFrom Alice` — expects inconsistent. Choose whichever most clearly isolates the construct.
  - case8: `p rdf:type owl:InverseFunctionalProperty; Alice p Eve; Bob p Eve` — implies `Alice owl:sameAs Bob`; with `Alice owl:differentFrom Bob` → inconsistent.
  - case9: `owl:AllDisjointClasses(A B); x rdf:type A; x rdf:type B` → inconsistent.
  - case10: `owl:AllDisjointProperties(p q); p owl:equivalentProperty q` (or subPropertyOf chain creating equivalence) → inconsistent.
  - case11: `C owl:disjointUnionOf (A B); x rdf:type A; x rdf:type B; x rdf:type C` → inconsistent (member of two parts of disjoint union = not consistent with disjoint union semantics). If native returns consistent, classify as upstream limitation.
  - case12: `NegativeObjectPropertyAssertion(p Alice Bob); Alice p Bob` → inconsistent.
- For each case: run native via Docker or local binary, capture verdict, update JSON.
- If native returns consistent for any case (upstream limitation), add `assertMatchExcluding` annotation and document in `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`.

**Patterns to follow:**
- `tests/fixtures/issue13/case1-disjoint-direct.owl` — minimal OWL/XML format
- `tests/integration/issue13-owl-violations.test.ts` — JSON verdict lookup, `checkConsistency` vs `!native.isConsistent` assertion

**Test scenarios:**
- Happy path, case7 (ReflexiveProperty): WASM result matches native (consistent or inconsistent)
- Happy path, case8 (InverseFunctionalProperty): WASM matches native
- Happy path, case9 (AllDisjointClasses): WASM matches native (expect inconsistent)
- Happy path, case10 (AllDisjointProperties): WASM matches native
- Happy path, case11 (disjointUnionOf): WASM matches native
- Happy path, case12 (NegativePropertyAssertion): WASM matches native (expect inconsistent)
- Upstream limitation path: if any case shows native = consistent (wrong), document as upstream limitation and mark test with `assertMatchExcluding` on that case

**Verification:**
- All 6 new cases have verdicts in `issue13-native-verdicts.json`
- WASM agrees with native on all cases (or upstream limitation is documented)
- `npm test` passes 199 + N tests

---

- [ ] **Unit 4: ABox inference tests for zero-coverage constructs**

**Goal:** Where zero-coverage constructs produce meaningful ABox entailments beyond a boolean consistency verdict, write targeted inference tests. Specifically: NegativePropertyAssertion role in consistent ontologies, disjointUnionOf-derived class membership entailments, AllDisjointClasses-derived individual exclusions.

**Requirements:** R2, R6

**Dependencies:** Unit 1 (mapper flags), Unit 3 (consistency baseline established)

**Files:**
- Create: `tests/fixtures/all-disjoint-classes-abox.nt` (consistent but ABox membership constrained)
- Create: `tests/fixtures/disjoint-union-abox.nt`
- Modify: `tests/integration/property-characteristics.test.ts` (extend with AllDisjointClasses/disjointUnionOf inference cases)

**Approach:**
- AllDisjointClasses ABox: `AllDisjointClasses(A B C); x rdf:type A` → Konclude infers `x rdf:type complement(B)` and `x rdf:type complement(C)` internally but may not emit these directly. Test that WASM output for `x` does NOT include `rdf:type B` or `rdf:type C` — i.e., Konclude does not produce spurious type assertions. This is a negative-assertion test.
- disjointUnionOf: `C disjointUnionOf (A B); x rdf:type A` → Konclude may infer `x rdf:type C` (member of union). Test whether that entailment appears.
- For each: get native output via Docker realization, compare to WASM output using the same NTriples expansion method.
- If a construct produces no extractable ABox entailments beyond the consistency signal, document that explicitly as expected behavior and add a test expectation comment.

**Patterns to follow:**
- `tests/integration/abox-realization.test.ts` — `materialize(quads)`, filter by predicate, assert presence/absence of specific triples

**Test scenarios:**
- Happy path, AllDisjointClasses: `x rdf:type A` with `AllDisjointClasses(A B)` → WASM output does not include `x rdf:type B` (no spurious type assertion)
- Happy path, disjointUnionOf: `x rdf:type A` + `C disjointUnionOf(A B)` → `x rdf:type C` appears in materialize output (if Konclude entails it; otherwise document as non-entailment)
- Edge case, AllDisjointClasses with 3 members: `x rdf:type A` → none of B, C in output

**Verification:**
- WASM output for all cases matches native Konclude realization output exactly for the asserted predicate sets

---

- [ ] **Unit 5: Datatype restriction consistency tests**

**Goal:** Add at least two integration tests for OWL 2 datatype restrictions: one consistent and one inconsistent case using `owl:onDataRange`, `owl:minExclusive`/`owl:maxExclusive`, or typed literal constraints.

**Requirements:** R2, R6

**Dependencies:** Unit 1 (mapper flags)

**Files:**
- Create: `tests/fixtures/issue13/case13-datatype-range-consistent.owl`
- Create: `tests/fixtures/issue13/case14-datatype-range-inconsistent.owl`
- Modify: `tests/fixtures/issue13-native-verdicts.json`
- Modify: `tests/integration/issue13-owl-violations.test.ts`

**Approach:**
- case13: individual with data property value within the allowed range — expects consistent.
- case14: individual with data property value violating the range (e.g., integer where `owl:minExclusive 10` and value is 5) — expects inconsistent.
- Use simple xsd:integer type with a min/max constraint. OWL/XML encoding uses `owl:onDatatype`, `owl:withRestrictions`, `xsd:minExclusive`.
- Run native for both cases; if native returns consistent for case14 (upstream limitation), document it.

**Patterns to follow:**
- Same issue13 OWL/XML fixture format and JSON verdict pattern

**Test scenarios:**
- Happy path, case13: WASM consistent matches native consistent
- Happy path, case14: WASM inconsistent matches native inconsistent
- Upstream limitation path: if native fails to detect violation, classify and document

**Verification:**
- Both cases have verdicts in JSON; WASM agrees with native

---

- [ ] **Unit 6: Update capability gap documentation**

**Goal:** Extend `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` with all newly confirmed findings: any new upstream limitations discovered in Units 3–5, confirmed-working constructs, and any WASM-only bugs found and fixed.

**Requirements:** R5

**Dependencies:** Units 2–5

**Files:**
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Modify: `docs/solutions/capability-gaps/owllink-api-parity-matrix.md` (plan-033 Unit 1 stub — update status of newly verified axiom types)

**Approach:**
- Add a section per newly tested construct: status (PARITY / UPSTREAM_LIMITATION / WASM_BUG_FIXED), evidence (native verdict, WASM verdict), and test reference.
- Update the memory file `project_owl2dl_parity_gaps.md` to move resolved items from "unverified" to "verified" and from "zero coverage" to "tested".

**Test scenarios:**
- Test expectation: none — documentation unit only.

**Verification:**
- Every construct tested in Units 2–5 has an entry in the capability gap document.
- `project_owl2dl_parity_gaps.md` memory is updated.

## System-Wide Impact

- **Unchanged invariants:** All existing API signatures (`classify`, `materialize`, `checkConsistency`, `classifyProperties`, `isEntailed`, `explain`) are unchanged. This plan adds tests and potentially mapper flag calls — no public API changes.
- **WASM binary change (Unit 1 only, conditional):** If mapper flags are missing, a C++ change + rebuild is required. All 199 existing tests must pass after the rebuild. The rebuild in Unit 1 covers all subsequent units.
- **`buildInferredTripleBuffer` output may change (Unit 1, if flags enabled):** Enabling previously disabled mapper flags could cause previously-silent axiom types to now be processed, potentially adding triples to the realization output. The existing golden-file tests (`assertExactMatch` against `roberts-native-tbox.nt` etc.) will catch any regression immediately.
- **`issue13-native-verdicts.json` is a committed artifact:** Adding cases 7–12 requires updating the JSON. Scripts exist for re-generating it; implementer must run `scripts/run-native-issue13.sh` or equivalent for the new cases.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Some zero-coverage constructs are upstream limitations in Konclude v0.7.0 | Run native first for every case; classify as UPSTREAM_LIMITATION if native also fails; do not attempt a fix |
| Enabling a mapper flag in Unit 1 breaks existing `assertExactMatch` golden-file tests | Run full test suite immediately after any flag change; revert and investigate before proceeding |
| FunctionalProperty / InverseFunctionalProperty sameAs tests hit BackendAssCache n=3 bug | Use fresh `RdfReasoner` per test; document the isolation requirement in the test file |
| disjointUnionOf and AllDisjointClasses produce no extractable ABox output | Document as expected behavior in capability-gaps doc; Unit 4 tests become negative-assertion tests |
| Datatype restriction detection is an upstream Konclude v0.7.0 limitation | High probability — verify with native before concluding; document if native also fails |

## Sources & References

- Related plans: `docs/plans/2026-06-01-033-feat-native-api-parity-plan.md` (API parity — blocked on this plan)
- Test patterns: `tests/integration/issue13-owl-violations.test.ts`, `tests/integration/abox-realization.test.ts`
- Helpers: `tests/helpers/compare-native.ts`, `tests/helpers/fixture.ts`
- Mapper source (vendor, read-only): `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp`
- Existing gap doc: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Mapper flag learning: `docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md`
- hasValue fix reference: commit 0c86d54
- BackendAssCache sameAs limitation: `docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`
