---
title: "fix: Verify WASM port output parity with native Konclude via golden-reference test suite"
type: fix
status: active
date: 2026-05-18
---

# fix: Verify WASM port output parity with native Konclude via golden-reference test suite

## Overview

Current integration tests check that specific known-good triples *appear* in WASM output (spot checks) and that counts exceed a floor. They do not verify that the WASM port produces *exactly* the same triples as native Konclude. This plan replaces spot-check tests with golden-reference comparisons: sorted set-diff of WASM output vs native output, one test per fixture per operation type.

## Problem Frame

Three classes of problem exist today:

1. **No native realization fixture.** `tests/fixtures/*-native-out.xml` are TBox-only classification outputs. There is no captured native ABox output (rdf:type, object property assertions) for the roberts-family ontology. Without it, ABox correctness is untestable.

2. **TBox tests are spot checks, not set equality.** `roberts-family.test.ts` checks 7 specific SubClassOf pairs and a count floor (≥70). It would pass even if 20 unrelated triples were wrong or missing. The correct approach is a sorted set-diff against native.

3. **Known divergences not yet fixed.** GALEN has 14 SubClassOf pairs that differ from native due to equivalence-class representative IRI selection. Roberts-family is missing 7 `*OfRobert ⊑ AncestorOfRobert` inferences (hasValue + subrole chain). Both are correctness bugs.

## Requirements Trace

- R1. Every fixture ontology (roberts-family, LUBM, GALEN) produces a TBox (subClassOf + equivalentClass) that is an exact match of native Konclude classification output.
- R2. Roberts-family ABox output (rdf:type + object property assertions) is verified against native Konclude realization output.
- R3. The 7 missing `*OfRobert ⊑ AncestorOfRobert` inferences are present.
- R4. The 14 GALEN SubClassOf representative-IRI divergences are resolved.
- R5. Integration tests use sorted set-diff comparisons, not spot checks or count floors, for all fixture ontologies that have a native reference.

## Scope Boundaries

- **In scope:** TBox (subClassOf, equivalentClass) and ABox (rdf:type, object property assertions) correctness for the three fixture ontologies.
- **Out of scope:** `rdfs:subPropertyOf` / `owl:equivalentProperty` (property hierarchy not yet extracted), `owl:sameAs` (CSameRealization not yet called), data property assertions, `owl:differentFrom`, incremental reasoning. These are separate feature additions, not correctness regressions.
- **Out of scope:** Browser tests, Playwright infrastructure, performance benchmarking.

### Deferred to Separate Tasks

- Property hierarchy output (rdfs:subPropertyOf): separate feat PR after correctness baseline is green
- owl:sameAs entailments: separate feat PR

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` emits subClassOf, equivalentClass, rdf:type, object property assertions. `getInferredNTriples()` is the old string API used by `dump-outputs.mjs` and emits TBox only.
- `tests/fixtures/roberts-native-out.xml` — native TBox classification output, OWL/XML format, 76 SubClassOf + 3 EquivalentClasses groups.
- `tests/fixtures/lubm-native-out.xml` — native TBox, 44 SubClassOf, 0 equivalences.
- `tests/fixtures/galen-native-out.xml` — native TBox, 3241 SubClassOf + 19 EquivalentClasses groups; 14 SubClassOf pairs differ from WASM.
- `tests/fixtures/roberts-wasm-out.nt` — WASM TBox output via old string API (TBox only, does not reflect ABox path).
- `docs/native-logs/roberts-realization-verbose.log` — proves native ran full realization on 405 individuals; output was not captured.
- `docs/native-logs/roberts-classification-verbose.log` — native classification run, output = `roberts-native-out.xml`.
- `tests/integration/roberts-family.test.ts` — current richest integration test; spot-check pattern to replace.
- `tests/bench/dump-outputs.mjs` — generates `*-wasm-out.nt` files via old `getInferredNTriples()` string API.
- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` — documents the four over-materialization bugs and the fix; confirms sorted triple-diff is the required verification method.

### Institutional Learnings

- **Sorted triple-diff is the only reliable signal** — count matches are insufficient because duplicates can mask missing triples; both over- and under-generation can produce the same count.
- **TBox LUBM and Roberts already match native exactly** — confirmed by prior comparison work. GALEN has 14 representative-IRI divergences (not new regressions, pre-existing).
- **7 missing Roberts inferences** — `*OfRobert ⊑ AncestorOfRobert` chain; hasValue + subrole (`isForefatherOf ⊑ isAncestorOf`); root cause is subrole lookup in role hierarchy index during preprocessing, likely Qt→std hash migration artifact.
- **Representative IRI selection** — WASM uses lowest `getConceptTag()` (first-encountered concept); native uses primary concept name. For GALEN equivalence sets, 14 pairs pick a different representative. Fix: examine what native picks and align the selection heuristic, OR accept as documented non-semantic difference and exclude from set-equality comparison with annotation.

