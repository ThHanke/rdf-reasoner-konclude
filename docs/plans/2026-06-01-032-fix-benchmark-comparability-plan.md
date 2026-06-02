---
title: "fix: Benchmark comparability — matching operations and inferred triple counts across TS, WASM, native"
type: fix
status: complete
date: 2026-06-01
---

# fix: Benchmark comparability — matching operations and inferred triple counts

## Overview

Current bench suite has three cross-runner discrepancies that make comparison unreliable:

1. **LUBM+data TS infers 0 vs WASM 44** — TS uses `materialize()` (ABox-only output) but fixture has no `owl:NamedIndividual` assertions, so realization is never triggered; WASM also skips realization but still reports 44 TBox subClassOf triples via `getInferredNTriples()`.
2. **Roberts TS 353 114 vs WASM 353 200 (86 gap)** — different counting methods: WASM counts raw NTriples lines; TS counts quads in the N3 Store's INFERRED_GRAPH_IRI. Root cause unknown (dedup, sameAs symmetry, literal normalization).
3. **Native never counts inferred triples** — `native-runner.mjs` captures only timing; no cross-check that native produces correct output.

Secondary issue: the bench.mjs Markdown table does not surface inferred counts per runner, so discrepancies are only visible in stderr progress output, not in the saved artifact.

## Problem Frame

Benchmarks are only meaningful if all three runners exercise the same reasoning depth and we can verify they produce equivalent output. Right now:
- The table shows `NTriples` = input fixture size, not inferred output size.
- Inferred counts only appear in stderr and differ between TS and WASM.
- Native cannot be cross-checked at all.

## Requirements Trace

- R1. For every ontology case, all runners that support it use the same reasoning operation (TBox classify or ABox realization).
- R2. WASM and TS inferred triple counts match (or a documented, understood delta is recorded in the plan).
- R3. Native inferred triple count is captured and compared to WASM.
- R4. The bench.mjs Markdown table exposes inferred counts per runner so discrepancies are visible in the saved artifact.
- R5. The LUBM+data case produces a non-zero and consistent inferred count across TS and WASM.

## Scope Boundaries

- No changes to reasoning logic or WASM binary.
- No new ontology fixtures beyond lubm-data.nt patching.
- Native runner changes are limited to capturing stdout/file output for triple counting; no timing changes.
- Binary runner (`binary-runner.mjs`) is not touched.

## Context & Research

### Relevant Code and Patterns

- `tests/bench/ts-runner.mjs` — TS benchmark, now uses `abox` flag (added today); `materialize(store)` for ABox cases
- `tests/bench/wasm-runner.mjs` — always calls `realization()`, counts via `countTriples(nt)` (raw NTriples line count)
- `tests/bench/native-runner.mjs` — Docker-based; no inferred triple counting; timing only
- `tests/bench/bench.mjs` — table generation; iterates WASM_CASES; pulls from 4 result maps
- `src/KoncludeReasoner.cpp` — `mHasIndividualsHint` set only when `rdf:type owl:NamedIndividual` found in `loadTripleBuffer()`
- `ts/index.ts` `_materializeOnStore` — writes ABox (rdf:type) entailments to INFERRED_GRAPH_IRI; TBox (subClassOf) entailments NOT written
- `tests/fixtures/lubm-data.nt` — 0 `owl:NamedIndividual` assertions; individuals declared via domain class membership only

### Key Observed Facts

- `mHasIndividualsHint = false` for LUBM+data → `runPipeline` skips realization → only TBox classification runs.
- WASM `getInferredNTriples()` returns all inferences (TBox + ABox) regardless of `mRealized` → captures 44 subClassOf triples.
- TS `materialize(store)` only writes ABox entailments to store → writes 0 when realization skipped → TS sees 0.
- Roberts 86 gap: 86 = 2 × 43. Plausible cause: owl:sameAs symmetry (43 pairs × 2 directions) or N3 Store dedup of near-duplicate triples. Needs confirmation.

## Key Technical Decisions

- **LUBM+data fixture patch vs `abox: false`**: Patching `lubm-data.nt` to add explicit `rdf:type owl:NamedIndividual` per individual is the correct long-term fix — it makes LUBM+data a genuine ABox benchmark. Changing the case to `abox: false` is a short-term workaround that masks the real issue and doesn't test ABox realization at all for LUBM. Chosen: patch the fixture.
- **Native triple counting mechanism**: Native Konclude writes inferred triples to a file (`-e <output.nt>` flag) or to a format-specific output. The Docker invocation in `native-runner.mjs` uses Konclude's CLI; need to add `-e /tmp/out.nt` and count lines in that file after each run. Alternative (parse native stdout) is fragile. Chosen: `-e` output file.
- **Table inferred count columns**: Add one "Inferred" column per runner trio (WASM | TS | Native) rather than embedding in existing columns, so mismatches are immediately visible. No change to existing timing columns.

