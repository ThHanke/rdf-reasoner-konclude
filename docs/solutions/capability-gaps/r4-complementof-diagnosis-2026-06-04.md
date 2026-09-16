---
module: capability-gaps
tags: [complementOf, consistency, js-pre-process, native-bug, parity]
problem_type: gap-analysis
date: 2026-06-04
---

# R4 complementOf ABox Clash — Diagnosis and JS Pre-Process Fix

## Summary

`owl:complementOf` between two named classes with an individual typed as both is not
detected as a clash by native Konclude v0.7.0. This is a native reasoner bug. The fix
is implemented as a JS pre-process in `ts/index.ts` that short-circuits before the WASM
call when the pattern is detected.

## Native Behaviour

**Command:** `consistency -i /data/complement-abox.nt`

**Input fixture:**
```ntriples
<http://example.org/complement-test> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .
<http://example.org/Pos> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Neg> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Pos> <http://www.w3.org/2002/07/owl#complementOf> <http://example.org/Neg> .
<http://example.org/posNeg> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/posNeg> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Pos> .
<http://example.org/posNeg> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Neg> .
```

**Native output (stdout):**
```
{info} >> Ontology '/data/complement-abox.nt' is consistent.
```

**Result:** CONSISTENT — **wrong**. An individual simultaneously typed as `Pos` and
`Neg` where `Pos owl:complementOf Neg` entails `Neg ≡ ¬Pos`, so the individual is in
`Pos ∩ ¬Pos = ∅`. The correct answer is INCONSISTENT.

## TBox-Only Classification (no ABox individuals)

**Input:** same ontology with `ex:posNeg` triples removed.

**Result:** native classification succeeds. `Pos` and `Neg` are both `subClassOf owl:Thing`.
This is correct — the axiom `Pos complementOf Neg` makes them disjoint but neither
becomes a subclass of `owl:Nothing` without additional axioms.

## Plan-039 C++ Fix Attempt

Plan-039 attempted a C++ patch that translated `A owl:complementOf B` into an explicit
`DisjointWith` axiom during mapper preprocessing (`mapTriples()`). The patch caused a
TBox regression: classification tests for ontologies containing `complementOf` began
emitting incorrect `SubClassOf(A, owl:Nothing)` inferences because the translated axiom
interacted with the saturation pipeline outside the ABox context and incorrectly
concluded that the complement class expression was unsatisfiable.

The C++ approach was abandoned. This document records that the JS pre-process is the
correct fix location for this specific pattern.

## Fix: JS Pre-Process in `ts/index.ts`

The fix is implemented in `checkConsistency()` immediately after the existing
`owl:differentFrom` reflexive clash short-circuit (line ~607).

**Pattern detected:**
1. Scan quads for `A owl:complementOf B` where both `A` and `B` are `NamedNode`s
   (anonymous complements/restrictions are intentionally skipped — the WASM kernel
   handles those correctly via different tableau rules).
2. Build a map of `individual → Set<classIRI>` from all `rdf:type` assertions where
   both subject and object are `NamedNode`s.
3. For each complement pair `(A, B)`: if any individual is typed as both `A` and `B`,
   return `{ consistent: false }` immediately without calling WASM.

**Scope limitation (intentional):** blank-node complement objects (anonymous class
expressions such as restrictions) are excluded. Those follow a different code path in
the Konclude kernel that works correctly.

**Cache:** the short-circuit result is stored in `_consistencyCache` when a fingerprint
is available (Store-based calls), matching the existing cache pattern.

## Test Result

Activating the previously-skipped test `checkConsistency: individual in class ∩
complementOf(class) → false` causes the test to pass. Full suite: **314 passing / 9
skipped** (up from 313/10).

## Files Changed

- `ts/index.ts` — added `OWL_COMPLEMENT_OF` constant; added complementOf ABox clash
  pre-process in `checkConsistency()`
- `tests/integration/owl2dl-parity.test.ts` — activated the previously-skipped test
  (removed `it.skip`, updated test name to remove UPSTREAM_LIMITATION label)
