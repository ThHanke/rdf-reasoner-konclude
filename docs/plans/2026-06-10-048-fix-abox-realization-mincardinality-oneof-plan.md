---
title: "fix: ABox realization gaps — owl:minCardinality and owl:oneOf"
type: fix
status: active
date: 2026-06-10
---

# fix: ABox realization gaps — owl:minCardinality and owl:oneOf

## Overview

Two OWL 2 DL ABox realization gaps discovered during ontosphere integration testing (v0.3.0): `materialize()` produces no `rdf:type` assertions for (1) individuals satisfying `owl:minCardinality`/`owl:minQualifiedCardinality` restrictions, and (2) members of `owl:oneOf` nominal classes. Both fixes go entirely in `src/KoncludeReasoner.cpp` (`loadTripleBuffer()` + `buildInferredTripleBuffer()`), following the established plan-047 Unit 3/5 post-processing pattern. No Konclude kernel patches, no mapper changes, no reset-patches cycle needed — one WASM rebuild required for deployment.

**Prerequisite:** Plan-047 (someValuesFrom + disjointUnionOf workarounds) must be fully implemented and merged before this plan begins — this plan extends the same Impl struct, scan infrastructure, and test framework.

## Problem Frame

`materialize()` invokes Konclude's KPSet realizer, which correctly classifies TBox hierarchies and checks ABox consistency for both constructs, but does not emit `rdf:type` triples for:

- An individual with ≥N provably-distinct role fillers satisfying a `minCardinality N` restriction
- The named members of an `owl:oneOf` enumeration class

The TypeScript wrapper passes triples verbatim; the mapper already processes both constructs (`buildClassExpressions()` passes `ObjectMinCardinality` and `ObjectOneOf` to the kernel). The gap is in what the kernel emits during lazy realization — the same class of upstream limitation fixed for `someValuesFrom` (R5, plan-039/047) and `disjointUnionOf` (R6, plan-047).

## Requirements Trace

- R1. `materialize()` emits `individual rdf:type C` for every ABox individual satisfying a `minCardinality N` restriction where N provably-distinct fillers exist (proven via `owl:differentFrom` assertions)
- R2. `materialize()` emits `individual rdf:type C` for every named individual enumerated in a `owl:oneOf` definition of class C
- R3. Both workarounds add no output for `checkConsistency()` or `classify()` calls (they only add `rdf:type` triples; no existing output is changed)
- R4. `it.skip` tracking tests in `known-limitations.test.ts` are promoted to passing (or moved to `owl2dl-parity.test.ts`)
- R5. Gap matrix in `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` reflects confirmed status

## Scope Boundaries

- Only unqualified `owl:minCardinality` and `owl:minQualifiedCardinality` (with `owl:onClass`) are in scope. `owl:exactCardinality` and `owl:maxCardinality` are not addressed.
- Distinctness for minCardinality is proven only via explicit `owl:differentFrom` assertions. OWA means no inference if differentFrom is absent.
- Data property cardinality (`owl:minCardinality` on `owl:DatatypeProperty`) is out of scope — object properties only.
- `owl:oneOf` on data values (data enumerations) is out of scope.
- No changes to the Konclude kernel (vendor/) or existing patches.
- No TypeScript changes.

### Deferred to Separate Tasks

