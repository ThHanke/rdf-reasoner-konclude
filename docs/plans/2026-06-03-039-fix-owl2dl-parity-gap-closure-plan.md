---
title: "fix: OWL 2 DL parity gap closure — post-038 UPSTREAM_LIMITATION backlog"
type: fix
status: active
date: 2026-06-03
---

# fix: OWL 2 DL parity gap closure — post-038 UPSTREAM_LIMITATION backlog

## Overview

Addresses the 10 `UPSTREAM_LIMITATION` gaps discovered during plan-038 (unified OWL 2 DL
parity test suite). Fixes are organized into four categories by complexity and rebuild
cost. One gap (EquivalentObjectProperties → `classifyProperties`) is fixable immediately
in the TypeScript layer with no WASM rebuild. Five gaps require native binary investigation
before patching. Four gaps are confirmed native Konclude v0.7.0 bugs and are deferred.

## Problem Frame

Plan-038 produced `tests/integration/owl2dl-parity.test.ts` with 306 passing tests and
16 `it.skip` blocks. Of the 16 skips, 10 are UPSTREAM_LIMITATION markers covering:
- 3 blank-node `materialize()` hangs (AllDisjointClasses, disjointUnionOf, NPA)
- 2 ALIF+ precompute hangs (FunctionalProperty, InverseFunctionalProperty)
- 3 ABox inconsistency detection gaps (complementOf, differentFrom-self, AllDisjointProperties ABox)
- 2 classification/materialization output gaps (EquivalentObjectProperties, disjointUnionOf classify)
- 1 materialize output gap (someValuesFrom filler typing)

Each gap represents a construct where OWL 2 DL semantics require an entailment (or
inconsistency detection) that Konclude v0.7.0 does not produce. Previous plans (035–036)
fixed 5 upstream bugs; this plan closes the remaining backlog.

## Requirements Trace

- R1. `EquivalentObjectProperties owl:equivalentProperty` → `classifyProperties()` emits bidirectional `rdfs:subPropertyOf`
- R2. `AllDisjointProperties` ABox clash detected in `checkConsistency()`
- R3. `owl:differentFrom` reflexive self-reference (`a owl:differentFrom a`) → inconsistent
- R4. `owl:complementOf` between two named classes with ABox clash → inconsistent
- R5. `owl:someValuesFrom` materialize: filler type propagated (`y rdf:type C` when `x:∃p.C, p(x,y)`)
- R6. `owl:disjointUnionOf` → `classify()` emits `A rdfs:subClassOf C` for each union member
- R7. `owl:AllDisjointClasses`, `owl:disjointUnionOf`, `owl:NegativePropertyAssertion` → `materialize()` works without hang (currently confirmed native Konclude bug — deferred)
- R8. `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` → all operations without ALIF+ hang (confirmed native Konclude bug — deferred)

## Scope Boundaries

- WASM binary ABI: unchanged — no new public WASM exports
- `RdfReasoner` TypeScript API: unchanged (R1 fix is internal to the worker pipeline)
- README update: deferred to a separate documentation-only task

### Deferred to Separate Tasks

- **R7 blank-node materialize() hangs** (Category A): confirmed native Konclude v0.7.0 limitation — the realization pipeline hangs for AllDisjointClasses, disjointUnionOf, and NPA on consistent ontologies. Requires deep realization kernel investigation beyond the scope of this plan.
- **R8 ALIF+ precompute hangs** (Category B): confirmed native Konclude v0.7.0 limitation — FunctionalProperty + ABox + sameAs inference triggers an infinite loop in `CCalculationTableauApproximationSaturationTaskHandleAlgorithm`. Cannot be fixed without upstream kernel changes.
- **README coverage table update**: separate documentation PR after all parity fixes land.

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp::buildPropertyTripleBuffer()` — emits Hasse-diagram `rdfs:subPropertyOf` edges; uses `node->getEquivalentRoleStringList(false)` + picks lex-min representative. **Gap**: equivalent IRIs in the same node get no subPropertyOf edge between them.
- `ts/index.ts` — `classifyProperties(quads)` assembles quads, calls worker, returns result. **Fix point for R1**: post-process result quads using the original input quads to add bidirectional subPropertyOf for each `owl:equivalentProperty` pair.
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp::initializeRoleAssertions()` — saturation clash detection. Patches 028 and 029 were applied here. **Fix point for R2 and R3**.
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp::buildSeparateNodeBasedAxioms()` — maps AllDisjointProperties, AllDisjointClasses, NPA blank-node walking. Source of Category A data flows.
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp::buildDisjointUnionConceptClass()` (line ~1870) — builds `C ≡ A⊔B` union axiom. **Investigate point for R6** — does not emit pairwise disjointness; whether A⊑C is derived from the union encoding is unknown without native testing.
- `patches/028-irreflexive-asymmetric-saturation-clash.patch` — model patch for R2/R3 (adds clash checks in `initializeRoleAssertions()`). **Pattern for AllDisjointProperties ABox and differentFrom-self fixes**.
- `patches/029-alldisjointproperties-equivalentproperties-clash.patch` — model patch for property-disjointness clash. **Pattern for AllDisjointProperties ABox fix**.
- `scripts/generate-patches.sh` → `patches/*.patch` → `make patches` — patch workflow.
- `tests/integration/owl2dl-parity.test.ts` — test file with all UPSTREAM_LIMITATION `it.skip` blocks to be activated as gaps are fixed.
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — authoritative gap matrix.