## Open Questions

### Resolved During Planning

- **Why does WASM report 44 for LUBM+data when hint is false?** — `getInferredNTriples()` always returns all inferences including TBox; `mRealized = false` only suppresses the ABox section in the output function if it runs `classify` path. Actually: `mRealized` gates ABox output; `mClassified = true` gates TBox output. So WASM emits 44 TBox subClassOf even when realization skipped.
- **Why does TS report 0 for LUBM+data?** — `_materializeOnStore` writes only ABox (rdf:type) quads to INFERRED_GRAPH_IRI; TBox subClassOf quads are NOT written to the store. With no ABox realization, 0 ABox quads → 0.

### Deferred to Implementation

- **Exact count of NI assertions needed for LUBM+data individuals**: Count distinct subject IRIs in `lubm-data.nt` and generate the patch programmatically.
- **Whether Roberts 86-triple delta is sameAs symmetry or dedup**: Confirmed or refuted by adding a diagnostic log during one run; plan describes the investigation approach.
- **Native Konclude `-e` flag exact syntax**: Verify in `docker run konclude/konclude:latest classification --help` output before implementing.

## Implementation Units

- [ ] **Unit 1: Diagnose and fix Roberts TS 353 114 vs WASM 353 200 (86-triple gap)**

**Goal:** Understand why TS and WASM inferred counts differ by 86 for Roberts family, then either close the gap or document it as an accepted delta with explanation.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `tests/bench/ts-runner.mjs`
- Modify: `tests/bench/wasm-runner.mjs` (if counting method needs alignment)
- Modify: `tests/bench/bench.mjs` (table footnote or delta annotation)

**Approach:**
- Run Roberts and dump both the raw NTriples from WASM (`countTriples` input) and the store quads from TS to a temp file for diff comparison.
- Likely finding: WASM emits owl:sameAs both directions (A→B and B→A), N3 Store deduplicates one direction OR the `countTriples` function includes a blank trailing line. 86 = 2 × 43 strongly suggests 43 sameAs pairs × 2 directions.
- If cause is confirmed sameAs symmetry: both WASM and TS are correct but measure different things. Document as known delta in table footnote: "Roberts TS count excludes symmetric sameAs triples omitted by N3 Store dedup."
- If cause is WASM counting artefact (blank lines): fix `countTriples` to exclude trailing empty lines more carefully.
- Align counting method if feasible without changing reasoning output.

**Test scenarios:**
- Happy path: after fix/alignment, WASM and TS Roberts inferred counts match exactly OR a footnote explains the documented delta with its exact value.
- Edge case: if sameAs symmetry is the cause, verify that both `A sameAs B` and `B sameAs A` are present in WASM NTriples output and only one or both are in TS store.
- Verification: `npm run bench` stderr shows same inferred count for Roberts across TS and WASM (or documents known delta).

**Verification:**
- Roberts TS count = Roberts WASM count, or bench table carries a footnote with exact delta and confirmed root cause.

---

- [ ] **Unit 2: Fix LUBM+data TS inferred 0 — patch fixture with explicit owl:NamedIndividual assertions**

**Goal:** Make LUBM+data a genuine ABox benchmark by adding `rdf:type owl:NamedIndividual` for each individual in the fixture, so `mHasIndividualsHint = true` and realization fires for both WASM and TS.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `tests/fixtures/lubm-data.nt` (add NI triples)
- Modify: `tests/bench/ts-runner.mjs` (LUBM+data case confirmed `abox: true`)

**Approach:**
- Extract all distinct subject IRIs from `lubm-data.nt` that have `rdf:type <domain-class>` assertions but no existing `rdf:type owl:NamedIndividual`.
- Append `<IRI> <rdf:type> <owl:NamedIndividual> .` for each.
- Run benchmark to verify both WASM and TS now infer non-zero ABox (rdf:type) triples and counts align.
- Expected: individual type entailments for LUBM class hierarchy (UndergraduateStudent rdf:type Student, Person, etc.).
- If post-patch WASM and TS inferred counts still differ: investigate same way as Unit 1.

**Test scenarios:**
- Happy path: LUBM+data TS inferred count > 0 and matches WASM inferred count after fixture patch.
- Edge case: verify existing LUBM schema TBox tests (LUBM schema TBox-only row) are unaffected by the fixture change (they load only `lubm.nt`, not `lubm-data.nt`).
- Error path: if NI assertions cause Konclude to produce incorrect inferences, compare against native Konclude LUBM+data realization output.

