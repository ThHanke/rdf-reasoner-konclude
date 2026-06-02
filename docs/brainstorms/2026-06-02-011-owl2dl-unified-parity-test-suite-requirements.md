---
date: 2026-06-02
topic: owl2dl-unified-parity-test-suite
---

# OWL 2 DL Unified Parity Test Suite

## Problem Frame

Current test coverage is fragmented: `issue13` covers only `checkConsistency()`, `property-characteristics`
covers only `materialize()`, `owl-dl-capabilities` covers only select `classify()` constructs. No single
test exercises the same OWL 2 DL construct across all three operations (checkConsistency / classify /
materialize). Data property hierarchy is untested. The README OWL 2 DL coverage table is outdated (cases
3, 4, 10 still listed as UPSTREAM_LIMITATION after being fixed).

## Requirements

**Three-stage construct tests (checkConsistency / classify / materialize)**

- R1. For each OWL 2 DL construct below, a shared fixture (Turtle format) is tested in three `describe`
  blocks — `checkConsistency`, `classify`, and `materialize` — in a single test file
  `tests/integration/owl2dl-parity.test.ts`.
- R2. `checkConsistency` stage: asserts consistent or inconsistent as appropriate for the fixture.
- R3. `classify` stage: asserts expected subclass / equivalentClass relationships derived from the TBox.
- R4. `materialize` stage: asserts expected ABox entailments (rdf:type, object property inferences).
- R5. UPSTREAM_LIMITATION cases (materialize hangs for NTriples blank-node constructs; FunctionalProperty
  ALIF+ hang) are included in the file as `it.skip` with explicit UPSTREAM_LIMITATION markers — same
  pattern as `issue13` and `property-characteristics` tests.

**Constructs to cover (full OWL 2 DL profile)**

- R6. TBox: `rdfs:subClassOf`, `owl:equivalentClass`, `owl:disjointWith`, `owl:complementOf`
- R7. Restrictions: `owl:someValuesFrom`, `owl:allValuesFrom`, `owl:hasValue`, `owl:hasSelf`
- R8. Cardinality: `owl:minCardinality`, `owl:maxCardinality`, `owl:exactCardinality`,
  `owl:minQualifiedCardinality`, `owl:maxQualifiedCardinality`
- R9. Property characteristics: `owl:SymmetricProperty`, `owl:AsymmetricProperty`,
  `owl:IrreflexiveProperty`, `owl:ReflexiveProperty`, `owl:TransitiveProperty`,
  `owl:FunctionalProperty`, `owl:InverseFunctionalProperty`, `owl:inverseOf`
- R10. ABox: `owl:sameAs`, `owl:differentFrom`, `owl:AllDifferent`, `owl:NegativePropertyAssertion`
- R11. Property disjointness: `owl:AllDisjointProperties` + `owl:EquivalentObjectProperties`
  (new PARITY case from plan-036)
- R12. Class collections: `owl:AllDisjointClasses`, `owl:disjointUnionOf`
- R13. Data properties: `owl:DatatypeProperty`, `rdfs:subPropertyOf` for data properties,
  `owl:FunctionalProperty` on data properties, `rdfs:range` with datatype

**classifyProperties() data property coverage**

- R14. `classifyProperties()` is tested for data property `rdfs:subPropertyOf` hierarchy — parallel
  to the existing object property test.
- R15. `classifyProperties()` correctly excludes object properties when called on a data-property-only
  fixture, and vice versa.

**README update**

- R16. `README.md` section `## OWL 2 DL coverage / Consistency checking` table is updated to show
  all 14 cases (1-14) with correct status:
  - Cases 3, 4, 10: **PARITY (WASM surpasses native v0.7.0)** — note that WASM correctly detects
    these violations; native Konclude misses them (upstream bugs fixed by patches 027-029)
  - All other cases: PARITY
- R17. The UPSTREAM_LIMITATION footnote is corrected to describe only the materialize() hangs and
  FunctionalProperty ALIF+ hang; the old "Cases 3 and 4 cannot be fixed" text is removed.
- R18. Classification and ABox realization sections are updated to include `owl:AsymmetricProperty`
  and `owl:IrreflexiveProperty` in the verified-working lists.

## Success Criteria

- `tests/integration/owl2dl-parity.test.ts` exists and covers all constructs in R6-R13.
- Each construct has all three operation stages (R2-R4), skipping only known UPSTREAM_LIMITATION paths.
- `classifyProperties()` data property tests pass (R14-R15).
- README is accurate for all 14 consistency cases and OWL 2 DL coverage sections.
- `npm test` continues to report 21 test files all passing.

## Scope Boundaries

- Axiom API integration tests (`isEntailed`, `whatIf`, `explain`) are in the sibling plan (010).
- UPSTREAM_LIMITATION hangs are included as `it.skip` — not fixed in this plan.
- Browser integration tests are out of scope.
- Performance benchmarks are out of scope.
- The fixture format is **Turtle** — avoids NTriples blank-node hang triggers and is more readable.

## Key Decisions

- **Shared fixtures per construct group in `tests/fixtures/owl2dl/`**: one `.ttl` file per logical
  construct group, loaded by the test. Inline strings are acceptable for very small fixtures.
- **Three `describe` blocks per construct**: `checkConsistency`, `classify`, `materialize` — allows
  independent skip markers per operation without duplicating fixture setup.
- **Turtle format throughout**: `checkConsistency` case 9 (AllDisjointClasses) in Turtle works fine;
  the hang is NTriples-specific. All new fixtures use Turtle to avoid the format-dependent hangs.
- **README update is part of this plan**: it documents parity status and must stay in sync with
  the test results.

## Dependencies / Assumptions

- Fixture Turtle files will be parsed with the existing `parseTurtle()` helper used in `issue13` tests.
- WASM binary has patches 027-029 applied (current build).

## Outstanding Questions

### Deferred to Planning

- [Affects R6-R13][Technical] Which constructs require checking all three operations vs. only two?
  For example, `owl:FunctionalProperty` on TBox only affects classify() and consistency, not
  materialize() rdf:type output. Planning should decide per-construct which stages are meaningful.
- [Affects R13][Needs research] What is the current parity status for data property hierarchy in
  `classifyProperties()`? Verify against native output before writing golden-reference assertions.
- [Affects R14-R15][Needs research] Does Konclude's native `classifyProperties()` output include
  data property subPropertyOf chains? Check native behavior before writing test assertions.

## Next Steps

-> `/ce-plan` for structured implementation planning.