### Institutional Learnings

- Saturation patch placement: role-axiom-based clash checks must go **before** the `othIndiNode` initialized branch in `initializeRoleAssertions()`, not inside it. (See `feedback_saturation_patch_placement.md`.)
- Patch sentinel: delete `vendor/konclude/.patches-applied` before docker rebuild when new patches were added; CMake silently skips re-application otherwise. (See `feedback_wasm_rebuild_sentinel.md`.)
- Every WASM rebuild takes 20–30 min; verify fixes with native binary first to avoid wasted cycles.
- Native verification workflow: `docker run --rm konclude/konclude:latest <cmd> -i <input.nt>` or pipe NTriples via stdin.
- Patches 025–029 provide the reference pattern: edit `vendor/konclude/` directly → run `scripts/generate-patches.sh` → commit resulting `patches/*.patch` files.

## Key Technical Decisions

- **R1 (EquivalentObjectProperties) fixed in TypeScript, not C++**: `owl:equivalentProperty` axioms in the input quads already convey the bidirectional subPropertyOf semantics. Post-processing the `classifyProperties()` output in `ts/index.ts` by scanning input quads for `owl:equivalentProperty` and adding both directions of `rdfs:subPropertyOf` is correct, fast (no WASM rebuild), and transparent. The WASM property hierarchy already groups equivalent properties into one node — this completes the public API contract.

- **Categories C and D (gaps R2–R6) gated behind native investigation**: Before writing any patch, run each failing case through the native Konclude binary (`docker run --rm konclude/konclude:latest`). If native also fails, the gap is a kernel bug — patch in saturation algorithm or completion algorithm. If WASM fails but native passes, the gap is a WASM-layer regression — investigate `src/` or mapper first. Native investigation is unit 2 and gates units 3–7.

- **AllDisjointProperties ABox clash (R2) expected in `initializeRoleAssertions()`**: Patch 029 added EquivalentObjectProperties + disjointness clash detection before the `othIndiNode` branch. The pure ABox AllDisjointProperties clash (two individuals with both `p(a,b)` and `q(a,b)` where DisjointProperties(p,q)) follows the same pattern: scan `role->getDisjointRoleList()` at assertion time. Expected fix point: same location as patch 029.

- **Category A and B marked deferred, not removed**: The `it.skip` blocks remain in `owl2dl-parity.test.ts`. Their UPSTREAM_LIMITATION comments will be updated to reference this plan as the tracker.

- **No new WASM API surface**: All fixes either happen in `ts/index.ts` (post-processing) or in existing C++ methods (no new Embind exports needed).

## Open Questions

### Resolved During Planning

- **Is EquivalentObjectProperties fixable without WASM rebuild?** Yes — TypeScript post-processing on input quads and output quads. (See Key Technical Decisions.)
- **Are Category A and B fixable?** No — both are confirmed native Konclude v0.7.0 bugs. Deferred.
- **What is the fix point for AllDisjointProperties ABox clash?** `initializeRoleAssertions()` before the `othIndiNode` branch — same as patches 028 and 029.

### Deferred to Implementation

