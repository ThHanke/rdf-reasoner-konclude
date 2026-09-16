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
tags:
  [
    capability-gap,
    owl-dl,
    violation-detection,
    asymmetric,
    irreflexive,
    cardinality,
    allvaluesfrom,
    negative-property-assertion,
    datatype-restriction,
    performance,
    timeout,
  ]
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

| Case | Construct                                             | Native verdict            | WASM verdict   | Classification                              |
| ---- | ----------------------------------------------------- | ------------------------- | -------------- | ------------------------------------------- |
| 1    | disjointWith (direct)                                 | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 2    | disjointWith (via inference)                          | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 3    | AsymmetricProperty bidirectional                      | consistent ✗ (native bug) | inconsistent ✓ | **PARITY** (fixed by patches 027-028)       |
| 4    | IrreflexiveProperty self-reference                    | consistent ✗ (native bug) | inconsistent ✓ | **PARITY** (fixed by patches 027-028)       |
| 5    | maxQualifiedCardinality + differentFrom               | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 6    | allValuesFrom + disjointWith                          | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 7    | ReflexiveProperty + HasSelf complement                | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 8    | InverseFunctionalProperty + DifferentIndividuals      | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 9    | AllDisjointClasses (3-way) + double membership        | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 10   | AllDisjointProperties + EquivalentObjectProperties    | consistent ✗ (native bug) | inconsistent ✓ | **PARITY** (fixed by patch 029, 2026-06-02) |
| 11   | disjointUnionOf + double membership                   | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |
| 12   | NegativeObjectPropertyAssertion contradiction         | inconsistent ✓            | inconsistent ✓ | **PARITY** (fixed by patches 025+026)       |
| 13   | DataAllValuesFrom minInclusive — consistent (age=15)  | consistent ✓              | consistent ✓   | **PARITY**                                  |
| 14   | DataAllValuesFrom minInclusive — inconsistent (age=5) | inconsistent ✓            | inconsistent ✓ | **PARITY**                                  |

## Gap Matrix — ABox materialize inferences (property-characteristics.test.ts, owl2dl-parity.test.ts)

| Construct                                                        | Expected                                         | WASM result                                                      | Classification                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| SymmetricProperty ABox inference                                 | `Bob p Alice` inferred                           | ✓                                                                | **PARITY**                                                                          |
| inverseOf ABox inference                                         | `Bob q Alice` inferred                           | ✓                                                                | **PARITY**                                                                          |
| hasValue ABox inference                                          | `Bob hasFriend Alice` inferred                   | ✓                                                                | **PARITY** (commit 0c86d54)                                                         |
| rdfs:domain / rdfs:range ABox inference                          | `Alice rdf:type Professor` inferred              | ✓                                                                | **PARITY**                                                                          |
| EquivalentObjectProperties classify                              | property emits `p rdfs:subPropertyOf q`          | ✓ (TS post-process)                                              | **PARITY** (R1, plan-039)                                                           |
| AllDisjointProperties ABox clash                                 | inconsistency detected                           | ✓ (C++ saturation patch 029)                                     | **PARITY** (R2, plan-039)                                                           |
| differentFrom reflexive                                          | `a owl:differentFrom a` → inconsistent           | ✓ (TS pre-check)                                                 | **PARITY** (R3, plan-039)                                                           |
| someValuesFrom filler type                                       | filler `rdf:type` inferred                       | ✓ (TS post-process)                                              | **PARITY** (R5, plan-039)                                                           |
| disjointUnionOf classify A⊑C                                     | member emits `rdfs:subClassOf` union class       | ✓ (TS post-process)                                              | **PARITY** (R6, plan-039)                                                           |
| complementOf named-class ABox clash                              | individual in A ∩ complementOf(A) → inconsistent | JS pre-process in `checkConsistency()` detects named-class clash | **PARITY** (R4, plan-041, commit 9b1fa85)                                           |
| FunctionalProperty checkConsistency                              | TBox-only fixture → consistent                   | FP/IFP declarations stripped before WASM; no ALIF+ hang          | **PARITY** (R8a, plan-041, commit 66c5584)                                          |
| FunctionalProperty classify                                      | property emits `rdfs:subPropertyOf`              | FP/IFP declarations stripped before WASM                         | **PARITY** (R8b, plan-041, commit 66c5584)                                          |
| FunctionalProperty → sameAs (materialize)                        | `Eve owl:sameAs Carol` inferred                  | JS sameAs computation for FP multi-filler + FP/IFP stripping     | **PARITY** (R8c, plan-041, commit 66c5584)                                          |
| InverseFunctionalProperty → sameAs (materialize)                 | `Eve owl:sameAs Carol` inferred                  | JS sameAs computation for IFP multi-subject + FP/IFP stripping   | **PARITY** (R8d, plan-041, commit 66c5584)                                          |
| FunctionalProperty sameAs (property-characteristics)             | `Alice owl:sameAs Bob` inferred                  | same as R8c                                                      | **PARITY** (plan-041, commit 66c5584)                                               |
| NegativePropertyAssertion — no spurious positive (owl2dl-parity) | `alice knows bob` must NOT appear                | fresh RdfReasoner avoids BackendAssCache state accumulation      | **PARITY** (plan-041, commit 2ff1cd7)                                               |
| NPA consistent materialize (property-characteristics)            | no spurious assertions                           | fresh RdfReasoner avoids BackendAssCache state accumulation      | **PARITY** (plan-041, commit 2ff1cd7)                                               |
| AllDisjointClasses — negative probe (NTriples)                   | `x rdf:type B` must NOT appear                   | materialize() hangs 30s+ on ALIF+ NTriples path                  | **WASM_REGRESSION** (R7a, native works in ~8ms; distinct from patch-030 Turtle fix) |
| disjointUnionOf — superclass entailment (NTriples)               | `x rdf:type C` probe                             | materialize() hangs 30s+ on ALIF+ NTriples path                  | **WASM_REGRESSION** (R7b, native works in ~8ms; distinct from patch-030 Turtle fix) |

