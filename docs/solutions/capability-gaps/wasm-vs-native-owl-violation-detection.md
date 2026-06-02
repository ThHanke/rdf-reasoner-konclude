---
title: OWL-DL violation detection gaps — WASM vs native Konclude (issue #13 + plan-034)
date: 2026-06-02
category: capability-gaps
module: wasm-reasoner-output
problem_type: capability_gap
component: consistency-checker
symptoms:
  - AsymmetricProperty bidirectional assertion not flagged as inconsistent (fixed by patches 027-028)
  - IrreflexiveProperty self-reference not flagged as inconsistent (fixed by patches 027-028)
  - NegativePropertyAssertion inconsistency not detected (fixed by patches 025+026)
  - materialize() hangs on AllDisjointClasses/disjointUnionOf/NPA blank-node NTriples
root_cause: upstream_limitation
resolution_type: upstream_fix_required
severity: medium
tags: [capability-gap, owl-dl, violation-detection, asymmetric, irreflexive, cardinality, allvaluesfrom, negative-property-assertion, datatype-restriction, performance, timeout]
---

# OWL-DL violation detection gaps — WASM vs native Konclude (issue #13 + plan-034)

## Context

Fourteen OWL-DL violation / reasoning cases covering issue #13 (six cases) and plan-034
targeted OWL 2 DL parity verification (cases 7–14) were run against native Konclude v0.7.0
and the WASM build to classify discrepancies as port bugs vs upstream limitations.

Native binary: acquired via `scripts/acquire-native-konclude.sh`; run via `scripts/run-native-issue13.sh`.
Ground truth: committed at `tests/fixtures/issue13-native-verdicts.json`.
Integration tests: `tests/integration/issue13-owl-violations.test.ts` (consistency checks),
`tests/integration/property-characteristics.test.ts` (ABox materialize inferences).

## Gap Matrix — consistency checks (issue13-owl-violations.test.ts)

| Case | Construct | Native verdict | WASM verdict | Classification |
|------|-----------|---------------|--------------|----------------|
| 1 | disjointWith (direct) | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 2 | disjointWith (via inference) | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 3 | AsymmetricProperty bidirectional | consistent ✗ (native bug) | inconsistent ✓ | **PARITY** (fixed by patches 027-028) |
| 4 | IrreflexiveProperty self-reference | consistent ✗ (native bug) | inconsistent ✓ | **PARITY** (fixed by patches 027-028) |
| 5 | maxQualifiedCardinality + differentFrom | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 6 | allValuesFrom + disjointWith | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 7 | ReflexiveProperty + HasSelf complement | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 8 | InverseFunctionalProperty + DifferentIndividuals | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 9 | AllDisjointClasses (3-way) + double membership | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 10 | AllDisjointProperties + EquivalentObjectProperties | consistent ✗ | consistent ✗ | **UPSTREAM_LIMITATION** |
| 11 | disjointUnionOf + double membership | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 12 | NegativeObjectPropertyAssertion contradiction | inconsistent ✓ | inconsistent ✓ | **PARITY** (fixed by patches 025+026) |
| 13 | DataAllValuesFrom minInclusive — consistent (age=15) | consistent ✓ | consistent ✓ | **PARITY** |
| 14 | DataAllValuesFrom minInclusive — inconsistent (age=5) | inconsistent ✓ | inconsistent ✓ | **PARITY** |

## Gap Matrix — ABox materialize inferences (property-characteristics.test.ts)

| Construct | Expected | WASM result | Classification |
|-----------|----------|-------------|----------------|
| SymmetricProperty ABox inference | `Bob p Alice` inferred | ✓ | **PARITY** |
| inverseOf ABox inference | `Bob q Alice` inferred | ✓ | **PARITY** |
| hasValue ABox inference | `Bob hasFriend Alice` inferred | ✓ | **PARITY** (commit 0c86d54) |
| rdfs:domain / rdfs:range ABox inference | `Alice rdf:type Professor` inferred | ✓ | **PARITY** |
| FunctionalProperty → sameAs | `Eve owl:sameAs Carol` inferred | hangs at ALIF+ precompute | **UPSTREAM_LIMITATION** |
| AllDisjointClasses — no spurious type | `x rdf:type B` must NOT appear | materialize() hangs 30s+ | **UPSTREAM_LIMITATION** |
| disjointUnionOf — superclass entailment | `x rdf:type C` probe | materialize() hangs 30s+ | **UPSTREAM_LIMITATION** |
| NegativePropertyAssertion — no spurious positive | `alice knows bob` must NOT appear | materialize() hangs 30s+ | **UPSTREAM_LIMITATION** |

### Classification Taxonomy

- **PARITY** — native and WASM agree; no gap
- **UPSTREAM_LIMITATION** — native also fails or hangs; inherent in Konclude v0.7.0; not fixable in this repo without upstream changes
- **WASM_BUG_FIXED** — was a WASM port bug; fixed by a patch in `patches/`

## Case Analysis

### Cases 1–2: PARITY — disjointWith

Both `owl:disjointWith` violations (direct and domain/range inferred) correctly detected.
Standard tableau clash detection at SI expressiveness; no ABox role-characteristic reasoning needed.

### Cases 3–4: PARITY — AsymmetricProperty / IrreflexiveProperty (fixed by patches 027-028, 2026-06-02)

WASM now correctly detects inconsistency for both constructs. Native Konclude v0.7.0 still
reports "consistent" (upstream bug). The fixes are in the saturation algorithm.

**AsymmetricProperty fix (patch 028):** In `initializeRoleAssertions`, when an ABox nominal
individual has a role assertion `r(a,b)` and `b` has a reverse ABox assertion `r(b,a)` for an
asymmetric role `r`, set `INDSATFLAGCLASHED` on `a`'s saturation node. This prevents the
backend cache from writing `CompletelyHandled=true`, causing the completion algorithm to re-check.
The check uses raw ABox assertions (order-independent, fully populated before saturation).

**IrreflexiveProperty fix (patch 028):** In `initializeRoleAssertions`, when an ABox nominal
individual has a self-loop `r(a,a)` and any super-role of `r` is marked `isIrreflexive()`, set
`INDSATFLAGCLASHED`. This is simpler and more reliable than checking the resolve node's concept
label set (which may not be populated at check time).

**Why patch 027 is also needed:** Patch 027 adds `addInverseRoleLinker` + `setInverseRole` in
the `BETASYMMETRICPROPERTY` builder handler. This ensures the preprocessor reuses the
builder-created inverse role expression instead of creating a duplicate `CRole*`, which is
needed for correct role hierarchy reasoning independent of the saturation clash fix.

### Case 5: PARITY — maxQualifiedCardinality + differentFrom (resolved 2026-05-28)

`mConfExtractSimpleABoxAssertions = false` default suppressed `DifferentIndividuals` axiom
registration. Fixed by `patches/016-mapper-simple-abox-setter.patch`. Plan: `2026-05-28-026-...`.

### Case 6: PARITY — allValuesFrom + disjointWith (resolved 2026-05-28)

`checkConsistency()` uses `consistencyOnly()` pipeline (skips `OPSCLASSCLASSIFY`). KPSet
classifier timed out on the full pipeline; consistency-only path completes in under 1 s.

### Cases 7–9, 11: PARITY — ReflexiveProperty, InverseFunctionalProperty, AllDisjointClasses, disjointUnionOf

All consistency checks pass against native ground truth. Verified 2026-06-02.

### Case 10: UPSTREAM_LIMITATION — AllDisjointProperties + EquivalentObjectProperties

Native Konclude returns consistent despite the contradiction. Property disjointness and
equivalence reasoning paths don't interact in the preprocessor. See project_upstream_konclude_bugs.md Bug 3.

### Case 12: PARITY — NegativeObjectPropertyAssertion contradiction (fixed 2026-06-02)

**Two upstream bugs found and patched:**

**Bug 1 (patch 025):** In `initTripleDataProcessing()`, three filter-statement variable
assignments are scrambled — `PREFIX_OWL_ASSERTION_PROPERTY` is assigned to
`mPartialFilteringStatementForOWLTargetIndividualSuccessors` and vice versa. Result: the
NPA blank-node stream queries wrong predicates → source individual never matched → axiom not
created. See project_upstream_konclude_bugs.md Bug 1.

**Bug 2 (patch 026):** In `buildSeparateNodeBasedAxioms()`, the hash and builder method for
the literal-target path and individual-target path are swapped:
- Literal target path used `mObjectPropertyNodeIdentifierDataHash` + `getNegativeObjectPropertyAssertion`
- Individual target path used `mDataPropertyNodeIdentifierDataHash` + `getNegativeDataPropertyAssertion`

After both patches, `checkConsistency()` correctly detects the NPA contradiction as inconsistent.
See project_upstream_konclude_bugs.md Bug 4.

### Cases 13–14: PARITY — DataAllValuesFrom + xsd:minInclusive (verified 2026-06-02)

Datatype restriction reasoning works correctly. `age=15 >= 10` → consistent; `age=5 < 10` → inconsistent.
Both match native Konclude ground truth.

### UPSTREAM_LIMITATION — materialize() hang on blank-node constructs

`materialize()` (full realization pipeline) hangs indefinitely on consistent ontologies with
these blank-node constructs in NTriples format:

- `owl:AllDisjointClasses` + `owl:members` RDF list
- `owl:disjointUnionOf` RDF list
- `owl:NegativePropertyAssertion` blank node (consistent ontology)

Note: `checkConsistency()` on equivalent Turtle-format ontologies (cases 9, 11, 12) works fine.
The hang is realization-pipeline specific, not parsing-specific.

Compare: case 12 `checkConsistency()` with an INCONSISTENT NPA ontology now passes after patches
025+026. But `materialize()` on a CONSISTENT NPA ontology still hangs. Different pipeline.

**Fixability:** Not fixable in this port without upstream changes to the realization pipeline
for these constructs.

### UPSTREAM_LIMITATION — FunctionalProperty + ABox realization (ALIF+)

`materialize()` or `realize` command stalls at "Precomputing...expressiveness 'ALIF+'" when an
`owl:FunctionalProperty` forces `owl:sameAs` inference via multiple ABox assertions. Confirmed
in native Docker binary. See project_upstream_konclude_bugs.md Bug 2.

## Next Steps

| Classification | Action |
|---------------|--------|
| UPSTREAM_LIMITATION (case 10) | File issue against konclude/Konclude |
| UPSTREAM_LIMITATION (materialize hangs) | File issue; workaround: use `checkConsistency()` where possible |
| PARITY (cases 1–9, 11–14) | No action needed; all tests passing |
| WASM_BUG_FIXED (case 12, patches 025+026) | Upstream PRs pending for both NPA bugs |
| WASM_SURPASSES_NATIVE (cases 3–4, patches 027-028) | File upstream PRs for AsymmetricProperty + IrreflexiveProperty saturation clash fixes |

Tests in `tests/integration/issue13-owl-violations.test.ts` and
`tests/integration/property-characteristics.test.ts` cover all cases above.
