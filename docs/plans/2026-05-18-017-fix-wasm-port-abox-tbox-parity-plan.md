---
title: "fix: Close remaining WASM port parity gaps — ABox realization and TBox representative-IRI"
type: fix
status: active
date: 2026-05-18
origin: docs/plans/2026-05-18-016-fix-native-output-parity-golden-reference-plan.md
---

# fix: Close remaining WASM port parity gaps — ABox realization and TBox representative-IRI

## Overview

The golden-reference test suite from plan-016 exposed two remaining correctness gaps in the WASM port:

1. **ABox realization incomplete** — `ConceptNameVisitor` in `buildInferredTripleBuffer()` stopped iteration after the first concept in an equivalence set, emitting only one type per equivalence group instead of all members. Native emits all equivalent class members for each individual. C++ fix already applied; WASM rebuild required to validate.

2. **TBox representative-IRI non-determinism** — WASM picks equivalence-class representatives by lowest concept tag (internal hash-order-dependent); native picks by `eqConList.first()` (Qt QHash-order-dependent). Both orderings are non-canonical, producing 48 divergent SubClassOf pairs in GALEN. Fix: align WASM to lexicographic-minimum representative selection and normalize native TBox fixtures with the same rule, eliminating the exclusion-list workaround entirely.

## Problem Frame

After plan-016 landed the golden-reference comparison infrastructure, `npm test` reports two failures:

- `roberts-family.test.ts`: ABox set-equality fails — 1529 triples missing from WASM (405 `owl:Thing` by design; 1124 real gaps: `BloodRelation`, `Descendent`, `Man`, `FemaleDescendent` for hundreds of individuals). Root cause: `ConceptNameVisitor::visitConcept` returned `false` (stop) after the first equivalent concept in each type item.
- `galen.test.ts`: TBox `assertMatchExcluding` fails with 34 new swap pairs (`SolidBodyStructure` ↔ `TubularBodyStructure`), in addition to the 14 previously known pairs. Root cause: same Qt→std hash-ordering artifact for a second equivalence group.

## Requirements Trace

- R1. Roberts ABox `assertExactMatch` against `roberts-native-abox.nt` (4552 triples, `owl:Thing` excluded) passes after WASM rebuild.
- R2. GALEN TBox uses strict `assertExactMatch` with no exclusion list — all 48 divergence pairs resolved.
- R3. LUBM and Roberts TBox set-equality remains passing after representative-IRI change.
- R4. All integration tests green (`npm test` exits 0).

## Scope Boundaries

- **In scope:** ABox equivalence-set emission fix; TBox representative selection canonicalization; native TBox fixture regeneration.
- **Out of scope:** Property hierarchy (`rdfs:subPropertyOf`), `owl:sameAs` entailments, data property assertions, incremental reasoning — separate feature additions.
- **Out of scope:** GALEN ABox realization (no native fixture exists; not blocked by current failures).

### Deferred to Separate Tasks