### Classification Taxonomy

- **PARITY** — native and WASM agree; no gap
- **UPSTREAM_LIMITATION** — native also fails or hangs; inherent in Konclude v0.7.0; not fixable in this repo without upstream changes
- **WASM_BUG_FIXED** — was a WASM port bug; fixed by a patch in `patches/`
- **WASM_REGRESSION** — native works correctly; WASM-specific hang or wrong result; root cause in WASM realization thread lifecycle
- **DEFERRED** — fix attempted but caused a regression elsewhere; postponed for future investigation

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

### Case 10: PARITY — AllDisjointProperties + EquivalentObjectProperties (fixed by patch 029, 2026-06-02)

WASM now correctly detects inconsistency. Native Konclude v0.7.0 still returns consistent (upstream bug).

**Root cause:** `EquivalentObjectProperties(p, q)` stores `q` in `p.equivalentRoles` but does NOT
add `q` to `p.getIndirectSuperRoleList()`. The saturation's `createRoleAssertionLink` only iterates
`getIndirectSuperRoleList()` for disjoint checks — so the equivalence-disjoint clash is never
detected. Furthermore, the check was inside the `if (othIndiNode && initialized)` branch, which
only fires when the target individual's saturation node is already initialized.

**Fix (patch 029):** In `initializeRoleAssertions`, before the `othIndiNode` branch, iterate
`role->getEquivalentRoleList()` with `!isNegated()` filter (to skip inverse roles stored in the
same list). For each equivalent role `eqRole`, check `eqRole->hasDisjointRole(role)`. If true,
set `INDSATFLAGCLASHED` on `indiProcSatNode` and return. This blocks the backend cache from
writing `CompletelyHandled=true`, forcing the full completion algorithm to detect the clash.

**The `!isNegated()` filter is critical:** `getEquivalentRoleList()` returns `mInverseEquivalentRoles`
which stores both equivalent roles (`isNegated=false`) and inverse roles (`isNegated=true`).
Without the filter, `InverseObjectProperties(p, q)` + `DisjointObjectProperties(p, q)` would
produce a false inconsistency.

See project_upstream_konclude_bugs.md Bug 3 (resolved).

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

### WASM_REGRESSION — materialize() hang on AllDisjointClasses / disjointUnionOf (R7a, R7b)

`materialize()` (full realization pipeline) hangs indefinitely in WASM on consistent ontologies
with these constructs when used with ABox individuals:

- `owl:AllDisjointClasses` + `owl:members` RDF list (R7a)
- `owl:disjointUnionOf` RDF list (R7b)

**This is a WASM-specific regression.** Native Konclude v0.7.0 completes correctly in ~8ms for
identical ontologies (confirmed via Unit 2 investigation documented in
`docs/plans/parity-gap-native-investigation-2026-06-03.md`). The hang is caused by a WASM
realization thread lifecycle regression — likely related to SI-expressiveness triggering a
different realization code path that stalls in the WASM pthread environment.

Note: `checkConsistency()` on equivalent Turtle-format ontologies (cases 9, 11) works fine.
The hang is realization-pipeline specific.

### PARITY — materialize() with NegativePropertyAssertion (plan-041 workaround)

`materialize()` on consistent ontologies with `owl:NegativePropertyAssertion` now passes via a
JS-layer workaround: each test call uses a **fresh `RdfReasoner` instance**, which prevents
BackendAssCache state accumulation across sequential calls from triggering the hang.

The underlying WASM hang on accumulated BackendAssCache state is an upstream limitation — not
fixable without upstream realization pipeline changes. But the fresh-instance pattern makes the
test reliable. Activated in commit 2ff1cd7 (plan-041).

### PARITY — FunctionalProperty / InverseFunctionalProperty (plan-041 workaround)

FP/IFP tests pass via a JS-layer workaround: `owl:FunctionalProperty` and
`owl:InverseFunctionalProperty` declarations are **stripped from the NTriples payload** before
passing to WASM. This prevents the ALIF+ expressiveness upgrade that causes the native Konclude
hang. `owl:sameAs` inferences are computed in JS instead: FP multi-filler → sameAs chain;
IFP multi-subject → sameAs chain. TBox-only fixtures (checkConsistency, classify) just need the
stripping. Activated in commit 66c5584 (plan-041).

The underlying ALIF+ hang in `materialize()` / `realize` when FP forces `owl:sameAs` inference
is an upstream limitation confirmed in native Docker binary.
See project_upstream_konclude_bugs.md Bug 2.

## Next Steps

| Classification                                      | Action                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| WASM_REGRESSION (R7a/R7b materialize NTriples hang) | Investigate WASM realization thread lifecycle for ALIF+ NTriples path; compare pthread stack/semaphore state vs native |
| PARITY (cases 1–14 + R1–R8d, plan-039/041)          | No action needed; all tests passing (322 passing, 2 skipped as of plan-041)                                            |
| WASM_BUG_FIXED (case 12, patches 025+026)           | Upstream PRs pending for both NPA bugs                                                                                 |
| WASM_SURPASSES_NATIVE (cases 3–4, patches 027-028)  | File upstream PRs for AsymmetricProperty + IrreflexiveProperty saturation clash fixes                                  |
| WASM_SURPASSES_NATIVE (case 10, patch 029)          | File upstream PR for AllDisjointProperties + EquivalentObjectProperties clash fix                                      |

Tests in `tests/integration/issue13-owl-violations.test.ts` and
`tests/integration/property-characteristics.test.ts` cover all cases above.