**Verification:**
- `tests/bench` LUBM+data TS and WASM inferred counts are equal and non-zero.
- All other benchmark rows are unchanged.

---

- [ ] **Unit 3: Add inferred triple counting to native runner**

**Goal:** Capture Konclude's inferred NTriples output count in `native-runner.mjs` so native can be cross-checked against WASM/TS.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `tests/bench/native-runner.mjs`

**Approach:**
- Investigate Konclude CLI flag for inferred output. Likely `-e <output.nt>` or `-oe nt <output.nt>`. Verify via `docker run konclude/konclude:latest --help`.
- Add `-e /tmp/native-inferred.nt` (or equivalent) to the Docker command for classification and realization runs.
- After each Docker run, copy the output file from the container and count lines via the same `countTriples` logic as `wasm-runner.mjs`.
- Attach `inferredTriples` field to the native result object.
- If Konclude writes to stdout instead of a file: parse the reasoning log output for the triple count, or redirect stdout to a temp file.

**Test scenarios:**
- Happy path: `nc.result.inferredTriples` is populated and non-null for all four ontologies after fix.
- Edge case: TBox-only ontologies (LUBM schema, GALEN) should return only subClassOf/equivalentClass inferences; ABox ontologies (Roberts, LUBM+data) should return individual type + role inferences.
- Error path: if the Docker container output file mechanism fails, runner falls back to `null` with a warning rather than crashing.

**Verification:**
- Native inferred counts are non-null in `native-runner.mjs` result objects.
- Native counts are within expected range relative to WASM counts (same order of magnitude; exact match not required since native uses OWL XML input format, which may include additional inferences).

---

- [ ] **Unit 4: Surface inferred triple counts in bench.mjs Markdown table**

**Goal:** Add inferred count columns for WASM, TS, and Native to the table so discrepancies are visible in the saved `bench-results.md` artifact, not only in stderr.

**Requirements:** R4

**Dependencies:** Unit 1, Unit 2, Unit 3 (columns only meaningful once counts are reliable)

**Files:**
- Modify: `tests/bench/bench.mjs`

**Approach:**
- Add three new columns after the existing `TS total ³` column: `WASM inferred`, `TS inferred`, `Native inferred`.
- Populate from `wc.result.inferredTriples`, `tc.result.inferredTriples`, `nc.result.inferredTriples`.
- Format as plain integer (no `ms` suffix). Show `—` when unavailable.
- For Roberts: show documented delta in a new footnote if counts differ (see Unit 1 outcome).
- Update column header separator and footnotes section accordingly.
- Remove the duplicate `LUBM+data native input` footnote line (appears twice in current output).

**Test scenarios:**
- Happy path: `npm run bench` produces table with all three inferred count columns populated for all four rows.
- Edge case: if native inferred is unavailable (Unit 3 not yet merged), column shows `—` gracefully.
- Verification: after all four units land, WASM and TS inferred counts match on at least LUBM schema, GALEN, and (post-fix) LUBM+data rows.

**Verification:**
- `bench-results.md` Markdown table has inferred count columns visible.
- No duplicate footnote lines.

## System-Wide Impact

- **Unchanged invariants:** All timing columns (Native reasoning, WASM classify, TS total, Enc binary, Ratio) are unchanged. No changes to reasoning paths or WASM binary.
- **Fixture change scope:** `lubm-data.nt` patch affects only the LUBM+data benchmark row; LUBM schema (TBox-only) loads only `lubm.nt` and is unaffected.
- **API surface:** No public API changes. `ts-runner.mjs` and `bench.mjs` are internal tooling.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Native Konclude CLI flag for inferred output is undocumented or differs between versions | Check `--help` in Docker container before implementing; fall back to null gracefully |
| lubm-data.nt NI patch causes Konclude to infer many more triples than expected, making WASM 44 wrong | Re-run WASM and TS after patch; compare against native realization output |
| Roberts delta is not sameAs symmetry but a genuine counting bug | The investigation in Unit 1 is explicit; if unexpected, adjust counting method to align before adding table columns |
| Large lubm-data.nt fixture patch file (many NI triples) increases repo size noticeably | Generate patch programmatically from existing subject IRIs; verify size is acceptable (lubm-data.nt is already 100k+ quads) |

## Sources & References

- Current bench results: `bench-results.md`
- Benchmark runners: `tests/bench/`
- Individual hint detection: `src/KoncludeReasoner.cpp` `loadTripleBuffer()` lines 466–484
- Materialize ABox-only note: `ts/index.ts` `_materializeOnStore`
- LUBM fixture: `tests/fixtures/lubm-data.nt`