- `owl:exactCardinality` / `owl:maxCardinality` ABox realization: separate task, different semantic
- Qualified minCardinality with type inference for the qualifier (qualifier class inferred, not asserted): requires fixpoint integration with SvF loop — separate task

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp:902–927` — `disjointUnionOf` list-walk in `loadTripleBuffer()` (template for `owl:oneOf` fix, Unit 3)
- `src/KoncludeReasoner.cpp:777–928` — Batch B scan in `loadTripleBuffer()` where all workaround state is collected (use `findTerm()` lambda against `terms[]`)
- `src/KoncludeReasoner.cpp:1514–1519` — `disjointUnionOf` emission in `buildInferredTripleBuffer()` (template for `owl:oneOf` emission)
- `src/KoncludeReasoner.cpp:1530–1573` — `someValuesFrom` fixpoint (template for `minCardinality` role-assertion counting)
- `src/KoncludeReasoner.cpp:305–447` — `Impl` struct + `reset()` — add new fields here, clear in reset()
- `src/KoncludeReasoner.cpp:738–745` — `owl:differentFrom` self-clash detection (shows how diffFrom triples are read; extend to collect all pairs)
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp:1457–1461` — mapper parses `owl:oneOf` to `getObjectOneOf()` (no changes needed)
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp:1518–1599` — mapper parses cardinality to `getObjectMinCardinality()` (no changes needed)
- `tests/integration/known-limitations.test.ts:29–101` — `it.skip` tests tracking both gaps (promote to passing in Unit 4)

### Institutional Learnings

- `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md` — canonical template: Impl fields + loadTripleBuffer scan + buildInferredTripleBuffer emit
- `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` — R5 (someValuesFrom) is the closest analog; same fix shape
- `docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md` — mapper already passes both constructs; no mapper work needed
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — gap matrix to update after fix
- Memory: `librdf_model_remove_statement is ineffective` — no triple removal needed here; these workarounds only add output triples

### Key Constraint

`forRealization` flag is NOT needed to gate these workarounds — it only strips input declarations (FP/IFP case). However, both new emission blocks in `buildInferredTripleBuffer()` MUST be inside the `if (mImpl->mRealized)` guard. Without this guard, `classify()` and `checkConsistency()` (where `mRealized` is false) would still emit `rdf:type` triples from the new workaround state, violating R3. The emission is ABox-side work and only makes sense after realization confirms individual memberships.

## Key Technical Decisions

- **Fix location: `buildInferredTripleBuffer()` only, no kernel changes.** Rationale: both gaps are upstream lazy-realization limitations (same class as R5/R6 from plan-047); the mapper already passes the constructs to the kernel; no Konclude vendor patches needed. This avoids WASM rebuilds beyond the one needed to deploy.
- **`owl:oneOf` pattern: identical to `disjointUnionOf`.** Rationale: same RDF list structure, same emission shape, `rdfFirstMap`/`rdfRestMap` already populated in `loadTripleBuffer()`.
- **`owl:minCardinality` uses ABox-side counting + `owl:differentFrom` closure.** Rationale: OWA requires explicit differentFrom proof; collecting all diffFrom pairs in `loadTripleBuffer()` is O(triples) and reuses the existing single-pass scan. The post-process count is O(individuals × restrictions × fillers²) but small in practice.
- **Do not attempt librdf model removal.** Rationale: mapper also walks `CXLinker`; removal is ineffective. Not needed here anyway.
- **Native Konclude verification in Unit 1.** Rationale: confirms these are upstream limitations (PARITY GAP, not WASM regression), determines correct status label for gap matrix.

## Open Questions

### Resolved During Planning

- **Do we need Konclude kernel patches?** No — mapper already processes both constructs; gap is in lazy realization output.
- **Does `forRealization` gating apply?** No — output-synthesis workarounds are not gated on this flag.
- **Is `rdfFirstMap`/`rdfRestMap` already populated when the `owl:oneOf` scan runs?** Yes — both maps are populated in the same single-pass scan in `loadTripleBuffer()` (lines 790–827); the `owl:oneOf` scan (Batch B) runs after that pass, so the maps are available.

### Deferred to Implementation

- Exact field type for `mMinCardRestrictions` — likely `struct` with `classUri`, `propUri`, `minCard`, `qualClassUri` (empty for unqualified); finalize during implementation.
- Whether `mSvfRoleAssertions` can be reused for filler counting or a separate `mRoleAssertionMap` is cleaner — decide when reading the existing mSvfRoleAssertions key format.
- Whether qualified `owl:minQualifiedCardinality` needs the SvF fixpoint for qualifier type inference (to handle inferred qualifier types, not just asserted ones) — assess during Unit 3 implementation; MVP can start with asserted types only.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```text
loadTripleBuffer() — first scan loop (extends existing differentFrom check at lines 738-745):

  [NEW — differentFrom pairs]
  for each triple (a, owl:differentFrom, b) where a ≠ b:
    mDifferentFromPairs[aIri].insert(bIri)  // symmetric
    mDifferentFromPairs[bIri].insert(aIri)