- **Is `a owl:differentFrom a` a native Konclude bug?** Must verify with native binary (unit 2). If native also misses it, patch to ABox axiom preprocessing or saturation clash check.
- **Does native Konclude emit `A rdfs:subClassOf C` for `disjointUnionOf`?** Must verify with native binary (unit 2). If native emits it and WASM doesn't, root cause is in mapper or taxonomy output. If native also misses it, consider JS post-processing (scan `owl:disjointUnionOf` quads and add subClassOf edges).
- **Does native propagate someValuesFrom filler types?** Must verify with native binary (unit 2). The completion algorithm handles existential propagation in `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`. If native propagates it, gap is in realization pipeline output.
- **Does `owl:complementOf` between named classes require completion algorithm patch?** Saturation algorithm (nominal individuals) handles ABox clash. If a named-class complementOf assertion does not fire in saturation, the completion algorithm path for ABox individuals may be needed — harder to patch.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not
> code to reproduce.*

### Fix strategy by gap

| Gap | Category | Fix layer | Rebuild? | Gate |
|-----|----------|-----------|----------|------|
| EquivalentObjectProperties → classifyProperties | D | TypeScript (ts/index.ts) | No | — |
| AllDisjointProperties ABox clash | C | C++ patch (vendor/konclude) | Yes | Unit 2 investigation |
| differentFrom reflexive | C | C++ patch (vendor/konclude) | Yes | Unit 2 investigation |
| complementOf named-class ABox clash | C | C++ patch (vendor/konclude) | Yes | Unit 2 investigation |
| someValuesFrom filler type | D | C++ patch or realization pipeline | Yes | Unit 2 investigation |
| disjointUnionOf → classify A⊑C | D | C++ patch or JS post-process | Maybe | Unit 2 investigation |
| AllDisjointClasses materialize hang | A | Deferred — native Konclude bug | — | — |
| disjointUnionOf materialize hang | A | Deferred — native Konclude bug | — | — |
| NPA materialize hang | A | Deferred — native Konclude bug | — | — |
| FunctionalProperty / IFP ALIF+ hang | B | Deferred — native Konclude bug | — | — |

### Phased dependency graph

```
Unit 1 (TS fix, no rebuild) → independent

Unit 2 (native investigation)
  → Unit 3 (AllDisjointProperties ABox patch)
  → Unit 4 (differentFrom reflexive patch)
  → Unit 5 (complementOf named-class patch)
  → Unit 6 (someValuesFrom filler type patch)
  → Unit 7 (disjointUnionOf classify patch)

All units → Unit 8 (test activation + docs update)
```

## Phased Delivery

### Phase 1 — TypeScript quick win (no WASM rebuild)

Unit 1: Fix EquivalentObjectProperties → `classifyProperties()` in `ts/index.ts`. Delivers R1.

### Phase 2 — Native binary investigation sweep

Unit 2: Run all 8 remaining gaps through native binary. Documents which are native bugs (deferred), which are WASM regressions (higher priority), and which path each fix should take. Required before any C++ work.

### Phase 3 — C++ patches (per gap, dependent on unit 2)

Units 3–7 are conditional on unit 2 findings. Each is one atomic patch + WASM rebuild + test activation. Order by expected difficulty: AllDisjointProperties (easiest, same pattern as 029) → differentFrom-self → complementOf → someValuesFrom → disjointUnionOf.

### Phase 4 — Documentation and it.skip activation

Unit 8: For each fixed gap, replace `it.skip` with active `it` in `owl2dl-parity.test.ts`. Update `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`. Update memory `project_owl2dl_parity_gaps.md`.

## Implementation Units

---

- [ ] **Unit 1: Fix EquivalentObjectProperties → classifyProperties() in TypeScript**

**Goal:** `classifyProperties()` emits `p rdfs:subPropertyOf q` and `q rdfs:subPropertyOf p` for each `owl:equivalentProperty` pair in the input quads.

**Requirements:** R1.

**Dependencies:** None.

**Files:**
- Modify: `ts/index.ts`
- Test: `tests/integration/owl2dl-parity.test.ts` (activate the two it.skip blocks for EquivalentObjectProperties)