- GALEN ABox realization golden reference — separate fixture generation + test
- Representative-IRI fix for ABox (ABox already emits all equivalent members after Unit 1; ABox set-equality comparison is already correct)

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp`:
  - Lines 1121–1154: `ConceptNameVisitor` + `TypeVisitor` (ABox type emission) — fix already applied in this session; `visitConcept` now returns `true` and collects all IRIs.
  - Lines 875–888: `nodeRep` lambda (TBox representative selection) — currently picks lowest concept tag; change to lex-minimum.
- `scripts/native-xml-to-nt.mjs`: `parseXmlToTriples()` — add normalization pass that replaces each IRI in SubClassOf triples with the lex-minimum member of its equivalence class.
- `tests/integration/galen.test.ts`: `GALEN_KNOWN_DIVERGENCES` (48 pairs, 96 strings) — remove entirely after Unit 2 lands.
- `tests/fixtures/roberts-native-abox.nt` (4552 lines) — already regenerated without `owl:Thing`.
- `tests/fixtures/*-native-tbox.nt` — three files to regenerate after normalization script is updated.

### Institutional Learnings

- `docs/solutions/`: KPSet classifier builds taxonomy by iterating satItemList; `CHierarchyNode::getOneEquivalentConcept()` returns `eqConList.first()` (first-inserted concept). WASM's lowest-tag heuristic diverges from native's insertion-order heuristic. Both are hash-order-dependent; switching to lex-minimum makes WASM deterministic and norm-align.
- `buildInferredTripleBuffer()` owns both TBox and ABox emission; TBox and ABox representative logic are independent.
- WASM filters `owl:Thing` and `owl:Nothing` from ABox output by design (line 1143); native fixture must exclude them for comparison — already done.

## Key Technical Decisions

- **Lex-minimum representative selection in WASM**: Change `nodeRep` to `std::min` over all concept IRIs. This is deterministic, portable, and independent of Qt QHash ordering. After normalizing native fixtures to the same rule, WASM and native reference agree on every representative.
- **Normalize native TBox fixtures at script level, not at test time**: `native-xml-to-nt.mjs` builds an equivalence-class map (first pass), then replaces IRIs in SubClassOf triples during the second pass. This keeps test helpers free of normalization logic.
- **Remove GALEN_KNOWN_DIVERGENCES**: Once native fixtures are normalized, `assertMatchExcluding` for GALEN reverts to `assertExactMatch`. The exclusion-list was always a workaround; plan-016 intended strict set-equality.

## Open Questions

### Resolved During Planning

- **Does lex-minimum representative affect equivalentClass triples?** No — `equivalentClass` triples emit all N*(N-1) ordered pairs regardless of representative choice. Only `subClassOf` triples use the representative.
- **Do Roberts and LUBM TBox fixtures need re-normalization?** Only if they contain SubClassOf triples whose subjects or objects are non-lex-minimum equivalence-class members. LUBM has no equivalences; Roberts has equivalences but the script regeneration will re-sort with normalization. Both must be regenerated to verify.
- **Does ABox need lex-minimum normalization?** No — ABox now emits all equivalent class members (all IRIs), so representative choice is irrelevant for ABox comparison.

### Deferred to Implementation

- Whether any new representative-IRI divergences surface in LUBM or Roberts TBox after normalization — checked during Unit 2 verification.

---

## Implementation Units

- [x] **Unit 1: Rebuild WASM and validate ABox fix**

**Goal:** Confirm that the `ConceptNameVisitor` fix (already in `src/KoncludeReasoner.cpp`) resolves the 1124 missing ABox type assertions in the Roberts family test.

**Requirements:** R1, R4

**Dependencies:** None — C++ change already applied.

**Files:**
- No code changes required (fix already applied)
- `tests/fixtures/roberts-native-abox.nt` — already regenerated (4552 lines, `owl:Thing` excluded)

**Approach:**
- Run WASM rebuild: `docker compose run --rm build` then `npm run patch-wasm`
- Run `npm test` — expected: Roberts ABox set-equality passes; GALEN TBox still shows 48 divergences (known, handled by exclusion list)
- If Roberts ABox still fails, examine the `TypeVisitor` visitor dispatch: confirm that `conReal->visitAllTypes(indi, &tv)` delivers one `CConceptInstantiatedItem` per equivalence-class node (not per concept), and that `visitConcepts` iterates all equivalent concepts per item. If `visitAllTypes` only fires once per concept (not per node), the fix is sufficient and the issue is elsewhere.

**Test scenarios:**
- Happy path: `roberts-family.test.ts > ABox matches native Konclude output exactly` passes (0 missing, 0 extra)
- Regression guard: Roberts TBox set-equality remains passing (86 triples unchanged)
- Regression guard: LUBM TBox set-equality remains passing (44 triples unchanged)
- Regression guard: sequential-stability test still passes

**Verification:** `npm test` output shows `roberts-family.test.ts (7 tests | 0 failed)` and GALEN is the only remaining failure (48-pair exclusion list still applied).

---

- [ ] **Unit 2: Canonicalize TBox representative selection and eliminate GALEN exclusion list**

**Goal:** Change WASM's `nodeRep` lambda to pick the lexicographically smallest IRI per equivalence class. Update `native-xml-to-nt.mjs` to normalize native SubClassOf triples using the same rule. Regenerate all three TBox fixtures. Remove `GALEN_KNOWN_DIVERGENCES` and upgrade GALEN to strict `assertExactMatch`.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1 (WASM rebuild infrastructure confirmed working)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `nodeRep` lambda (lines ~875–888)
- Modify: `scripts/native-xml-to-nt.mjs` — `parseXmlToTriples()`: add equivalence normalization
- Regenerate: `tests/fixtures/roberts-native-tbox.nt`
- Regenerate: `tests/fixtures/lubm-native-tbox.nt`
- Regenerate: `tests/fixtures/galen-native-tbox.nt`
- Modify: `tests/integration/galen.test.ts` — remove `GALEN_KNOWN_DIVERGENCES`, change `assertMatchExcluding` to `assertExactMatch`

**Approach:**
- **WASM change (`nodeRep`)**: Replace the lowest-tag loop with a lex-min loop: iterate `getEquivalentConceptList()`, call `conceptIri(c)`, keep the smallest non-empty IRI. This is a 3-line change in the lambda body.
- **Script normalization**: In `parseXmlToTriples()`, add a first pass that builds `equivMap: Map<string, string>` mapping each equivalence-class member IRI to the lex-minimum member of its group. In the SubClassOf second pass, normalize subject and object IRIs through `equivMap` before emitting. Then re-sort the final triple array.
- **Fixture regeneration**: Run the updated script against `tests/fixtures/roberts-native-out.xml`, `lubm-native-out.xml`, `galen-native-out.xml`. Commit the updated `.nt` files.
- **WASM rebuild**: `docker compose run --rm build` then `npm run patch-wasm`. Re-run `npm test`.

**Technical design:** *(Directional guidance — not implementation specification)*

```
parseXmlToTriples(xml):
  // Pass 1: equivalence map
  equivMap = {}
  for each <EquivalentClasses> group:
    members = [IRI, ...]
    canon = min(members)         // lexicographic minimum
    for each IRI in members:
      equivMap[IRI] = canon

  // Pass 2: SubClassOf with normalization
  for each <SubClassOf>:
    sub = equivMap[sub] ?? sub
    sup = equivMap[sup] ?? sup
    emit triple(sub, subClassOf, sup)

  // Pass 3: EquivalentClass pairs (unchanged — emit all N*(N-1) pairs)
  ...
```

```
nodeRep(node):
  best = ""
  for each CConcept* c in node->getEquivalentConceptList():
    iri = conceptIri(c)
    if iri is non-empty and (best is empty or iri < best):
      best = iri
  return best
```

**Patterns to follow:** Existing `nodeRep` lambda at line 875 of `src/KoncludeReasoner.cpp`; `parseXmlToTriples` in `scripts/native-xml-to-nt.mjs`.

**Test scenarios:**
- Happy path: `galen.test.ts > TBox matches native Konclude output excluding known representative-IRI divergences` passes as strict `assertExactMatch` with no exclusion list
- Happy path: `roberts-family.test.ts > TBox matches` still passes (86 triples; normalization may or may not change representatives for Roberts — either way, both WASM and fixture use the same rule)
- Happy path: `lubm.test.ts > TBox matches` still passes (44 triples; LUBM has no equivalences so normalization is a no-op)
- Edge case: SubClassOf triple where both subject AND object are non-lex-minimum equivalence-class members — both normalized correctly
- Edge case: Equivalence class with 3+ members — lex-minimum chosen consistently; all SubClassOf edges through this class use the same representative

**Verification:** `npm test` exits 0 with all integration tests passing. `GALEN_KNOWN_DIVERGENCES` removed. GALEN test uses `assertExactMatch`. Triple counts: `galen-native-tbox.nt` has same count (3287) minus any duplicates introduced by normalization collision (expected: zero, since lex-min is injective within a well-formed taxonomy).

---

## System-Wide Impact

- **C++ change (`nodeRep`)**: Affects TBox output only — `subClassOf` triple subjects/objects. ABox unaffected (ABox emits all equivalence members, not just representative).
- **Script change + fixture regeneration**: One-time offline operation; committed fixtures are the authoritative reference. No test-time normalization required.
- **Unchanged invariants**: `equivalentClass` triples, `rdfs:subPropertyOf` (not yet emitted), ABox rdf:type triples (all emitted per Unit 1 fix), sequential stability, consistency tests.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| WASM rebuild takes 20–30 min per C++ change | Unit 1 and Unit 2 both require a rebuild; batch Unit 2 C++ change with any other pending fixes before triggering second rebuild |
| Lex-min normalization introduces duplicate SubClassOf triples (two non-equivalent classes collapse to same lex-min IRI) | Extremely unlikely — would require two distinct equivalence classes with the same lex-min member, which is a malformed ontology. Detect via: fixture line count should not decrease |
| LUBM fixture line count changes after normalization | LUBM has no equivalences; script normalization is a no-op; count must remain 44 |
| New GALEN divergences emerge after normalization (unforeseen equivalence groups) | Covered by strict `assertExactMatch` — any new gap surfaces immediately with clear diff output |

## Sources & References

- Origin plan: `docs/plans/2026-05-18-016-fix-native-output-parity-golden-reference-plan.md`
- ABox emission fix: `src/KoncludeReasoner.cpp` lines 1121–1154 (ConceptNameVisitor)
- TBox representative selection: `src/KoncludeReasoner.cpp` lines 875–888 (nodeRep lambda)
- Fixture conversion script: `scripts/native-xml-to-nt.mjs`
- GALEN exclusion list: `tests/integration/galen.test.ts` lines 52–83 (GALEN_KNOWN_DIVERGENCES)
- Native TBox XML sources: `tests/fixtures/roberts-native-out.xml`, `lubm-native-out.xml`, `galen-native-out.xml`