### External References

- OWL/XML output format: `<SubClassOf>`, `<Class IRI="..."/>`, `<EquivalentClasses>` elements.

## Key Technical Decisions

- **Canonical fixture format: sorted NTriples, one triple per line.** All golden references stored as `.nt` files sorted lexicographically. Comparison is `setA === setB` on the sorted line array — simple, portable, no special tooling.
- **Separate TBox and ABox fixture files.** `*-native-tbox.nt` for classification output, `*-native-abox.nt` (rdf:type + object properties) for realization output. Keeps test assertions scoped.
- **Native XML → NTriples conversion is a one-time offline script**, not a test dependency. Script runs once, output committed. Tests load the committed `.nt` files.
- **Native realization output generated by running native Konclude** on `roberts-family.nt` with realization mode. The vendor source (`vendor/konclude/`) can be built as a native binary, or the pre-built Konclude CLI binary can be used if available. The output format is OWL/XML; parse similarly to TBox conversion.
- **GALEN representative-IRI divergences:** Investigate whether they are semantically equivalent (same concept, different IRI synonym). If equivalent — document as acceptable and exclude those 14 pairs from set-equality while adding a comment. If not equivalent — fix the representative selection.
- **Test reduction:** After golden-reference tests pass, remove redundant spot-check assertions (count floors, individual SubClassOf checks that are subsumed by set-equality). Keep only: consistency/inconsistency tests (not covered by set-equality), ABox edge-case micro-ontology tests, and the sequential-stability test.

## Open Questions

### Resolved During Planning

- **How to convert OWL/XML to NTriples?** Write a small Node.js script parsing XML with the built-in `DOMParser` or a regex over `<SubClassOf>` / `<EquivalentClasses>` / `<ClassAssertion>` / `<ObjectPropertyAssertion>` elements. The OWL/XML format in the fixture files uses a simple flat structure — no nested complex class expressions — so regex parsing is sufficient.
- **Can native Konclude be run to generate realization output?** The vendor source is available at `vendor/konclude/`. A native (non-WASM) build can be done outside Docker using the system C++ toolchain. Alternatively, the user may have a pre-built Konclude binary. Plan assumes one of these is available; if not, the ABox golden reference unit is deferred and ABox tests remain spot-checks until the binary is available.

### Deferred to Implementation

- **Exact root cause of 7 missing *OfRobert inferences** — diagnosed as subrole lookup bug in role hierarchy index; exact fix location (whether in `CSubroleTransformationPreProcess` or a map lookup site) determined during implementation by adding debug output for subrole resolution on the isForefatherOf/isForemotherOf roles.
- **Whether GALEN's 14 divergences are semantically equivalent** — determined during implementation by checking if the 14 differing IRIs are in the same equivalence class node (same `CHierarchyNode`, different member IRI). If yes: both are valid representatives; document and exclude from strict comparison. If no: a real correctness divergence requiring a fix.

---

## Implementation Units

- [ ] **Unit 1: Build native TBox golden-reference NTriples fixtures**

**Goal:** Convert `*-native-out.xml` (OWL/XML) to sorted NTriples files as canonical TBox comparison fixtures.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Create: `scripts/native-xml-to-nt.mjs` — conversion script
- Create: `tests/fixtures/roberts-native-tbox.nt`
- Create: `tests/fixtures/lubm-native-tbox.nt`
- Create: `tests/fixtures/galen-native-tbox.nt`

**Approach:**
- Script reads an OWL/XML file, extracts `<SubClassOf>` (two `<Class IRI="..."/>` children) and `<EquivalentClasses>` (N `<Class IRI="..."/>` children) elements.
- For SubClassOf: emit one `<sub> rdfs:subClassOf <super> .` triple per pair.
- For EquivalentClasses with N members: emit all N×(N-1) ordered pairs as `owl:equivalentClass` triples (matching WASM output format). For a 2-member group this is 2 triples; for 3-member it is 6 triples.
- Sort all triples lexicographically, write one per line, save as `.nt`.
- Run against all three native XML files to produce the three `.nt` fixtures.
- Commit the generated `.nt` files — they are the golden references, not regenerated at test time.