loadTripleBuffer() — Batch B scan (after insertion loop):

  [NEW — owl:oneOf scan (Unit 3)]
  for each triple (subj, owl:oneOf, listHead) where (sId >> 30) == 0 (NamedNode):
    current = listHead
    while rdfRestMap[current] != rdf:nil IRI index:
      memberIri = terms[rdfFirstMap[current]]
      push (classIri, memberIri) → mOneOfMemberships
      current = rdfRestMap[current]

  [NEW — owl:minCardinality scan (Unit 3)]
  // svfRestBnodes already contains all owl:Restriction blank nodes
  // svfOnPropMap already maps bn → propTermIdx
  for each bn in svfRestBnodes:
    if (bn, owl:minCardinality, N) or (bn, owl:minQualifiedCardinality, N):
      N = stoi(terms[oId & 0x3FFFFFFF].ptr)  // typeTag=2 literal; value before first \0
      qual = (bn, owl:onClass, X) ? X : ""
      if (class, owl:equivalentClass, bn) or (class, owl:subClassOf, bn):
        push {classIri, svfOnPropMap[bn], N, qual} → mMinCardRestrictions

  [NEW — role assertions for minCardinality (Unit 3, unconditional)]
  for each triple (subj, prop, obj) where all three are NamedNodes:
    mMinCardRoleAssertions["subjIri\0propIri"].push_back(objIri)

buildInferredTripleBuffer() — inside if (mImpl->mRealized), after existing Units 1-3:

  [NEW — owl:oneOf emit (Unit 4)]
  for each (classIri, memberIri) in mOneOfMemberships:
    emitTriple(memberIri, rdf:type, classIri)

  [NEW — owl:minCardinality emit (Unit 4)]
  indiVec = mImpl->mOntology->getABox()->getIndividualVector(false)  // re-fetch
  for each individual I in indiVec:
    for each restriction {C, prop, N, qual} in mMinCardRestrictions:
      fillers = mMinCardRoleAssertions["Iri(I)\0prop"]
      if qual: filter fillers to ABox-asserted (X, rdf:type, qual)
      if N == 1: emit if fillers non-empty
      else: bitmask over all 2^|fillers| subsets → emit I rdf:type C if any
            size-N subset is pairwise-differentFrom
```

## Implementation Units

- [ ] **Unit 1: Native Konclude verification**

**Goal:** Confirm both gaps are upstream limitations (native Konclude v0.7.0 also omits the triples), not WASM regressions. Update gap matrix to reflect confirmed status.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`

**Approach:**
- Run the two minimal NTriples fixtures from `known-limitations.test.ts` against the native Docker image (`docker run --rm konclude/konclude:latest realization`)
- If native also omits `rdf:type` triples: label both as `UPSTREAM_LIMITATION → C++ post-process` in the gap matrix (same pattern as R5)
- If native emits them but WASM does not: escalate — this is a regression, not an upstream gap; do not proceed with post-process fix; instead investigate the realizer diff

**Test scenarios:**
- Test expectation: none — this is a research/verification unit

**Verification:**
- Gap matrix updated with confirmed status for both constructs
- If either is a WASM regression (unexpected), implementation pauses for escalation

---

- [ ] **Unit 2: Impl fields for owl:oneOf and owl:minCardinality**

**Goal:** Add all new per-call state fields to `KoncludeReasoner::Impl` and clear them in `reset()`, following the existing field pattern.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (confirms fix location)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (Impl struct at lines 305–447)