**Approach:**
- In `ts/index.ts`, after receiving the `classifyProperties()` result quads from the worker, post-process: scan the original input `Iterable<Quad>` for triples with predicate `owl:equivalentProperty`. For each `A owl:equivalentProperty B` triple found, append `A rdfs:subPropertyOf B` and `B rdfs:subPropertyOf A` to the result using `DataFactory.quad(...)`.
- Input quads must be collected once (materialize the iterable) before calling the worker, so they are available for both the WASM call and the post-processing step.
- The added triples should use `DataFactory.defaultGraph()` as the graph term (consistent with existing output).
- This fix is semantically correct: `owl:equivalentProperty` axioms in OWL 2 DL entail bidirectional subPropertyOf.

**Patterns to follow:**
- `ts/index.ts` existing method structure for `classifyProperties()`
- `tests/integration/classify-properties.test.ts` for the test pattern

**Test scenarios:**
- Happy path: `p owl:equivalentProperty q` in input → both `p rdfs:subPropertyOf q` and `q rdfs:subPropertyOf p` present in `classifyProperties()` result
- Happy path: non-equivalent properties are unaffected — no spurious edges added
- Edge case: no `owl:equivalentProperty` triples in input → result unchanged
- Edge case: `A owl:equivalentProperty B` AND `B owl:equivalentProperty A` both in input (redundant) → deduplicate output (no duplicate triples)
- Integration: activate the two `it.skip` blocks for EquivalentObjectProperties in `owl2dl-parity.test.ts` — they must pass

**Verification:**
- `npm run build` compiles without errors.
- `npm test` passes with the two EquivalentObjectProperties `it.skip` blocks replaced by active `it`.

---

- [ ] **Unit 2: Native binary investigation sweep**

**Goal:** For each of the 8 remaining UPSTREAM_LIMITATION gaps (R2–R6 + Categories A and B), run the native Konclude binary to determine: (a) is the gap native or WASM-specific? (b) what is the expected native output? (c) which fix path is viable?

**Requirements:** Gates R2–R6 fixes; establishes authoritative baseline for what native Konclude emits.

**Dependencies:** Unit 1 (can proceed independently but logically follows Phase 1).

**Files:**
- Create: `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` — investigation log

**Approach:**

For each gap, prepare a minimal NTriples input and run:
```
docker run --rm konclude/konclude:latest realize -i /dev/stdin <<< "..."
```
or classify/consistency equivalents. Capture and record the output.

Gaps to investigate in priority order:
1. **AllDisjointProperties ABox clash** (R2): does native detect inconsistency when `p(a,b)` ∧ `q(a,b)` ∧ DisjointProperties(p,q)?
2. **differentFrom reflexive** (R3): does native detect inconsistency when `a owl:differentFrom a`?
3. **complementOf named-class ABox clash** (R4): does native detect inconsistency when individual typed both A and ¬A?
4. **someValuesFrom filler type** (R5): does native emit `y rdf:type C` when `x:∃p.C, p(x,y)` in realization output?
5. **disjointUnionOf classify A⊑C** (R6): does native emit `A rdfs:subClassOf C` in classification output?
6. **AllDisjointClasses materialize** (R7): confirm native also hangs (expected: yes).
7. **disjointUnionOf materialize** (R7): confirm native also hangs (expected: yes).
8. **FunctionalProperty ALIF+** (R8): confirm native also hangs (expected: yes).

For each gap, document in the investigation log:
- Input NTriples used
- Native output (or "hangs after N seconds")
- Fix path: "native bug — patch needed" / "native emits, WASM regression — investigate src/" / "native also misses — JS post-process option"

**Test scenarios:**
- Test expectation: none — this is a research/documentation unit. Output is the investigation log.

**Verification:**
- `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` exists with findings for all 8 gaps.
- Each gap classified as: patchable / JS-fixable / deferred.

---

- [ ] **Unit 3: AllDisjointProperties ABox clash patch (R2)**

**Goal:** `checkConsistency()` detects inconsistency when an individual is related by two properties declared in an `owl:AllDisjointProperties` axiom (e.g. `p(a,b) ∧ q(a,b)` ∧ DisjointObjectProperties(p,q)).

**Requirements:** R2.

**Dependencies:** Unit 2 investigation confirms this is patchable (native bug).

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
- Create or modify: `patches/030-alldisjointproperties-abox-clash.patch`
- Test: `tests/integration/owl2dl-parity.test.ts` (activate AllDisjointProperties ABox clash test if currently it.skip)

