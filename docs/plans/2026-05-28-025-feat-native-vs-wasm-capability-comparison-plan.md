---
title: "feat: Compare native Konclude vs WASM build on OWL-DL violation cases (issue #13)"
type: feat
status: complete
date: 2026-05-28
---

# feat: Compare native Konclude vs WASM build on OWL-DL violation cases (issue #13)

## Overview

Run the six OWL-DL violation examples from ontosphere issue #13 against the native Konclude binary, compare those results to our WASM build, and produce a documented capability gap matrix. The outcome is a committed ground-truth JSON, living integration tests, and a solutions doc that classifies each gap as either a WASM-port defect or an upstream Konclude limitation.

## Problem Frame

Manual testing of our WASM build against issue #13 yielded:

| Case | WASM verdict | Notes |
|------|-------------|-------|
| 1. disjointWith (direct) | inconsistent ✓ | justification found |
| 2. disjointWith (via inference) | inconsistent ✓ | justification found |
| 3. AsymmetricProperty | consistent ✗ | not detected |
| 4. IrreflexiveProperty | consistent ✗ | not detected |
| 5. maxQualifiedCardinality + differentFrom | — | timeout |
| 6. allValuesFrom + disjointWith | — | timeout |

We do not know which failures are WASM port gaps (fixable) vs upstream Konclude limitations (inherent). Native Konclude running the same cases is the ground truth needed to answer this.

## Requirements Trace

- R1. Native Konclude binary acquired and runnable locally via a documented, reproducible script
- R2. All six issue #13 cases represented as OWL 2 XML fixtures committed to `tests/fixtures/issue13/`
- R3. Native verdicts (consistent/inconsistent/timeout) captured and committed as a JSON golden file
- R4. WASM integration test file runs all six cases and asserts verdicts match the native golden file
- R5. A gap analysis document classifies each divergence as WASM-port defect, upstream limitation, or performance gap

## Scope Boundaries

- Consistency verdict comparison only — not triple-level diff of inferred output
- `explainInconsistency` is exercised only for cases where WASM reports inconsistent (cases 1 and 2); justification quality is out of scope here
- No fixes to identified gaps in this plan — gap classification is the deliverable; fixes land in separate PRs
- OWL 2 XML is the native input format; NTriples/Redland path is not used (adds a build dependency with no gain for these small fixtures)

### Deferred to Separate Tasks

- Fixing detected WASM gaps (AsymmetricProperty, IrreflexiveProperty, cardinality, allValuesFrom): separate fix PRs after gap classification is complete
- Performance investigation for timeout cases (5, 6): separate investigation once native confirms whether the timeout is a WASM-only issue

## Context & Research

### Relevant Code and Patterns

- `tests/fixtures/` — NTriples and OWL 2 XML fixture layout; `*-native-tbox.nt` / `*-wasm-out.nt` are the existing parity pattern
- `tests/helpers/compare-native.ts` — `assertExactMatch` / `assertMatchExcluding` helpers for set-diff comparison
- `tests/integration/consistency.test.ts` — `describe.skipIf(!wasmExists)` + `beforeAll` + shared `reasoner` pattern; direct template for the new test file
- `scripts/convert-test-fixtures.sh` — shows how ROBOT converts OWL 2 XML → NTriples for WASM input; not needed here (native takes OWL 2 XML directly)
- `vendor/konclude/Scripts/Konclude` — wrapper that delegates to `./Binaries/Konclude`; the `Binaries/` directory is populated by download or build
- `docs/plans/2026-05-18-016-fix-native-output-parity-golden-reference-plan.md` — documents the native binary acquisition problem (Unit 2 of that plan is the precedent)

### Institutional Learnings

- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` — ground-truth comparison must be sorted triple-level diff, not counts; applied here at verdict level
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md` — WASM config diverges from native in ways that silently affect which classifier path runs; this is the mechanism most likely responsible for cases 3–6

### External References