**Approach:**
- Add to `Impl`:
  - `mOneOfMemberships` — vector of `(classIri, memberIri)` string pairs
  - `mMinCardRestrictions` — vector of structs with fields: `classIri`, `propIri`, `minCard` (int), `qualClassIri` (empty string = unqualified). Use `Iri` suffix consistently (not `Uri`).
  - `mDifferentFromPairs` — `unordered_map<string, unordered_set<string>>` (symmetric: a→b and b→a)
  - `mMinCardRoleAssertions` — `unordered_map<string, vector<string>>` keyed by `"subj\0prop"` (same encoding as `mSvfRoleAssertions`). Populated **unconditionally** for all object-property assertions — NOT inside the `if (!mImpl->mSvfIndex.empty())` guard that gates `mSvfRoleAssertions`. This is required because a minCardinality fixture with no `someValuesFrom` will have an empty `mSvfIndex`, making `mSvfRoleAssertions` empty.
- Extend `reset()` at lines 439–445 to clear all four new fields

**Patterns to follow:**
- `mDisjointUnionOf` field definition and reset (existing Unit 3 field)
- `mSvfIndex`, `mSvfRoleAssertions`, `mSvfABoxTypes` field definitions (existing Unit 2/5 fields)

**Test scenarios:**
- Test expectation: none — no behavior change; verified by Unit 4 running cleanly

**Verification:**
- `make build` compiles without errors; all existing tests still pass

---

- [ ] **Unit 3: loadTripleBuffer() scan for owl:oneOf and owl:minCardinality**

**Goal:** Extend the Batch B scan in `loadTripleBuffer()` to populate the new Impl fields.

**Requirements:** R1, R2

**Dependencies:** Unit 2

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (lines 777–928, Batch B scan)

**Approach:**

*owl:oneOf scan:*
- Scan for triples where predicate = `owl:oneOf` IRI index and `(sId >> 30) == 0` (typeTag 0 = NamedNode subject — use bit-tag check, not `_:` string prefix; matches `disjointUnionOf` scan at line 906)
- Walk `rdfFirstMap`/`rdfRestMap` to enumerate list members; terminate when `rdfRestMap[current]` equals the `rdf:nil` IRI index (same termination as `disjointUnionOf` list walk at line 918)
- Push each `(classIri, memberIri)` pair to `mOneOfMemberships`

*owl:minCardinality scan:*
- minCardinality restriction blank nodes are `owl:Restriction`-typed and already appear in `svfRestBnodes` (set populated at lines ~800–860 for all `owl:Restriction` blank nodes). Reuse `svfOnPropMap` (`bn → propTermIdx`) — already built from `(bn, owl:onProperty, prop)` triples in the same Batch B loop — to look up property without a second pass.
- Scan for `(bn, owl:minCardinality, N)` and `(bn, owl:minQualifiedCardinality, N)` triples where object has typeTag=2 (literal). Extract integer N: `std::stoi(terms[oId & 0x3FFFFFFFu].ptr)` — the literal value is encoded as `value\0datatype\0` in the intern table; `stoi` stops at the first non-digit (lines 542–568 show the literal encoding format).
- For qualified: also scan `(bn, owl:onClass, qual)` to get the qualifier class IRI index
- Scan for `(class, owl:equivalentClass, bn)` and `(class, owl:subClassOf, bn)` to link named classes to their restriction blank nodes; join using `svfOnPropMap` and cardinality map keyed on bn encoded ID
- For each linked restriction, push to `mMinCardRestrictions`
- Separately, populate `mMinCardRoleAssertions` unconditionally (outside the `if (!mImpl->mSvfIndex.empty())` guard): for every triple `(subj, prop, obj)` where all three are NamedNodes, push `obj` IRI to `mMinCardRoleAssertions["subjIri\0propIri"]`

*owl:differentFrom extension:*
- Extend the first-scan-loop at lines 738–745 (NOT Batch B) to collect all `(a, owl:differentFrom, b)` pairs where `a ≠ b` into `mDifferentFromPairs` (symmetric: insert both directions). `mDifferentFromPairs` is an Impl field (cleared in `reset()`) — the analog of `mEquivPropPairs` which is also populated in the first loop and consumed in `buildInferredTripleBuffer`.
- `owl:AllDifferent` handling: out of scope for MVP. Only direct `owl:differentFrom` pairs collected.