**Patterns to follow:** `tests/bench/dump-outputs.mjs` for how to run/write output scripts.

**Test scenarios:**
- Happy path: parse `roberts-native-out.xml` → sorted `.nt` with exactly 76 SubClassOf + 10 equivalentClass triples (3 groups: 2×2-member = 4 triples, 1×3-member = 6 triples).
- Happy path: parse `lubm-native-out.xml` → 44 SubClassOf, 0 equivalentClass.
- Happy path: parse `galen-native-out.xml` → 3241 SubClassOf + N equivalentClass (19 groups).
- Edge case: 3-member EquivalentClasses group (Person/BloodRelation/Descendent in roberts) emits all 6 ordered pairs, not just 2.

**Verification:** Three `.nt` files committed; running the script is idempotent (re-running produces identical output). Triple counts match the OWL/XML element counts.

---

- [ ] **Unit 2: Generate native ABox realization output for roberts-family**

**Goal:** Capture what native Konclude emits for rdf:type and object property assertions on the full 405-individual roberts-family ontology. This is the ABox golden reference.

**Requirements:** R2

**Dependencies:** Unit 1 (understanding of output format)

**Files:**
- Create: `tests/fixtures/roberts-native-abox.nt` — sorted NTriples of native ABox output
- Modify: `scripts/native-xml-to-nt.mjs` — extend to handle `<ClassAssertion>` and `<ObjectPropertyAssertion>` elements if native realization output is in OWL/XML format

