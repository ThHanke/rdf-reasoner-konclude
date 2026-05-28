---
title: OWL-DL violation detection gaps — WASM vs native Konclude (issue #13)
date: 2026-05-28
category: capability-gaps
module: wasm-reasoner-output
problem_type: capability_gap
component: consistency-checker
symptoms:
  - AsymmetricProperty bidirectional assertion not flagged as inconsistent
  - IrreflexiveProperty self-reference not flagged as inconsistent
root_cause: upstream_limitation
resolution_type: upstream_fix_required
severity: medium
tags: [capability-gap, owl-dl, violation-detection, asymmetric, irreflexive, cardinality, allvaluesfrom, performance, timeout]
---

# OWL-DL violation detection gaps — WASM vs native Konclude (issue #13)

## Context

Six OWL-DL violation cases from [ontosphere issue #13](https://github.com/ThHanke/ontosphere/issues/13) were
run against native Konclude v0.7.0-1138 (Linux x64 static binary) and the WASM build to classify
discrepancies as port bugs vs upstream limitations.

Native binary: acquired via `scripts/acquire-native-konclude.sh`; run via `scripts/run-native-issue13.sh`.
Ground truth: committed at `tests/fixtures/issue13-native-verdicts.json`.
Integration tests: `tests/integration/issue13-owl-violations.test.ts`.

## Gap Matrix

| Case | Violation | Native verdict | WASM verdict | Classification |
|------|-----------|---------------|--------------|----------------|
| 1 | disjointWith (direct) | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 2 | disjointWith (via inference) | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 3 | AsymmetricProperty bidirectional | consistent ✗ | consistent ✗ | **UPSTREAM_LIMITATION** |
| 4 | IrreflexiveProperty self-reference | consistent ✗ | consistent ✗ | **UPSTREAM_LIMITATION** |
| 5 | maxQualifiedCardinality + differentFrom | inconsistent ✓ | inconsistent ✓ | **PARITY** |
| 6 | allValuesFrom + disjointWith | inconsistent ✓ | inconsistent ✓ | **PARITY** |

### Classification Taxonomy

- **PARITY** — native and WASM agree; no gap
- **UPSTREAM_LIMITATION** — native also fails; inherent in Konclude v0.7.0; not fixable in this repo without upstream changes
- **PERFORMANCE_GAP** — native succeeds within 30 s; WASM times out; optimization opportunity in this codebase (all resolved as of 2026-05-28)

## Case Analysis

### Cases 1–2: PARITY

Both `owl:disjointWith` violations (direct and domain/range inferred) are correctly detected by native
Konclude and our WASM build. These work because the SI-expressiveness path exercises the standard
tableau clash detection without requiring ABox role-characteristic reasoning.

No action needed.

### Cases 3–4: UPSTREAM_LIMITATION — AsymmetricProperty / IrreflexiveProperty

**Hypothesis:** Konclude v0.7.0 does not implement ABox-level violation detection for
`owl:AsymmetricProperty` and `owl:IrreflexiveProperty`. The consistency checker preprocesses
these characteristics but the clash rules for detecting a violation in the ABox individual
graph are absent or gated behind a path not exercised by the standard `consistency` command.

Evidence: native binary also reports "consistent" for both cases despite the violations being
OWL-DL valid inconsistencies. The WASM build matches native behavior, so this is not a port
defect.

**Expressiveness note:** Conceiving these as role characteristic conflicts requires the SROIQ
tableau to track role chains and anti-symmetry clashes during ABox saturation. Konclude's
documentation targets SROIQV(D) but the ABox pipeline may not propagate these constraints
into saturation clash checking.

**Fixability:** Not fixable within this repo. Would require upstream Konclude changes to the
ABox saturation rules for asymmetric/irreflexive roles. Could be worked around by a
pre-processing step that materializes the violation as a disjointWith clash before sending
to Konclude.

### Case 5: PARITY — maxQualifiedCardinality + differentFrom (resolved 2026-05-28)

**Root cause:** `CConcreteOntologyRedlandTriplesDataExpressionMapper` had
`mConfExtractSimpleABoxAssertions = false` by default, so `buildSimpleABoxAxioms()` never ran.
This function is the only place that registers `owl:differentFrom` as `DifferentIndividuals`
axioms. Without it, the tableau could assume `vinA = vinB` (open world assumption), making the
`maxQualifiedCardinality 1` constraint satisfiable — and the reasoner would hang trying to
explore the resulting open search space.

**Fix:** Added a public setter `setConfExtractSimpleABoxAssertions(bool)` to the mapper via
`patches/016-mapper-simple-abox-setter.patch`. In `src/KoncludeReasoner.cpp`
`loadTripleBuffer()`, call `mapper->setConfExtractSimpleABoxAssertions(true)` before
`mapTriples()`. With `DifferentIndividuals` registered, the clash is detected in under 1 s.

**Plan:** `docs/plans/2026-05-28-026-fix-differentfrom-abox-mapping-plan.md`

### Case 6: PARITY — allValuesFrom + disjointWith (resolved 2026-05-28)

**Root cause:** The full classification pipeline (`OPSCLASSCLASSIFY`) caused the KPSet
parallel classifier to time out on ontologies with complex universal restrictions.

**Fix:** `checkConsistency()` uses a `consistencyOnly()` pipeline that skips `OPSCLASSCLASSIFY`,
running only `OPSTRIPLESMAPPING → OPSACTIVECOUNT → OPSBUILD → OPSPREPROCESS → OPSCONSISTENCY →
OPSPRECOMPUTESATURATION`. This matches native Konclude `consistency` command behavior and
completes well within 30 s.

## Next Steps

| Classification | Action |
|---------------|--------|
| UPSTREAM_LIMITATION (cases 3–4) | File issue against konclude/Konclude; add pre-processing workaround (rewrite AsymmetricProperty violation as disjointWith clash) in a separate PR |
| PARITY (cases 1–2, 5–6) | No action needed; all tests passing |

The integration tests in `tests/integration/issue13-owl-violations.test.ts` surface these gaps:
cases 3–4 pass (WASM matches native, both wrong), cases 1–2 and 5–6 pass (PARITY).