**Patterns to follow:**
- `disjointUnionOf` list-walk scan (lines 902–927) — direct template: bit-tag check, rdfFirstMap/rdfRestMap walk, rdf:nil termination
- `svfRestBnodes` + `svfOnPropMap` (lines 800–860) — blank-node restriction pattern; minCard blank nodes are already in this set
- First-scan-loop differentFrom detection (lines 738–745) — extend to populate `mDifferentFromPairs`
- `mEquivPropPairs` field — pattern for Impl field populated in first-scan-loop, consumed in `buildInferredTripleBuffer`

**Test scenarios:**
- Test expectation: none for this unit alone — behavior verified end-to-end in Unit 4

**Verification:**
- `make build` compiles without errors; existing tests pass

---

- [ ] **Unit 4: buildInferredTripleBuffer() emission + test promotion**

**Goal:** Emit the new `rdf:type` triples in `buildInferredTripleBuffer()` and promote the `it.skip` tracking tests to active passing tests.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 3

**Files:**
- Modify: `src/KoncludeReasoner.cpp` (lines 1511–1573, after existing Units 1–3 post-processing)
- Modify: `tests/integration/known-limitations.test.ts` (remove `it.skip`, add assertions)
- Create or Modify: `tests/integration/owl2dl-parity.test.ts` (optionally move promoted tests here)

**Approach:**

*Emission guard:* Both new emission blocks MUST be inside (or immediately after) `if (mImpl->mRealized)` — same guard as the existing ABox block at line 1254. Without this guard, `classify()` and `checkConsistency()` calls (where `mRealized` is false) would still emit `rdf:type` triples from `mOneOfMemberships` / `mMinCardRestrictions`, violating R3.

*owl:oneOf emission:*
- Inside `if (mImpl->mRealized)`, after existing Unit 3 (disjointUnionOf) block, iterate `mOneOfMemberships`
- For each `(classIri, memberIri)`: call `emitTriple(memberIri, rdf_type_idx, classIri)` (using existing `emitTriple` helper and intern table)
- No deduplication needed beyond the existing `emittedTriples` set that `emitTriple` already consults

*owl:minCardinality emission:*
- Inside `if (mImpl->mRealized)`, after the owl:oneOf block
- Re-fetch `indiVec` from `mImpl->mOntology->getABox()->getIndividualVector(false)` — the `indiVec` variable declared at line 1273 is out of scope here; re-fetch using the same two-line pattern
- For each individual I in `indiVec` and each restriction `{C, prop, N, qual}` in `mMinCardRestrictions`:
  - Collect fillers from `mMinCardRoleAssertions["Iri(I)\0propIri"]`
  - If qualified: filter fillers to those with an ABox-asserted `(X, rdf:type, qual)` triple (asserted types only; inferred not considered for MVP)
  - **N=1 special case:** if N=1 and fillers is non-empty, emit immediately (no differentFrom check needed)
  - **N≥2:** find the largest subset of fillers that are pairwise-differentFrom using exhaustive bitmask: iterate all `2^|fillers|` subsets, check each for pairwise membership in `mDifferentFromPairs`; emit if any subset of size ≥ N is found. Feasible and correct for |fillers| ≤ 16; for |fillers| > 16, use greedy approximation and log a warning.
  - If `distinct_count >= N`: emit `I rdf:type C`

*Test promotion:*
- In `known-limitations.test.ts`: remove `it.skip` from both minCardinality and oneOf tests; add `expect(daveIsTeamLead).toBe(true)` / `expect(aliceTyped).toBe(true)` assertions

**Patterns to follow:**
- `disjointUnionOf` emission block (lines 1514–1519) — direct template for oneOf emission
- `someValuesFrom` fixpoint block (lines 1530–1573) — template for minCardinality iteration loop
- Existing `emitTriple()` call signature and intern table usage throughout the function