**Approach:**
- In `initializeRoleAssertions()`, before the `othIndiNode` initialized branch (same placement as patch 029), iterate `role->getDisjointRoleList()` (or equivalent disjoint-role linker). For each disjoint role `dRole`, check if the ABox already contains an assertion `dRole(indiNode, othIndi)`. If yes, set `INDSATFLAGCLASHED`.
- Follow the saturation patch placement rule: BEFORE the `othIndiNode` initialized branch, not inside it.
- Generate patch via `scripts/generate-patches.sh`, name it `030-alldisjointproperties-abox-clash.patch`.
- Delete `vendor/konclude/.patches-applied` before WASM rebuild.

**Execution note:** Verify fix against native binary output (from unit 2) before writing the patch. If native also misses the clash, confirm the expected fix is in the saturation algorithm. If native detects it and WASM doesn't, look in the mapper first.

**Patterns to follow:**
- `patches/029-alldisjointproperties-equivalentproperties-clash.patch` — exact same method, similar placement
- `patches/028-irreflexive-asymmetric-saturation-clash.patch` — reference for `INDSATFLAGCLASHED` usage

**Test scenarios:**
- Error path: `p(a,b) ∧ q(a,b)` where AllDisjointProperties(p,q) → `checkConsistency()` returns `false`
- Happy path: `p(a,b)` where AllDisjointProperties(p,r) with no `r` assertion → `checkConsistency()` returns `true`
- Edge case: three-way AllDisjointProperties — individual has assertions for two of them → `false`

**Verification:**
- `npm test` passes with AllDisjointProperties ABox clash test activated.
- `make build-wasm` succeeds (if WASM rebuild is needed).

---

- [ ] **Unit 4: differentFrom reflexive patch (R3)**

**Goal:** `checkConsistency()` detects inconsistency when an individual is declared different from itself (`a owl:differentFrom a`).

**Requirements:** R3.

