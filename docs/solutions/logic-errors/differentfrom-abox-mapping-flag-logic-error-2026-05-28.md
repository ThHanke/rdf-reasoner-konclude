---
title: "owl:differentFrom silently dropped due to mConfExtractSimpleABoxAssertions=false"
date: 2026-05-28
category: logic-errors
module: wasm-abox-mapper
problem_type: logic_error
component: abox-mapper
symptoms:
  - "owl:differentFrom assertions silently dropped when loading triples via loadTripleBuffer()"
  - "Reasoner hangs indefinitely (30s+) on ontologies with maxQualifiedCardinality + differentFrom"
  - "No error or warning emitted; open-world assumption allows reasoner to unify distinct individuals"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [abox, differentfrom, mapper, wasm-config, cardinality, open-world, hang, konclude]
---

# owl:differentFrom silently dropped due to mConfExtractSimpleABoxAssertions=false

## Problem

`owl:differentFrom` assertions were silently discarded during triple loading into the WASM reasoner.
Without `DifferentIndividuals` axioms, the cardinality tableau applied the open-world assumption —
treating two named individuals as potentially identical — making `maxQualifiedCardinality 1`
satisfiable and leaving saturation with no clash to find, causing an indefinite hang.

## Symptoms

- `checkConsistency()` does not return within 30 s for ontologies combining
  `owl:maxQualifiedCardinality` with `owl:differentFrom` (issue #13 case 5).
- Native Konclude returns `inconsistent` for the same input in under 1 s.
- No error or warning is emitted; the call simply hangs.
- Other ABox patterns (`owl:disjointWith`, `owl:allValuesFrom`) work correctly — the hang is
  specific to the `differentFrom` path.

## What Didn't Work

**Blank-node encoding suspected first.** The initial hypothesis was that the anonymous restriction
blank nodes representing `owl:maxQualifiedCardinality` were mangled at the JS→WASM boundary.
Research confirmed `ts/intern.ts` encodes `BlankNode` with typeTag 1 and C++ decodes via
`librdf_new_node_from_blank_identifier` — the blank node IS present in the librdf model after
loading. Case 6 (`allValuesFrom`) also uses restriction blank nodes and already worked, ruling
this out.

**Saturation hang misattributed to pipeline ordering.** A `consistencyOnly()` minimal pipeline
(skipping `OPSCLASSCLASSIFY`) was added as a workaround. It did not fix case 5 — the hang
persisted because the axiom was never registered regardless of which pipeline ran. The workaround
masked the root cause.

## Solution

The root cause was a boolean flag `mConfExtractSimpleABoxAssertions` on
`CConcreteOntologyRedlandTriplesDataExpressionMapper` (default: `false`). `buildSimpleABoxAxioms()`
— the **only** function that converts `owl:differentFrom` triples into `DifferentIndividuals`
axioms — is gated on this flag:

```cpp
// CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp ~line 90
if (mConfExtractSimpleABoxAssertions) {
    buildSimpleABoxAxioms();
}
```

The subclass `CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper` sets it to `true` in
its constructor (line 33), but the WASM `loadTripleBuffer()` path instantiates the **base class**
directly and never sets the flag.

**Step 1 — Add a public setter via `patches/016-mapper-simple-abox-setter.patch`:**

```cpp
// CConcreteOntologyRedlandTriplesDataExpressionMapper.h — public section
void setConfExtractSimpleABoxAssertions(bool v) { mConfExtractSimpleABoxAssertions = v; }
```

**Step 2 — Call the setter in `src/KoncludeReasoner.cpp` `loadTripleBuffer()` before `mapTriples()`:**

```cpp
// Before:
CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
    new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
mapper->mapTriples(mImpl->mOntology, mImpl->mOntology->getOntologyTriplesData());

// After:
CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
    new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
mapper->setConfExtractSimpleABoxAssertions(true);  // enables buildSimpleABoxAxioms()
mapper->mapTriples(mImpl->mOntology, mImpl->mOntology->getOntologyTriplesData());
```

**Step 3 — Revert the `consistencyOnly()` workaround.** With `DifferentIndividuals` registered,
the full `classification + consistency` pipeline detects the clash in ~95 ms. The `consistencyOnly()`
method was removed from `KoncludeReasoner.cpp/.h`, `bindings.cpp`, `worker.ts`, `konclude.d.mts`,
and unit test mocks.

## Why This Works

`buildSimpleABoxAxioms()` is the **only** code path that converts `owl:differentFrom` triples into
`DifferentIndividuals` axioms in Konclude's internal ontology model. The ABox indexer
(`CRedlandStoredTriplesIndividualAssertionConvertionIndexer::indexABoxIndividuals()`) handles type
assertions and object property assertions but does **not** handle `owl:differentFrom` — there is
no fallback path for this axiom type.

Without `DifferentIndividuals`, the tableau applies the open-world assumption: `vinA` and `vinB`
could be the same individual, so `maxQualifiedCardinality 1` is satisfiable and saturation never
terminates. With the axiom present, the clash is found immediately.

The setter approach was chosen over switching to the `CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper`
subclass because that subclass has a broader responsibility surface — a targeted setter minimises
blast radius. Double-insertion of type/property assertions (mapper + indexer both active) is
idempotent: Konclude's `OntologyBuilder` deduplicates expressions by hash.

## Prevention

**Mapper flag audit pattern.** `CConcreteOntologyRedlandTriplesDataExpressionMapper` has multiple
boolean configuration flags. Any WASM feature relying on an ABox axiom type should check whether
the relevant `buildXxx()` method is gated by one of these flags and whether the flag is set on the
base-class instance in `loadTripleBuffer()`. See also:
`docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
for the prior flag-gating pattern with `WasmConfigProvider`.

**Distinguish input mapping from output emission.** Enabling `buildSimpleABoxAxioms()` allows
`owl:differentFrom` to be used as *input* for consistency checking. Emitting entailed
differentness triples as *output* is a separate concern and remains out of scope.

**Native parity testing.** The `tests/fixtures/issue13-native-verdicts.json` ground-truth file
captures the expected native Konclude result for each violation case. Integration tests in
`tests/integration/issue13-owl-violations.test.ts` must stay in sync with the gap matrix in
`docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`. Any new ABox axiom
type should have a native-verdict fixture and a corresponding integration test.

**Test strategy for new ABox axiom types:**
```
1. Add a minimal ontology fixture triggering a violation detectable by native Konclude.
2. Add a native-verdict entry to tests/fixtures/issue13-native-verdicts.json.
3. Add an integration test case expecting the native verdict.
4. Verify checkConsistency() returns the correct result within 5 s.
```

**Do not use workaround pipelines as permanent solutions.** The `consistencyOnly()` workaround
was added to unblock testing but masked the root cause. Workaround methods should carry a
`// WORKAROUND:` comment referencing the open issue so they are removed once the root cause is fixed.

## References

- Plan: `docs/plans/2026-05-28-026-fix-differentfrom-abox-mapping-plan.md`
- Gap matrix: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` (case 5)
- Issue: [ontosphere #13](https://github.com/ThHanke/ontosphere/issues/13)
- Patch: `patches/016-mapper-simple-abox-setter.patch`
- Related: `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