**Test scenarios:**
- Happy path (owl:oneOf): `alice` and `dave` typed as `ex:LeadershipTeam` after `materialize()`
- Happy path (minCardinality 2, unqualified): `dave` with 2 differentFrom-proven `ex:manages` fillers typed as `ex:TeamLead`
- Happy path (minQualifiedCardinality 2, qual=owl:Thing): same as above (owl:Thing matches all individuals)
- Edge case (minCardinality 2, only 1 filler): no `rdf:type` emitted
- Edge case (minCardinality 2, 2 fillers but no differentFrom): no `rdf:type` emitted (cannot prove distinctness)
- Edge case (minCardinality 2, 2 fillers, differentFrom asserted): `rdf:type` emitted
- Edge case (owl:oneOf with single member): member is typed as the class
- R3 regression (owl:oneOf): `classify()` on LeadershipTeam fixture → no `ex:alice rdf:type ex:LeadershipTeam` in output (only TBox subClassOf edges)
- R3 regression (minCardinality): `classify()` on TeamLead fixture → no `ex:dave rdf:type ex:TeamLead` in output
- R3 regression (checkConsistency): `checkConsistency()` on both fixtures returns consistent result with no `rdf:type` triples for the workaround classes
- Integration: existing `owl2dl-parity.test.ts` suite still fully passes (no regressions in R5–R8d)

**Verification:**
- `npm test` passes with both formerly-skipped tests now in the passing count
- Test count increases by at least 2 (or N if sub-cases added)

---

- [ ] **Unit 5: Documentation update**

**Goal:** Update the gap matrix and workaround migration pattern doc to reflect the two new fixes.

**Requirements:** R5

**Dependencies:** Unit 4

**Files:**
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Modify: `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`

**Approach:**
- Add rows to gap matrix: `owl:minCardinality → ABox rdf:type` and `owl:oneOf → ABox rdf:type`, both `UPSTREAM_LIMITATION → C++ post-process (plan-048)`
- Add rows to workaround migration table: R7 (oneOf), R8 (minCardinality), describing the Impl field, load-scan, and emit-step

**Test scenarios:**
- Test expectation: none — documentation

**Verification:**
- Both docs updated; `trunk check` passes on modified files

## System-Wide Impact

- **Interaction graph:** `buildInferredTripleBuffer()` is called only from `getInferredTripleBuffer()` after realization completes. No callbacks, no middleware affected.
- **Error propagation:** If `owl:oneOf` list is malformed (no `rdf:first`/`rdf:rest` entries), `mOneOfMemberships` remains empty — no output, no crash.
- **State lifecycle risks:** All new Impl fields cleared in `reset()`. No cross-call contamination.
- **API surface parity:** Both new emission blocks are gated on `mImpl->mRealized`. `classify()` and `checkConsistency()` leave `mRealized` false, so the new `rdf:type` triples are never emitted in those paths. Only `materialize()` is affected. (R3)
- **Integration coverage:** Existing regression suite (`owl2dl-parity.test.ts`, `property-characteristics.test.ts`) must pass unchanged.
- **Unchanged invariants:** TBox classification output (subClassOf, equivalentClass edges) is not modified. BackendAssCache is not touched. All existing workarounds (Units 1–3 in buildInferredTripleBuffer) are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Native Konclude emits the triples (gap is WASM regression, not upstream limitation) | Unit 1 catches this before any C++ changes; escalate to deeper investigation |
| Qualified minCardinality with inferred qualifier type (not just asserted) misses cases | Documented as out-of-scope; asserted-only covers the MVP use case |
| Pairwise-distinct counting false-negative for N>2 with partial differentFrom | Bitmask exhaustive check is correct for N≤5, filler-count≤16; greedy + warning for larger sets |
| WASM rebuild takes 20–30 min | Run `make test` (TS-only) first to validate logic; rebuild only once before final verification |

## Sources & References

- Related code: `src/KoncludeReasoner.cpp` (loadTripleBuffer, buildInferredTripleBuffer, Impl struct)
- Related plan: `docs/plans/2026-06-10-047-refactor-move-ts-owl-workarounds-to-cpp-plan.md` (plan-047, same fix pattern)
- Institutional: `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`
- Tracking tests: `tests/integration/known-limitations.test.ts`
- Gap matrix: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