**Dependencies:** Unit 2 investigation.

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp` (likely; confirm from unit 2)
- Create or modify: `patches/031-differentfrom-self-clash.patch`
- Test: `tests/integration/owl2dl-parity.test.ts` (activate differentFrom reflexive it.skip)

**Approach:**
- The `owl:differentFrom` axiom maps through `buildSimpleABoxAxioms()` in the mapper and `getDifferentIndividuals()` in the builder. The clash for `a owl:differentFrom a` (same individual both times) should be detected at ABox preprocessing time.
- If the fix is in the saturation algorithm: when processing a `DifferentFrom(a,a)` nominal constraint, the self-reference immediately implies a clash (a cannot be different from itself). Add this check in the saturation nominal-individual processing path.
- Alternatively, if the mapper/builder already normalizes individual-pairs, the clash check may belong in `CConcreteOntologyUpdateBuilder` — detecting same-IRI inputs to `getDifferentIndividuals`.
- Determine exact fix location from unit 2 native investigation.

**Patterns to follow:**
- `docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md` — prior differentFrom fix for context on the mapping path

**Test scenarios:**
- Error path: `a owl:differentFrom a` → `checkConsistency()` returns `false`
- Happy path: `a owl:differentFrom b` (distinct individuals) → `true`
- Edge case: AllDifferent containing only one individual (self-reference via list) → should be `true` (AllDifferent on one element is trivially consistent)

**Verification:**
- `npm test` passes with differentFrom reflexive test activated.

---

- [ ] **Unit 5: complementOf named-class ABox clash patch (R4)**

**Goal:** `checkConsistency()` detects inconsistency when an individual is typed both `A` and `B` where `A owl:complementOf B`.

**Requirements:** R4.

**Dependencies:** Unit 2 investigation (must confirm native detects this; if native also misses it, this unit may be deprioritized or deferred).

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp` or `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
- Create: `patches/032-complement-named-class-abox-clash.patch`
- Test: `tests/integration/owl2dl-parity.test.ts` (activate complementOf it.skip)

**Approach:**
- `owl:complementOf` between named classes should propagate as `A ⊑ ¬B` in the TBox. When an ABox individual is typed A and B, the clash follows from `A ⊑ ¬B` ∧ `rdf:type B`. This should fire in the completion algorithm (full tableau) for ABox individuals, not the saturation algorithm (which handles nominal approximation).
- If native Konclude also misses this, it is a deeper completeness gap in the tableau — may require understanding which tableau rules handle complement-clash propagation for named classes vs. restriction-based complements.
- If the fix is complex (completion algorithm), this unit may be deferred and documented as a known native limitation.

**Test scenarios:**
- Error path: individual typed A ∧ B, `A owl:complementOf B` → `checkConsistency()` returns `false`
- Happy path: individual typed A only with complementOf defined → `true`

**Verification:**
- `npm test` passes with complementOf named-class test activated.

---

- [ ] **Unit 6: someValuesFrom filler type propagation patch (R5)**

**Goal:** `materialize()` emits `y rdf:type C` when the input contains `x rdf:type ∃p.C` (via an equivalent-class restriction) and `p(x,y)`.

**Requirements:** R5.

**Dependencies:** Unit 2 investigation (determines whether the gap is in realization output or in the completion algorithm).

**Files:**
- Modify: `src/KoncludeReasoner.cpp::buildInferredTripleBuffer()` (if gap is in output collection) OR `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp` (if gap is in tableau propagation)
- Create: `patches/033-somevaluesfrom-filler-type.patch` (if vendor patch needed)
- Test: `tests/integration/owl2dl-parity.test.ts` (activate someValuesFrom materialize it.skip)

**Approach:**
- The OWL-DL rule: from `x: ∃p.C` and `p(x,y)`, infer `y: C`. This is the ∃-propagation rule in the tableau completion algorithm.
- If native Konclude emits `y: C` but WASM does not: the gap is in `buildInferredTripleBuffer()` — check whether the `visitAllTypes()` walk over `CConceptRealization` collects types assigned to filler individuals during realization.
- If native also misses `y: C`: the gap is in Konclude's ABox realization. Determine if the nominal-filler typing rule fires in `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`.

**Test scenarios:**
- Happy path: `x rdf:type C` where `C ≡ ∃hasFriend.Dog`; `x hasFriend y`; `y a owl:NamedIndividual` → `materialize()` returns `y rdf:type Dog`
- Edge case: multiple fillers — each gets typed
- Edge case: anonymous filler (blank node) — skip (blank nodes are dropped at serialization)

**Verification:**
- `npm test` passes with someValuesFrom materialize test activated.

---

- [ ] **Unit 7: disjointUnionOf classify A⊑C patch or JS post-process (R6)**

**Goal:** `classify()` emits `A rdfs:subClassOf C` for each member `A` of `C owl:disjointUnionOf (A B ...)`.

**Requirements:** R6.

**Dependencies:** Unit 2 investigation.

**Files:**
- Modify: `ts/index.ts` (if JS post-processing) OR `vendor/konclude/Source/...` (if kernel patch)
- Test: `tests/integration/owl2dl-parity.test.ts` (activate disjointUnionOf classify soft test, convert to hard assertion)

**Approach:**
- Two viable paths depending on unit 2 findings:
  - **Path A (JS post-processing, preferred if native also misses):** In `ts/index.ts`, after receiving `classify()` result, scan input quads for `owl:disjointUnionOf` assertions. For each `C owl:disjointUnionOf (A B ...)` RDF list, add `A rdfs:subClassOf C`, `B rdfs:subClassOf C`, etc. to the result. This is semantically correct: any member of a disjoint union is a subclass of the union class. Avoids WASM rebuild.
  - **Path B (C++ fix):** If native emits A⊑C but WASM doesn't, the gap is in the taxonomy output walker in `src/KoncludeReasoner.cpp::buildInferredTripleBuffer()`. Check if the `CTaxonomy` node for C has A as a child but the walker misses it.

**Technical design:** For Path A, iterating an RDF list (`owl:disjointUnionOf` value is a blank-node RDF list `(A B ...)`) requires walking `rdf:first`/`rdf:rest` triples in the input quads. A helper function `expandRdfList(headNode, quads)` → IRI[] is needed.

**Test scenarios:**
- Happy path: `C owl:disjointUnionOf (A B)` → `A rdfs:subClassOf C` and `B rdfs:subClassOf C` present in `classify()` result
- Happy path (existing): `classify()` still returns normal subClassOf edges for non-disjointUnion classes
- Edge case: three-member union → all three get A⊑C, B⊑C, D⊑C

**Verification:**
- `npm test` passes with disjointUnionOf classify assertion activated (converted from soft "documents result" to hard `toBe(true)` assertion).

---

- [ ] **Unit 8: Test activation, documentation update, and memory refresh**

**Goal:** Activate all fixed `it.skip` blocks, update the capability gap matrix, and refresh the parity gap memory entry.

**Requirements:** All completed R1–R6 requirements reflected in test results. Confirmed deferred gaps documented.

**Dependencies:** All preceding units (run last).

**Files:**
- Modify: `tests/integration/owl2dl-parity.test.ts` (convert `it.skip` → `it` for each fixed gap)
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Modify: memory `project_owl2dl_parity_gaps.md`

**Approach:**
- For each fixed gap: find the `it.skip` block, remove `skip`, remove the `UPSTREAM_LIMITATION` prefix from the test name, remove the 30 000 ms timeout (or keep if the test is genuinely slow), update the preceding comment block.
- Update the capability gap matrix: move fixed rows from "DOES NOT WORK" to "WORKS". Add a note for each deferred row with this plan as the tracker.
- Update memory to reflect current parity state.

**Test scenarios:**
- Integration: `npm test` passes with all activated tests (0 new failures).
- Integration: the count of `it.skip` in `owl2dl-parity.test.ts` decreases by the number of fixed gaps.

**Verification:**
- `npm test` green with reduced skip count.
- Capability gap matrix is accurate and current.

---

## System-Wide Impact

- **Interaction graph:** `ts/index.ts` changes (units 1 and 7 Path A) affect the `classifyProperties()` and `classify()` public API output. The change is additive — existing callers get more correct output, never less.
- **Error propagation:** C++ patches follow the existing crash-flag pattern (`INDSATFLAGCLASHED`). No new error types introduced.
- **State lifecycle risks:** `initializeRoleAssertions()` patches follow the established saturation-state pattern. No new singleton cache interaction.
- **API surface parity:** No new WASM Embind exports. No TypeScript type signature changes.
- **Integration coverage:** Each fixed gap is verified by activating the corresponding `it.skip` block in `owl2dl-parity.test.ts` — full WASM stack tested.
- **Unchanged invariants:** Existing 306 passing tests must remain green after each unit.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Native investigation reveals Category C gaps are native bugs (unfixable in scope) | Med | Med | Units 3–5 are gated on unit 2 findings; plan explicitly scopes to "patchable" gaps only |
| WASM rebuild breaks existing tests | Low | High | Run `npm test` after each rebuild before activating new tests |
| Patch sentinel forgotten → patches not applied | Low | High | Document as explicit step; `feedback_wasm_rebuild_sentinel.md` is authoritative |
| Saturation patch placement wrong → incorrect clash detection | Low | High | Follow saturation patch placement rule from `feedback_saturation_patch_placement.md`; test with multiple positive and negative cases |
| JS post-processing (units 1, 7) adds duplicate triples | Low | Med | Deduplicate before appending; unit tests cover edge cases |
| complementOf named-class (R4) requires completion algorithm changes (harder than saturation) | Med | Med | Unit 5 is explicitly conditional on unit 2 findings; may defer if too complex |
| ALIF+ hang affects more constructs than documented | Low | Med | Category B keeps it.skip markers; no active test will timeout |

## Documentation Plan

- `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` — created in unit 2
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — updated in unit 8
- Memory `project_owl2dl_parity_gaps.md` — updated in unit 8
- `tests/integration/owl2dl-parity.test.ts` — it.skip blocks updated throughout

## Sources & References

- Related plan: [docs/plans/2026-06-02-038-feat-owl2dl-unified-parity-test-suite-plan.md](docs/plans/2026-06-02-038-feat-owl2dl-unified-parity-test-suite-plan.md)
- Gap matrix: [docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md](docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md)
- Mapper audit: [docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md](docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md)
- Prior differentFrom fix: [docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md](docs/solutions/logic-errors/differentfrom-abox-mapping-flag-logic-error-2026-05-28.md)
- Reference patches: `patches/028-irreflexive-asymmetric-saturation-clash.patch`, `patches/029-alldisjointproperties-equivalentproperties-clash.patch`
- Parity test file: `tests/integration/owl2dl-parity.test.ts`