**Approach:**
- Build or locate a native Konclude binary. Options in order of preference:
  1. Check if a pre-built binary is available (`vendor/konclude/` build artifacts or user's PATH).
  2. Build native binary: `cmake -B build-native -DCMAKE_BUILD_TYPE=Release && make -C build-native Konclude` (no Emscripten).
  3. Pull the official Konclude Docker image if available.
- Run: `Konclude realization -i tests/fixtures/roberts-family.nt -f NTriples -o tests/fixtures/roberts-native-abox-raw.nt`
  (or use OWL/XML output and convert via the extended script from Unit 1).
- Sort the output: remove blank nodes (native may use them for anonymous individuals; WASM does not), deduplicate, sort lexicographically.
- Commit `roberts-native-abox.nt`.
- If no native binary is obtainable, this unit is **deferred**: ABox tests remain spot-checks (presence of rdf:type, hasMother) until binary is available. Document the deferral as a comment in the test file.

**Test scenarios:**
- Happy path: output contains `john_william_folland rdf:type Person` (a directly asserted type, echoed by native).
- Happy path: output contains at least one `hasMother` triple (role assertion from realization).
- Edge case: blank-node individuals (if any) are excluded from comparison or normalized to IRI form.

**Verification:** `roberts-native-abox.nt` committed and non-empty. Triple count roughly matches the WASM output count (order of magnitude; exact match is not expected until divergence fixes land in Unit 4).

---

- [ ] **Unit 3: Write golden-reference comparison helper and rewrite TBox tests**

**Goal:** Replace spot-check integration tests with set-equality comparisons against native `.nt` fixtures for TBox output across all three fixture ontologies.

**Requirements:** R1, R5

**Dependencies:** Unit 1 (native TBox fixtures committed)

**Files:**
- Create: `tests/helpers/compare-native.ts` — `assertExactMatch(wasm: Quad[], nativePath: string): void`
- Modify: `tests/integration/roberts-family.test.ts` — replace SubClassOf spot checks + count floor with `assertExactMatch` for TBox triples
- Modify: `tests/integration/lubm.test.ts` — replace spot checks with `assertExactMatch`
- Modify: `tests/integration/galen.test.ts` — replace spot checks with `assertExactMatch` (or `assertMatchExcluding(knownDivergences)` until GALEN fix lands)

**Approach:**
- `assertExactMatch` loads the `.nt` file, parses to a sorted string array, filters WASM output to the same predicate types (subClassOf, equivalentClass, or rdf:type, etc.), sorts to a string array, then does array equality.
- On mismatch, report: `only in native: [...]` and `only in WASM: [...]` — not just a count.
- For GALEN: while the 14-pair divergence is under investigation (Unit 4), use `assertMatchExcluding(known14)` which passes an explicit exclusion set. The exclusion set is a constant in the test with a `// TODO: fix representative IRI selection` comment. This keeps CI green while making the divergence explicit and visible.
- Keep the sequential-stability test, the ABox presence checks (rdf:type, hasMother), and the consistency tests — they test orthogonal things.

**Test scenarios:**
- Happy path: WASM roberts TBox output after classify() set-equals `roberts-native-tbox.nt` (76 SubClassOf + 10 equivalentClass).
- Happy path: WASM LUBM TBox output set-equals `lubm-native-tbox.nt` (44 SubClassOf, 0 equiv).
- Happy path: WASM GALEN TBox output matches `galen-native-tbox.nt` excluding the known 14 divergences.
- Error path: on mismatch, test failure message clearly lists `only in native` and `only in WASM` triples (not a generic count mismatch).

**Verification:** `roberts-family.test.ts`, `lubm.test.ts`, `galen.test.ts` all pass with set-equality TBox assertions. Spot-check assertions (count floors, individual SubClassOf presence) removed.

---

- [ ] **Unit 4: Fix GALEN representative-IRI divergences (14 SubClassOf pairs)**

**Goal:** Align WASM equivalence-class representative IRI selection with native Konclude for the 14 diverging GALEN SubClassOf pairs. Remove the `assertMatchExcluding` workaround from Unit 3.

**Requirements:** R1, R4

**Dependencies:** Unit 3 (comparison infrastructure in place)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` representative selection logic
- Modify: `tests/integration/galen.test.ts` — remove exclusion set, upgrade to strict `assertExactMatch`

**Approach:**
- Inspect the 14 diverging pairs: for each, check whether the WASM-chosen IRI and native-chosen IRI are in the same `CHierarchyNode` equivalence set. They should be — these are equivalence classes, so both IRIs are valid representatives.
- Determine native's selection rule by inspecting the native OWL/XML output: native picks the IRI that appears as the primary class in the ontology (likely the first declared or the one with the shortest IRI, or the one with the lowest concept tag in native's internal ordering).
- Current WASM rule: lowest `getConceptTag()` (first-encountered concept in the WASM build). If this diverges from native, adjust: iterate equivalence members and pick the one that matches native's observable ordering (e.g., lexicographically smallest full IRI, or the member whose IRI appears earliest in the sorted `.nt` fixture).
- If the 14 pairs are found to be genuinely different concepts (not synonyms in the same equivalence set), this is a logic error requiring deeper investigation — defer to a follow-up fix and document.

**Test scenarios:**
- Happy path: after fix, WASM GALEN TBox output set-equals `galen-native-tbox.nt` with no exclusions (strict `assertExactMatch`).
- Edge case: equivalence set with 3+ members still picks the correct representative.

**Verification:** `galen.test.ts` passes with strict set-equality. No `assertMatchExcluding` in any test.

---

- [ ] **Unit 5: Fix 7 missing *OfRobert ⊑ AncestorOfRobert inferences**

**Goal:** The WASM port is missing 7 SubClassOf triples of the form `*OfRobert ⊑ AncestorOfRobert`. Native Konclude produces them. Root cause: hasValue + subrole chain (`isForefatherOf ⊑ isAncestorOf`, `isForemotherOf ⊑ isAncestorOf`) is not resolved during preprocessing in the WASM build.

**Requirements:** R1, R3

**Dependencies:** Unit 3 (set-equality comparison will expose the missing 7 triples as a test failure; fix is validated when roberts TBox passes strict set-equality)

**Files:**
- Investigate: `vendor/konclude/Source/Reasoner/Preprocess/CSubroleTransformationPreProcess.cpp` — subrole expansion for hasValue restrictions
- Investigate: `src/compat/` — Qt→std hash migration artifacts in role hierarchy lookup
- Modify: whichever file contains the faulty subrole lookup — likely a `QHash`→`std::unordered_map` lookup that fails silently on miss

**Approach:**
- Add targeted stderr logging in `buildInferredTripleBuffer()` to confirm the 7 triples are absent from the WASM taxonomy (not a serialization omission).
- If absent from taxonomy: trace backward through KPSet classification for `AuntOfRobert`. Compare WASM verbose stderr against `docs/native-logs/roberts-classification-verbose.log` to find the divergence point in the classifier pipeline.
- Focus on `CSubroleTransformationPreProcess`: this preprocessing step expands role subsumptions into the hasValue restriction contexts. In Qt, `QHash` returns a null/default value for missing keys (silently); `std::unordered_map::find()` must be checked for `end()`. A missing `end()` check is the leading hypothesis.
- Fix: add `end()` guard, or verify the role hierarchy index is populated before the subrole expansion pass runs.
- Rebuild WASM and run set-equality test.

**Test scenarios:**
- Happy path: after fix, `roberts-family.test.ts` TBox set-equality passes with all 7 `*OfRobert ⊑ AncestorOfRobert` triples present.
- Regression guard: existing `AuntOfRobert ⊑ Aunt` and `FemaleAncestor ⊑ Woman` triples still present.

**Verification:** `roberts-family.test.ts` strict `assertExactMatch` passes with no exclusions. WASM output triple count matches native exactly (76 SubClassOf for roberts TBox).

---

- [ ] **Unit 6: Write ABox golden-reference test and clean up redundant tests**

**Goal:** Add a set-equality ABox test against `roberts-native-abox.nt` (from Unit 2). Remove redundant spot-check tests subsumed by the new golden-reference suite.

**Requirements:** R2, R5

**Dependencies:** Unit 2 (native ABox fixture committed), Unit 3 (comparison helper)

**Files:**
- Modify: `tests/integration/roberts-family.test.ts` — add ABox set-equality test; remove spot-check `hasMother presence` and `rdf:type triples present` assertions (subsumed by set-equality)
- Modify: `tests/integration/roberts-minimal-realization.test.ts` — consider removing or reducing if fully covered by full-ontology ABox set-equality
- Review: `tests/integration/abox-realization.test.ts` — keep (micro-ontology edge cases not covered by fixture comparison)
- Review: `tests/integration/consistency.test.ts` — keep (consistency/inconsistency orthogonal to TBox/ABox parity)

**Approach:**
- Add test: `classify(robertsFamilyQuads)` → ABox triples (filter by rdf:type and object properties) must set-equal `roberts-native-abox.nt`.
- After ABox set-equality test passes, remove: `hasMother role assertion present` (subsumed), `ABox realization ran: inferred contains rdf:type triples` (subsumed), and `john_william_folland rdf:type Person` (subsumed).
- Keep: sequential-call-stability test (not a correctness assertion), concurrent-serialization test, consistency/inconsistency tests, micro-ontology tests in `abox-realization.test.ts`.
- If Unit 2 is deferred (no native binary), this unit is also deferred — existing ABox spot checks remain until native output is available.

**Test scenarios:**
- Happy path: roberts-family full classify() ABox output set-equals `roberts-native-abox.nt`.
- Edge case: rdf:type triples for all 405 individuals present, not just the 3 checked in spot tests.
- Regression guard: after removing spot-check assertions, run full suite to confirm no other test relied on them.

**Verification:** All integration tests pass. Test file diff shows net reduction in assertions (spot checks removed, golden-reference assertions added). `npm test` green in full suite.

---

## System-Wide Impact

- **Affected test files:** `roberts-family.test.ts`, `lubm.test.ts`, `galen.test.ts`, `roberts-minimal-realization.test.ts`
- **New artifacts committed:** 3 TBox `.nt` files (Unit 1), 1 ABox `.nt` file (Unit 2), 1 comparison helper (Unit 3)
- **C++ changes:** `src/KoncludeReasoner.cpp` (representative IRI fix, Unit 4), and one preprocessing file (subrole fix, Unit 5). Both require WASM rebuild (~20 min).
- **Unchanged invariants:** consistency tests, sequential stability test, micro-ontology ABox tests, browser tests — none of these are affected by the TBox/ABox set-equality changes.
- **Test suite duration:** unchanged (same fixture ontologies, same test file structure). Roberts consistency test (~295s) remains the bottleneck.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Native Konclude binary unavailable for ABox output generation | Unit 2 and Unit 6 explicitly deferred; ABox spot checks remain as fallback until binary obtainable |
| 14 GALEN divergences are not representative-IRI synonyms but actual logic errors | Investigate in Unit 4; if logic error, defer fix to separate follow-up and keep `assertMatchExcluding` with comment |
| Subrole fix (Unit 5) changes behavior for other ontologies | Run full suite after fix; `lubm.test.ts` and `galen.test.ts` TBox set-equality would catch new regressions |
| WASM rebuild takes 20–30 min per C++ change | Batch Units 4 and 5 into one rebuild if both fixes are in C++ |
| `roberts-native-abox.nt` ABox output has different blank-node handling than WASM | Normalize blank nodes before comparison; or use named-individual-only filter |

## Sources & References

- Native log analysis: `docs/native-logs/roberts-*-verbose.log`
- Native TBox fixtures: `tests/fixtures/roberts-native-out.xml`, `lubm-native-out.xml`, `galen-native-out.xml`
- Over-materialization bug history: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- LUBM config-flag bug: `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
- Missing components inventory: memory `project_missing_konclude_components.md`
- Subrole inference gap: memory `project_reasoner_inference_deps.md`