- [ontosphere issue #13](https://github.com/ThHanke/ontosphere/issues/13) — six violation examples, Turtle source
- Konclude CLI reference: `./Konclude consistency -i file.owl.xml` → exit 0 = consistent, 10 = inconsistent; `./Konclude classification -i file.owl.xml -o out.owl.xml` for TBox output

## Key Technical Decisions

- **OWL 2 XML as native input format**: Konclude's native serialization; no ROBOT dependency, no NTriples→OWL mapping ambiguity. All six issue #13 cases are small enough to hand-write. (Resolves the format choice the research flagged as "experimental" for NTriples→Konclude)
- **Committed JSON golden file for native verdicts**: `tests/fixtures/issue13-native-verdicts.json` is committed once (after running with the binary) and read by the integration test at runtime. The test does not re-run native Konclude — it compares WASM output to the committed ground truth. This decouples CI from binary availability.
- **WASM integration test gated on `wasmExists`**: Same `describe.skipIf(!wasmExists)` pattern as all other integration tests. If WASM is absent the test skips; if native JSON is absent a missing-fixture error surfaces clearly.
- **Timeout cap of 30 s per case in the native runner script**: If native also times out on a case, the JSON records `"timeout": true` and the WASM test for that case is annotated as a performance comparison (WASM timeout expected, native timeout known).
- **Download-only acquisition**: The binary is acquired once by a developer and stored at `vendor/konclude/Binaries/Konclude` (gitignored). Download from GitHub Releases is the only supported path — the project's `CMakeLists.txt` is WASM-only (no `WASM=OFF` toggle) and the vendor submodule uses qmake+Qt, so a native cmake build is not viable without significant CMakeLists.txt surgery that is out of scope for this plan.

## Open Questions

### Resolved During Planning

- **Input format**: OWL 2 XML — avoids Redland build requirement; all six cases hand-writable (see Key Technical Decisions)
- **Golden file strategy**: Commit native verdicts as JSON; test reads JSON at runtime — decouples CI from binary (see Key Technical Decisions)
- **Fixture format for WASM side**: WASM tests use inline Turtle (same as existing consistency tests) parsed by n3; no separate NTriples fixtures needed for these small cases

### Deferred to Implementation

- Exact Konclude CLI exit codes for each verdict — verify during Unit 3 execution (documented behavior is 0 = consistent, 10 = inconsistent, but confirm empirically)
- Whether native Konclude also times out on cases 5 and 6 — determines whether those are WASM-port performance gaps or upstream limitations
- Exact OWL 2 XML representation of `owl:AsymmetricProperty`, `owl:IrreflexiveProperty`, and `owl:maxQualifiedCardinality` — the vendor test suite has no examples of these; use the [W3C OWL 2 XML Syntax specification](https://www.w3.org/TR/owl2-xml-serialization/) as the authoritative reference and validate against the binary during Unit 2

## Implementation Units

- [ ] **Unit 1: Acquisition script for native Konclude binary**

**Goal:** Provide a reproducible, documented way to get a native Konclude binary runnable on the developer's machine.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `scripts/acquire-native-konclude.sh`
- Modify: `.gitignore` — add `vendor/konclude/Binaries/`

**Approach:**
- Script fetches the latest Linux static binary from the Konclude GitHub Releases page (the ThHanke/Konclude or konclude/Konclude release assets), places it at `vendor/konclude/Binaries/Konclude`, and `chmod +x`
- Script prints the binary version string after installation to confirm it executes
- `vendor/konclude/Binaries/` must be in `.gitignore`; if absent, add it
- Note: a cmake native-build fallback is intentionally not provided — the project CMakeLists.txt is WASM-specific and the vendor uses qmake; building natively requires out-of-scope CMakeLists.txt work

**Test expectation:** none — acquisition script; verified by running it and observing the binary executes

**Verification:**
- `vendor/konclude/Scripts/Konclude --help` exits 0 after running the script
- `vendor/konclude/Binaries/Konclude` exists and is executable

---

- [ ] **Unit 2: OWL 2 XML fixtures for all six issue #13 cases**

**Goal:** Six committed OWL 2 XML files representing each violation case, usable directly as native Konclude input.

**Requirements:** R2

**Dependencies:** Unit 1 (to verify the fixture is accepted by native Konclude during authoring)

**Files:**
- Create: `tests/fixtures/issue13/case1-disjoint-direct.owl`
- Create: `tests/fixtures/issue13/case2-disjoint-by-inference.owl`
- Create: `tests/fixtures/issue13/case3-asymmetric-property.owl`
- Create: `tests/fixtures/issue13/case4-irreflexive-property.owl`
- Create: `tests/fixtures/issue13/case5-max-qualified-cardinality.owl`
- Create: `tests/fixtures/issue13/case6-allvaluesfrom-disjoint.owl`

**Approach:**
- OWL 2 Functional Syntax or OWL 2 XML — use whichever Konclude accepts without Redland; verify against `vendor/konclude/Tests/` syntax examples
- Each fixture encodes exactly the Turtle from issue #13 translated to the OWL 2 format; use `http://example.org/reasoner-test#` as the base IRI to match the existing inline Turtle tests
- Validate each fixture by running `vendor/konclude/Scripts/Konclude consistency -i <file>` once the binary is acquired (Unit 1 prerequisite)
- OWL 2 XML syntax reference for property characteristics and restrictions: [W3C OWL 2 XML Syntax](https://www.w3.org/TR/owl2-xml-serialization/) — the vendor test suite has no examples of AsymmetricProperty/IrreflexiveProperty/maxQualifiedCardinality

**Test expectation:** none — static fixture files; validated by the native runner in Unit 3

**Verification:**
- All six files pass Konclude XML parsing without error (not necessarily the expected verdict — that is Unit 3's job)
- Cases 1 and 2 return `inconsistent` when run against the binary — confirms fixture correctness before proceeding to the remaining cases

---

- [ ] **Unit 3: Native runner script and committed golden verdicts**

**Goal:** Run native Konclude on all six cases, record each verdict, and commit the result as `tests/fixtures/issue13-native-verdicts.json`.

**Requirements:** R3

**Dependencies:** Unit 1 (binary), Unit 2 (fixtures)

**Files:**
- Create: `scripts/run-native-issue13.sh`
- Create: `tests/fixtures/issue13-native-verdicts.json`

**Approach:**
- Shell script iterates over the six OWL 2 XML fixtures; for each:
  - Runs `vendor/konclude/Scripts/Konclude consistency -i <fixture>` wrapped in `timeout 30`
  - Determines verdict from exit code: `0` → `"consistent"`, `10` → `"inconsistent"`, `124` (from `timeout(1)`) → `"timeout"`, any other non-zero → `"error"` with the code recorded
  - Records: `"verdict": "inconsistent" | "consistent" | "timeout" | "error"` and `"exitCode": <n>` for traceability
- Output is a JSON array: `[{ "case": 1, "name": "...", "verdict": "inconsistent" }, ...]`
- Script is run once by the developer; output is reviewed and committed to `tests/fixtures/issue13-native-verdicts.json`
- The committed JSON becomes the ground truth for Unit 4

**Test expectation:** none — script and data file; correctness verified by inspection against expected OWL-DL semantics

**Verification:**
- `tests/fixtures/issue13-native-verdicts.json` is committed with verdicts for all six cases
- At least cases 1 and 2 show `"verdict": "inconsistent"` (known correct from OWL-DL semantics)

---

- [ ] **Unit 4: Integration test comparing WASM to native ground truth**

**Goal:** Integration test file that runs WASM `checkConsistency` on all six cases and asserts each verdict matches the committed native golden file.

**Requirements:** R4

**Dependencies:** Unit 3 (golden JSON committed), WASM binary present

**Files:**
- Create: `tests/integration/issue13-owl-violations.test.ts`
- Test: `tests/integration/issue13-owl-violations.test.ts`

**Approach:**
- `describe.skipIf(!wasmExists)` outer guard — same pattern as `consistency.test.ts`
- Load `tests/fixtures/issue13-native-verdicts.json` at test start
- For each of the six cases, define the ontology as inline Turtle (same quads as the OWL 2 XML fixtures, parsed by n3 into a Store)
- Call `reasoner.checkConsistency(store)` with a per-test timeout of 30 s
- Assert: if native verdict is `"inconsistent"`, WASM must return `false`; if native verdict is `"consistent"`, WASM must return `true`; if native verdict is `"timeout"`, WASM test is marked `todo` (known gap)
- For cases where WASM verdict diverges from native: test fails with a descriptive message identifying the gap type
- `beforeAll` / `afterAll` shared reasoner instance — follow `consistency.test.ts` pattern

**Patterns to follow:**
- `tests/integration/consistency.test.ts` — `describe.skipIf`, `beforeAll`, shared reasoner, 30 s timeout
- `tests/helpers/compare-native.ts` — fixture loading pattern

**Test scenarios:**
- Happy path: case 1 (disjointWith direct) — WASM reports `false` matching native `"inconsistent"`
- Happy path: case 2 (disjointWith by inference) — WASM reports `false` matching native `"inconsistent"`
- Gap detection: case 3 (AsymmetricProperty) — if native is `"inconsistent"` and WASM returns `true`, test fails with message "WASM port gap: AsymmetricProperty violation not detected"
- Gap detection: case 4 (IrreflexiveProperty) — same pattern
- Performance gap: case 5 — if native is `"inconsistent"` and WASM times out, test is `todo` annotated
- Performance gap: case 6 — same pattern
- Edge: if native JSON is missing or malformed, test suite throws a clear fixture-missing error before any WASM calls

**Verification:**
- `npm test` runs the file when WASM is present
- Cases 1 and 2 pass (already known to work)
- Cases 3–6 either pass (WASM gap fixed elsewhere) or fail with a gap-identifying message (expected until fixes land)

---

- [ ] **Unit 5: Gap analysis document**

**Goal:** Produce a solutions document classifying each issue #13 case by gap type, with actionable next steps for each.

**Requirements:** R5

**Dependencies:** Unit 3 (native verdicts known), Unit 4 (WASM verdicts confirmed)

**Files:**
- Create: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`

**Approach:**
- YAML frontmatter: `module: wasm-reasoner-output`, `tags: [capability-gap, owl-dl, violation-detection]`, `problem_type: capability_gap`
- For each case: native verdict, WASM verdict, gap classification, and a brief root-cause hypothesis
- Gap classification taxonomy:
  - `WASM_PORT_GAP` — native detects correctly; WASM does not; fixable in this codebase
  - `UPSTREAM_LIMITATION` — native also fails; inherent in Konclude; not fixable without upstream changes
  - `PERFORMANCE_GAP` — native succeeds within timeout; WASM times out; optimization opportunity
  - `PARITY` — both agree; no gap
- Root-cause hypotheses for known gaps:
  - AsymmetricProperty / IrreflexiveProperty: likely a role-type flag in the ABox pipeline not wired in WASM config; see `SaturationSubsumerExtraction` learning as analogous precedent
  - Cardinality / allValuesFrom: possibly a threading or pipeline stage not enabled in the WASM build; may overlap with the UAF sequential-call fix from `project_realization_classify_dependency.md`
- Section "Next Steps" linking each WASM_PORT_GAP to the appropriate investigation path

**Test expectation:** none — documentation artifact

**Verification:**
- Document exists with frontmatter and verdicts for all six cases
- Gap classification row is present for every case with a non-empty root-cause hypothesis

---

## System-Wide Impact

- **Integration coverage:** Cases 3–6 are expected to fail (or be `todo`) until separate fix PRs land — the test suite intentionally surfaces gaps, not hides them
- **Unchanged invariants:** Existing consistency, classification, and ABox integration tests are unaffected; this adds a new file to `tests/integration/`
- **Golden file lifecycle:** `tests/fixtures/issue13-native-verdicts.json` is a one-time commit that does not change unless native Konclude behavior changes; it is not re-generated by CI
- **Binary not committed:** `vendor/konclude/Binaries/Konclude` stays gitignored; acquisition script is the only artifact that enables re-running

## Risks & Dependencies

| Risk | Mitigation |
| ---- | ---------- |
| Native binary not available for Linux on GitHub Releases | Check both Konclude upstream releases and ThHanke fork releases; if no Linux binary exists, native build requires separate CMakeLists.txt surgery (out of scope — unblock by filing a separate issue) |
| Native Konclude also reports cases 3–4 as consistent (upstream limitation) | Gap classification document captures this as `UPSTREAM_LIMITATION`; no fix is possible in this repo |
| Native times out on cases 5–6 same as WASM (not a WASM gap) | Script records `"timeout": true`; integration test marks those cases `todo` with a clear annotation |
| OWL 2 XML fixtures for cases 3–4 use syntax not in the vendor test suite | Use W3C OWL 2 XML spec as authoritative reference; validate each fixture against the binary before committing |

## Documentation / Operational Notes

- The acquisition script should be run once per developer machine, not in CI
- After Unit 3, update `CLAUDE.md` or the project README with a note that the native binary is required for gap comparison and how to acquire it
- The gap analysis document should be linked from the main `docs/solutions/` index or README so future contributors find it

## Sources & References

- [ontosphere issue #13](https://github.com/ThHanke/ontosphere/issues/13) — violation test cases
- [W3C OWL 2 XML Syntax](https://www.w3.org/TR/owl2-xml-serialization/) — authoritative reference for hand-writing OWL 2 XML fixtures
- Related plan: `docs/plans/2026-05-18-016-fix-native-output-parity-golden-reference-plan.md`
- Institutional learnings: `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`
- Institutional learnings: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- Memory: `project_realization_classify_dependency.md` — UAF fix context for sequential ABox calls
