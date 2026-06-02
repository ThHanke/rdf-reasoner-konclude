---
date: 2026-06-02
topic: axiom-api-integration-tests
---

# Axiom API Integration Tests

## Problem Frame

Four shipped API methods — `isEntailed()`, `whatIf()`, `explain()`, `explainInconsistency()` — have
zero integration coverage against real WASM. `validate()` and `classifyProperties()` have only unit
tests with mocked workers. Sequential calls (call classify, then materialize on the same instance)
have no explicit state-isolation tests. This is a correctness risk for shipped features.

## Requirements

**isEntailed()**

- R1. `isEntailed(quads)` returns `true` for entailments derivable from `classify()` output —
  e.g. `[alice, rdf:type, Person]` is entailed when Alice is a parent and Parent ⊑ Person.
- R2. `isEntailed(quads)` returns `false` for triples not entailed.
- R3. `isEntailed(quads)` works for object property assertions — e.g. `[alice, hasAncestor, eve]`
  via transitive property chain.

**whatIf()**

- R4. `whatIf(additionalQuads)` returns the delta (new entailments introduced by adding quads) — does not
  mutate the reasoner's base state; subsequent calls without whatIf return original results.
- R5. `whatIf(additionalQuads)` with a contradicting triple returns `isConsistent: false`.
- R6. `whatIf()` chaining — calling `whatIf` twice on the same base produces independent results.

**explain() and explainInconsistency()**

- R7. `explain(subject, predicate, object)` returns a non-empty HSDAG for an entailed triple on
  a real ontology (Roberts Family or pizza fixture).
- R8. `explainInconsistency()` returns a non-empty explanation on an inconsistent ontology (e.g.
  `issue13` case 1 fixture — `owl:disjointWith` violation).
- R9. `explain()` on a non-entailed triple throws or returns an empty/null result (documented
  behavior, whichever the implementation produces).

**validate()**

- R10. `validate(quads)` returns no violations for a well-formed ontology (pizza or Roberts).
- R11. `validate(quads)` returns violations for a known-invalid ontology.

**Sequential call state isolation**

- R12. Calling `classify()` then `materialize()` on the same RdfReasoner instance produces correct
  results for both — no cross-contamination from internal cache state.
- R13. Calling `checkConsistency()` then `classify()` on the same instance produces correct results.
- R14. Calling `whatIf()` does not affect subsequent `classify()` or `materialize()` results.

## Success Criteria

- All R1–R14 pass as active (non-skipped) integration tests against real compiled WASM.
- Zero mocked worker calls in the new test file.
- Running `npm test` includes the new tests in the 21-file suite.

## Scope Boundaries

- Only the four shipped axiom API methods + validate + sequential call isolation.
- No new WASM kernel changes — tests verify existing behavior.
- `classifyProperties()` data property tests are in the sibling plan (011).
- Performance / timing characteristics are out of scope.
- Browser integration is out of scope — the existing browser tests cover basic classify/materialize.

## Key Decisions

- **Use Roberts Family as primary fixture**: it has rich ABox + TBox, supports all three operations,
  and has confirmed golden-reference parity. Pizza is the secondary fixture for explain tests.
- **New test file `tests/integration/axiom-api.test.ts`**: keeps concerns isolated from existing
  per-feature files.
- **State isolation tests use a single shared `RdfReasoner` instance per describe block**: validates
  that the caching and reset mechanics work correctly across operation types.

## Dependencies / Assumptions

- WASM binary is compiled (current build has patches 027-029 applied).
- `whatIf()` contract is documented: returns delta quads and does not mutate base state. Verify
  against current implementation before writing tests.

## Outstanding Questions

### Deferred to Planning

- [Affects R4-R6][Technical] What does `whatIf()` currently return — a full new result set, a
  delta, or a diff object? Confirm the TypeScript return type before writing test assertions.
- [Affects R7-R9][Needs research] What does `explain()` return when the triple is not entailed —
  throws, returns null, or returns empty HSDAG? Confirm from implementation before adding R9 test.

## Next Steps

-> `/ce-plan` for structured implementation planning.
