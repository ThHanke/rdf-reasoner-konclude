---
plan: "053"
title: "BlackBox Deprecation — Native Justification for All Entailment Types"
status: active
created: 2026-07-20
origin: docs/plans/2026-07-20-052-feat-expand-native-justification-coverage-plan.md
tracks:
  - id: B
    label: "TS-only workaround synthesis + probe fix"
    wasm_rebuild: false
    target: v0.6.0
  - id: A
    label: "Tableau dep-chain interception + axiom reverse mapping"
    wasm_rebuild: true
    target: v0.7.0
  - id: "B+1"
    label: "Complex workaround synthesis (depends on A1)"
    wasm_rebuild: true
    target: v0.7.0
  - id: final
    label: "justificationMode option + docs"
    wasm_rebuild: false
    target: v0.7.0
---

# Plan 053: BlackBox Deprecation — Native Justification for All Entailment Types

## Problem Frame

`explainEntailment()` currently falls back to the BlackBox algorithm (axiom-removal + WASM reload) for most entailment types. This costs 5-13s per call vs ~1ms for the native dep-chain path. Only `rdfs:subClassOf` and `rdf:type` (via subClassOf chain) have native justifications today.

Plan-052 research proved that **every** entailment type Konclude computes is backed by a tableau sat test with an accessible dep chain or clash descriptor. The "BlackBox only" labels from the initial R3 assessment were wrong — they reflected missing interception points, not missing proofs. Additionally, 6 workaround-computed types (Category C) bypass the tableau entirely but have trivially constructible justifications from their input data.

**Goal:** Eliminate BlackBox as the default explanation path for `explainEntailment()`. Keep it only for `explainInconsistency` (MIPS genuinely needs axiom-removal) and as opt-in `justificationMode: "minimal"` for users needing guaranteed-minimal axiom sets.

## Scope Boundary

**In scope:**
- TS-layer justification synthesis for workaround-computed types (Track B)
- Data property probe fix (Track B)
- C++ axiom reverse mapping infrastructure (Track A)
- Clash-path dep chain interception via patch (Track A)
- Classification analyser enrichment (Track A)
- JustificationCache schema extension + thread safety fix (Track A)
- `justificationMode` API option (final)
- README API documentation for entailment coverage

**Out of scope:**
- `explainInconsistency` / `explainInconsistencyLaconic` changes (keep BlackBox)
- Post-hoc minimization of native justifications (deferred — see Open Questions)
- Multiple native justifications per entailment (single proof path only)
- CAreAxiomsEntailedQuery optimization (deprioritized per memory)

## Three Interception Mechanisms

1. **Tableau dep-chain capture** (Track A: IU-A3, IU-A4) — intercept `CClashedDependencyDescriptor` in tableau catch blocks and enrich classification analyser for Category A types
2. **Workaround synthesis** (Track B: IU-B2; Track B+1: IU-B+1) — for Category C types that bypass tableau, input data IS the justification
3. **TS probe fix** (Track B: IU-B3) — extend `classifyAxiom` to handle data properties and additional predicates

## Entailment Type Coverage Matrix

| Entailment Type | Current | Target | Delivered by | Track |
|----------------|---------|--------|-------------|-------|
| rdfs:subClassOf | Native (tags only) | Native (axioms + enriched) | IU-A4 | A |
| owl:equivalentClass | BlackBox | Native | IU-A4 (bidirectional subClassOf) | A |
| owl:disjointWith | BlackBox | Native | IU-A4 (classification side-effect) | A |
| rdf:type (all paths) | Partial native / BlackBox | **Native** | IU-A3 (clash hook) | A |
| Object property assertions | BlackBox | **Native** | IU-A3 (clash hook) | A |
| owl:sameAs (native) | BlackBox | **Native** | IU-A3 (clash hook) | A |
| rdfs:subPropertyOf | BlackBox | **Native** | IU-A3 (clash hook) | A |
| rdfs:domain/range | BlackBox | Native | IU-A4 (GCI in taxonomy) | A |
| FP/IFP → owl:sameAs | None | **Synthesized** | IU-B2 | B |
| disjointUnionOf → subClassOf | None | **Synthesized** | IU-B2 | B |
| owl:oneOf → rdf:type | None | **Synthesized** | IU-B2 | B |
| equivalentProperty | None | **Synthesized** | IU-B2 | B |
| someValuesFrom → rdf:type | None | **Synthesized** (chain) | IU-B+1 | B+1 |
| minCardinality → rdf:type | None | **Synthesized** | IU-B+1 | B+1 |
| Data property assertions | Broken (returns "unsupported") | **Fixed** | IU-B3 | B |
| **BlackBox for entailment** | **Primary fallback** | **Opt-in** (`"minimal"` mode) | IU-7 | final |
| BlackBox for inconsistency | Required | **Retained** (MIPS) | — | — |

## Dependency Graph

```
Track B (TS-only, no WASM rebuild — ships first):
  IU-B1 (extend ProbeKind) ──→ IU-B2 (TS workaround synthesis)
  IU-B1 ──→ IU-B3 (data property probe fix)
  IU-B2 + IU-B3 ──→ IU-B4 (tests)
  IU-B5 (README update) — independent

Track A (C++ + WASM rebuild):
  IU-A1 (axiom reverse mapping) ─┬─→ IU-A3 (clash-path hook)
                                 ├─→ IU-A4 (analyser enrichment)
                                 └─→ IU-A2 (cache schema extension)
  IU-A3 + IU-A4 ──→ IU-A5 (TS integration)
  IU-A5 ──→ IU-A6 (tests)

Track B+1 (depends on IU-A1):
  IU-A1 ──→ IU-B+1 (someValuesFrom + minCardinality)

Final (after all tracks):
  All complete ──→ IU-7 (justificationMode + BlackBox opt-in)
```

## Open Questions Resolved

**P1 — R3 vs R6 contradiction (from plan-052 review):**
R3 marked object properties/sameAs/subPropertyOf as "NOT FEASIBLE (native)". Follow-up research (2026-07-20) overturned this by finding `CIndividualDependenceTrackingCollector` is wired to realization sat jobs and clash descriptors carry full dep chains. R6 represents the corrected understanding. No bridge paragraph needed in plan-053 — this plan supersedes R3 findings.

**P2 — No fallback if catch-block patch regresses:**
Ship Step 7 (`justificationMode`) before removing BlackBox fallback entirely. The `"minimal"` mode retains the full BlackBox path. Additionally, the clash-path patch (IU-A3) can be feature-flagged with `#ifdef WASM_JUSTIFICATION_HOOK` in the patch — if regression detected, disable at build time and BlackBox remains available.

**P2 — Non-minimal justification UX:**
Native dep chain justifications are supersets of MIPS. For v0.7.0, document the difference clearly in README. Post-hoc minimization (greedy axiom removal on dep chain subset, bounded by chain length ~5-20 axioms, sub-ms) deferred to v0.8.0 — see Open Questions below.

**P2 — JustificationCache schema design:**
Extend Key with `entailmentType` discriminator enum:
```
enum EntailmentType { Classification = 0, Realization = 1, PropertySubsumption = 2 };
struct Key { int64_t subTag; int64_t superTag; EntailmentType type = Classification; ... };
```
Existing classification entries use `type=Classification` (backward-compatible default). Realization entries: `subTag` = individual concept tag, `superTag` = target concept/role tag. Property subsumption: `subTag` = sub-property tag, `superTag` = super-property tag.

## Implementation Units

---

### IU-B1: Extend ProbeKind and classifyAxiom

**Track:** B | **Depends on:** — | **WASM rebuild:** No

Extend `classifyAxiom()` to recognize additional OWL predicates for workaround-covered types. Currently returns "unsupported" for everything except `rdfs:subClassOf` and `rdf:type`.

**New ProbeKind values:** `"sameAs"`, `"equivalentProperty"`, `"disjointWith"`

**Approach:**
- Add predicate IRI constants for `owl:sameAs`, `owl:equivalentProperty`, `owl:disjointWith`
- `classifyAxiom` returns appropriate kind regardless of `objectIsClassLike` for property/individual-level predicates
- `objectIsClassLike` gate only applies to class-level predicates (`subClassOf`, `type`, `disjointWith`, `equivalentClass`)

**Files:**
- `ts/entailmentProbe.ts` — extend ProbeKind union type, add IRI constants, update classifyAxiom
- `tests/unit/entailmentProbe.test.ts` — test new predicate recognition

**Test scenarios:**
1. `owl:sameAs` returns `"sameAs"` kind
2. `owl:equivalentProperty` returns `"equivalentProperty"` kind
3. `owl:disjointWith` with `objectIsClassLike=true` returns `"disjointWith"` kind
4. Unknown predicates still return `"unsupported"`
5. `objectIsClassLike=false` with class-level predicates still returns `"unsupported"`

---

### IU-B2: TS Workaround Justification Synthesis

**Track:** B | **Depends on:** IU-B1 | **WASM rebuild:** No

For workaround-computed entailment types (Category C "easy"), construct justifications in TS by scanning the store for the relevant axiom patterns. No C++ changes needed — the TS layer has full store access.

**Strategy:** When `explainEntailment` receives a recognized workaround-type predicate, instead of falling through to BlackBox, scan the store for the axiom pattern that produces the entailment and return those axioms as the justification.

**Four synthesis paths:**

1. **FP/IFP → owl:sameAs** (`a owl:sameAs b`):
   - Scan store for `owl:FunctionalProperty` / `owl:InverseFunctionalProperty` declarations
   - For each FP: find property `R` where both `a R x` and `b R x` exist (same filler → sameAs)
   - For each IFP: find property `R` where both `x R a` and `x R b` exist
   - Justification = FP/IFP declaration triple + the two role assertions
   - If no FP/IFP pattern found, fall through to BlackBox (or native once Track A ships)

2. **disjointUnionOf → rdfs:subClassOf** (`Member rdfs:subClassOf UnionClass`):
   - Check if objectIri has an `owl:disjointUnionOf` axiom in store
   - Verify subjectIri is a member of the RDF list
   - Justification = the disjointUnionOf triples (class + list nodes)

3. **owl:oneOf → rdf:type** (`individual rdf:type OneOfClass`):
   - Check if objectIri has an `owl:oneOf` axiom with an RDF list containing subjectIri
   - Justification = oneOf axiom triples (class + list nodes)

4. **equivalentProperty** (`P owl:equivalentProperty Q`):
   - Direct store lookup: `P owl:equivalentProperty Q` or `Q owl:equivalentProperty P`
   - Justification = the equivalentProperty triple itself

**Files:**
- `ts/index.ts` — extend `explainEntailment` with new probe kind handlers before BlackBox fallback
- `ts/entailmentProbe.ts` — helper utilities for RDF list walking, FP/IFP scanning

**Test scenarios:**
1. FP/IFP sameAs: two individuals with same filler for functional property → justification contains FP declaration + both role assertions
2. FP/IFP sameAs: no matching FP/IFP → falls through to next path
3. disjointUnionOf: member class → justification contains disjointUnionOf triples
4. oneOf: individual in oneOf list → justification contains oneOf triples
5. equivalentProperty: direct triple → justification is that triple
6. All synthesis paths return `isEntailed: true` with non-empty justifications
7. Workaround types with `nativeOnly: true` skip BlackBox but still attempt TS synthesis

---

### IU-B3: Data Property Probe Fix

**Track:** B | **Depends on:** IU-B1 | **WASM rebuild:** No

Fix `classifyAxiom()` behavior when `objectIsClassLike` is false (literal objects). Currently returns "unsupported" unconditionally, meaning data property entailments can never be explained.

**Approach:**
- When `objectIsClassLike` is false and predicate is `rdf:type`, still return `"type"` (rdf:type of a literal-named class is valid)
- For data property assertions (arbitrary predicate, literal object), return `"dataProperty"` kind
- `explainEntailment` for `"dataProperty"` kind: direct store lookup — if triple exists in base, justification = the triple itself (asserted fact)
- For inferred data properties: fall through to BlackBox until Track A ships

**Files:**
- `ts/entailmentProbe.ts` — add `"dataProperty"` to ProbeKind, update classifyAxiom logic
- `ts/index.ts` — handle `"dataProperty"` kind in explainEntailment
- `tests/unit/entailmentProbe.test.ts` — test literal-object handling

**Test scenarios:**
1. `objectIsClassLike=false` with arbitrary predicate → `"dataProperty"` kind
2. Asserted data property triple → `isEntailed: true`, justification = that triple
3. Non-asserted data property → `isEntailed: false`

---

### IU-B4: Track B Tests

**Track:** B | **Depends on:** IU-B2, IU-B3 | **WASM rebuild:** No

Integration tests for all Track B justification synthesis paths.

**Files:**
- `tests/unit/RdfReasoner.explainEntailment.test.ts` — extend existing test file with workaround synthesis tests

**Test scenarios:**
1. FP/IFP sameAs entailment with justification
2. disjointUnionOf subClassOf entailment with justification
3. oneOf type entailment with justification
4. equivalentProperty entailment with justification
5. Data property entailment (asserted)
6. Combined: workaround type with `nativeOnly: true` still returns synthesis justification
7. Unknown predicate still returns `isEntailed: asserted-only` with empty justifications

---

### IU-B5: README API Documentation Update

**Track:** B | **Depends on:** — | **WASM rebuild:** No

Update README.md with entailment coverage documentation. Currently `explainEntailment` is not documented at all — only `explain` (BlackBox) has a section.

**Additions:**
1. New `### Explaining an entailment (explainEntailment)` section after the `explain` section
2. Entailment type coverage table showing which types have native justifications
3. Speed comparison: native (~1ms) vs BlackBox (5-13s)
4. `nativeOnly` option documentation
5. Code example for `explainEntailment`
6. Note about justification content: native = causal proof path (may be non-minimal), BlackBox = guaranteed minimal axiom set

**Files:**
- `README.md` — add new section between "Explaining an entailment (explain)" and "Diagnosing an inconsistency"

**Test scenarios:** N/A (documentation only)

---

### IU-A1: Axiom Reverse Mapping Infrastructure

**Track:** A | **Depends on:** — | **WASM rebuild:** Yes

Expose `CExpressionDataBoxMapping` bidirectional hashes through `KoncludeReasoner` C++ API. This provides the foundation for converting concept tags (from dep chains) back to axiom triples.

**Chain:** `CConcept` → `mConceptClassTermHash` → `CClassTermExpression*` → `mClassTermClassAxiomHash` → `CClassAxiomExpression*`

**Approach:**
- Add `getAxiomsForConceptTag(int64_t tag)` to `KoncludeReasoner`
- Access `CExpressionDataBoxMapping` through `mImpl->mOntology->getDataBoxes()->getExpressionDataBoxMapping()`
- Walk the hash chain: tag → `CConcept*` (from concept vector) → expression → axiom expressions
- Serialize axiom expressions to N-Triples for JS consumption
- Also add `getAxiomsForRoleTag(int64_t tag)` for role-based entailments

**Files:**
- `src/KoncludeReasoner.h` — add `getAxiomsForConceptTag`, `getAxiomsForRoleTag` declarations
- `src/KoncludeReasoner.cpp` — implement reverse mapping walks
- `src/bindings.cpp` — expose new methods via Embind

**Test scenarios:**
1. Known concept tag → returns non-empty N-Triples string with axiom triples
2. Unknown concept tag → returns empty string
3. Role tag → returns property axiom triples
4. Multiple axioms for one concept → returns all

**Institutional learnings to follow:**
- INV-1: reverse mapping state must be valid across calls (read-only access to ontology structures — no per-call state needed)
- Build: maintain `-flto` on all modules, use `unordered_map` not `std::map`

---

### IU-A2: JustificationCache Schema Extension + Thread Safety

**Track:** A | **Depends on:** IU-A1 | **WASM rebuild:** Yes

Extend JustificationCache to support realization and property subsumption entries alongside existing classification entries. Fix the thread safety bug (lookup has no lock).

**Current state:**
```cpp
struct Key { int64_t subTag; int64_t superTag; };
// lookup() has no lock — UB under concurrent reads + writes
```

**Target state:**
```cpp
enum EntailmentType : uint8_t { Classification = 0, Realization = 1, PropertySubsumption = 2 };
struct Key { int64_t subTag; int64_t superTag; EntailmentType type = Classification; };
// Use std::shared_mutex: shared lock for reads, exclusive for writes
```

**Thread safety approach:**
- Replace `std::mutex` with `std::shared_mutex` (verify Emscripten pthreads support first — not currently used in codebase)
- `lookup()` acquires `std::shared_lock`
- `insert()` acquires `std::unique_lock`
- Fallback: if `shared_mutex` not supported under Emscripten, use regular `mutex` on both paths (correctness over performance)

**Backward compatibility:** Existing classification entries automatically get `type=Classification` (default enum value). Existing `insert(subTag, superTag, implTags)` signature adds overload with `EntailmentType` parameter; old 3-arg form defaults to `Classification`.

**Files:**
- `src/JustificationCache.h` — extend Key, add EntailmentType enum, fix thread safety

**Test scenarios:**
1. Classification entries still work with old API
2. Realization entry with different key doesn't collide with classification entry for same (subTag, superTag)
3. Property subsumption entries retrievable
4. Concurrent read during write doesn't crash (WASM integration test)

**Institutional learnings:**
- INV-1: JustificationCache is already a singleton with `clear()` in `reset()` — verify `clear()` still clears all entry types
- `std::shared_mutex` verification: check `__has_include(<shared_mutex>)` in Emscripten, or conditionally compile

---

### IU-A3: Clash-Path Justification Hook

**Track:** A | **Depends on:** IU-A1, IU-A2 | **WASM rebuild:** Yes

Intercept `CClashedDependencyDescriptor` in the two catch blocks of `CCalculationTableauCompletionTaskHandleAlgorithm.cpp` (lines 1342-1352). This is the core interception for all Category A realization types.

**Two catch paths:**
1. `CClashedConceptDescriptor*` (line 1342) — concept-based clash
2. `CCalculationClashProcessingException` (line 1345) — generic clash exception

**Approach:**
- Use `patches/*.patch` (not override — file is 27,680 lines, per CLAUDE.md decision rule)
- In each catch block: extract dep chain from clash descriptor before catch scope exits
- Walk `CDependencyTrackPoint` chain → collect concept tags + dep node types
- Resolve concept tags to axioms via `getAxiomsForConceptTag` (IU-A1)
- Populate `JustificationCache::instance().insert(subTag, superTag, EntailmentType::Realization, axiomTags)`
- Key identification: the testing concept tag and the target concept/role tag must be extracted from the sat task context

**Scope concern:** `CClashedDependencyDescriptor` is catch-block-local. Two strategies:
1. Extract dep chain inline within the catch block (preferred — no scope leak)
2. Persist descriptor pointer to a member field on the enclosing task/algorithm object (riskier — lifetime management)

Choose strategy 1 (inline extraction) to minimize blast radius.

**Feature flag:** Guard with `#ifdef WASM_JUSTIFICATION_HOOK` in patch. Add `-DWASM_JUSTIFICATION_HOOK` to CMakeLists.txt. Can be disabled if regression detected.

**Files:**
- `patches/016-clash-justification-hook.patch` — target catch blocks in `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
- `CMakeLists.txt` — add `-DWASM_JUSTIFICATION_HOOK` compile definition

**Test scenarios:**
1. After realization: `rdf:type` entailment has JustificationCache entry
2. Object property entailment has cache entry
3. sameAs entailment has cache entry (native path, not FP/IFP workaround)
4. subPropertyOf entailment has cache entry
5. Feature flag disabled: no cache entries for realization types, existing classification entries unaffected

**Risks:**
- Patch modifies core tableau algorithm — extensive regression testing required
- Dep chain walk depth: cap at 200 (matching existing analyser pattern) to prevent runaway walks
- Performance: profiling needed with large ABox ontologies (many more sat tests than classification)

**Institutional learnings:**
- Patch workflow: `scripts/new-vendor-patch.sh 016 <vendor-path>` for single-file. After adding: `make reset-patches` before `make build-wasm`
- INV-8 (callback-once): not directly applicable here (no cross-thread callback), but dep chain walk must not hold references to task-scoped memory after task completion

---

### IU-A4: Classification Analyser Enrichment

**Track:** A | **Depends on:** IU-A1 | **WASM rebuild:** Yes

Enrich the existing dep chain extraction in `CSatisfiableTaskClassificationMessageAnalyser.cpp` to capture additional information currently skipped.

**Current state:** Override walks `depTrackPoint` chain, collects concept tags from `IMPLICATION` dep nodes only (lines 1624-1645).

**Enrichments:**
1. Walk `mAdditionalAfterDepLinker` branches (currently skipped) — these carry domain/range GCI derivations
2. Capture dep node type enum alongside concept tags (not just IMPLICATION — also MERGEDCONCEPT, EXPANDEDCONCEPT)
3. Capture role tags when dep node involves role assertions
4. Map domain/range: recognize anonymous GCI restrictions (`∃R.⊤ ⊑ C` for domain, `⊤ ⊑ ∀R.C` for range) and resolve back to original `rdfs:domain`/`rdfs:range` axiom via Step 1 reverse expression mapping
5. Store enriched data in JustificationCache with appropriate key structure

**Files:**
- `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` — enrich dep chain walk

**Test scenarios:**
1. `owl:equivalentClass` entailment: cache contains both direction subsumption entries
2. `owl:disjointWith`: classification side-effect captured in cache
3. `rdfs:domain` inference: GCI restriction mapped back to domain axiom
4. `rdfs:range` inference: GCI restriction mapped back to range axiom
5. Enriched entries don't break existing `rdfs:subClassOf` justification path

---

### IU-A5: TS Integration for Track A Native Paths

**Track:** A | **Depends on:** IU-A3, IU-A4 | **WASM rebuild:** No (TS changes only, but requires Track A WASM to be deployed)

Extend `explainEntailment()` native fast path to use the enriched JustificationCache for all Category A entailment types.

**Current state:** Native path only handles `subClassOf` and `type` (via subClassOf chain). All other types fall through to BlackBox.

**New native paths:**
- `owl:equivalentClass`: check both directions in cache
- `owl:disjointWith`: check classification cache for disjoint marker
- `rdf:type` (realization path): check Realization entries in cache
- Object property assertions: check Realization entries
- `owl:sameAs` (native): check Realization entries
- `rdfs:subPropertyOf`: check PropertySubsumption entries
- `rdfs:domain`/`rdfs:range`: check classification cache (mapped from GCI)

**Files:**
- `ts/index.ts` — extend `explainEntailment` with new cache lookup paths
- `ts/types.ts` — no changes needed (EntailmentResult already sufficient)

**Test scenarios:**
1. Each Category A type returns native justification when cache is populated
2. Cache miss falls through to BlackBox (or returns empty with `nativeOnly: true`)
3. Axiom-level justifications (not just concept tags) appear in returned Quad[][]

---

### IU-A6: Track A Tests

**Track:** A | **Depends on:** IU-A5 | **WASM rebuild:** No (integration tests against deployed WASM)

Integration tests for Track A native justification paths. These require a working WASM build with the clash-path patch.

**Files:**
- `tests/unit/RdfReasoner.explainEntailment.test.ts` — extend with Track A test cases

**Test scenarios:**
1. `rdf:type` via realization: native justification after `materialize()`
2. Object property assertion: native justification
3. `owl:sameAs` (native, not FP/IFP): native justification
4. `rdfs:subPropertyOf`: native justification
5. `owl:equivalentClass`: native justification (bidirectional)
6. `owl:disjointWith`: native justification
7. `rdfs:domain` inference: justification traces back to domain axiom
8. `rdfs:range` inference: justification traces back to range axiom

---

### IU-B+1: someValuesFrom + minCardinality Synthesis

**Track:** B+1 | **Depends on:** IU-A1 | **WASM rebuild:** Yes

Workaround justification synthesis for the two moderate-complexity types that need axiom reverse mapping.

**someValuesFrom → rdf:type:**
- The workaround does a fixpoint propagation: restriction axiom + role assertion → type inference
- Justification = restriction axiom triples + the role assertion + propagation chain
- Needs axiom reverse mapping (IU-A1) to resolve the restriction CConcept back to axiom triples
- Chain tracking: during `buildInferredTripleBuffer` someValuesFrom fixpoint, record which restriction + role assertion produced each inference

**minCardinality → rdf:type:**
- Justification = restriction axiom + role assertions + differentFrom pairs proving sufficient distinct fillers
- Needs axiom reverse mapping for the restriction axiom
- simpler than someValuesFrom — no fixpoint, just counting + distinctness

**Files:**
- `src/KoncludeReasoner.cpp` — add justification tracking in someValuesFrom fixpoint and minCardinality scan sections of `buildInferredTripleBuffer`
- `src/JustificationCache.h` — no schema changes (Realization entries suffice)

**Test scenarios:**
1. someValuesFrom type inference: justification contains restriction + role assertion
2. minCardinality type inference: justification contains restriction + role assertions + differentFrom
3. Multi-step someValuesFrom propagation: justification includes full chain

---

### IU-7: justificationMode Option + BlackBox Deprecation

**Track:** final | **Depends on:** all tracks complete | **WASM rebuild:** No

Add `justificationMode` option to make BlackBox opt-in for entailment explanation.

**API change:**
```typescript
interface ExplainEntailmentOptions extends ExplainOptions {
  objectIsClassLike?: boolean;
  nativeOnly?: boolean;        // existing — deprecate in favor of justificationMode
  justificationMode?: "causal" | "minimal";  // new
}
```

- `"causal"` (default): native dep chain / TS synthesis. Shows HOW the tableau proved it. ~1ms.
- `"minimal"`: BlackBox MIPS. Guaranteed smallest axiom set. 5-13s.
- `nativeOnly: true` becomes equivalent to `justificationMode: "causal"` — deprecate with console.warn

**Behavior:**
- `justificationMode: "causal"` (default): use native paths from Tracks A/B/B+1. No BlackBox fallback. If native path misses (shouldn't happen after full implementation), return `isEntailed: true` with empty justifications.
- `justificationMode: "minimal"`: full BlackBox path (existing behavior)
- `explainInconsistency` / `explainInconsistencyLaconic`: always BlackBox, unaffected

**Files:**
- `ts/types.ts` — add `justificationMode` to `ExplainEntailmentOptions`
- `ts/index.ts` — route by justificationMode in `explainEntailment`
- `README.md` — update entailment docs with justificationMode

**Test scenarios:**
1. Default mode uses native/synthesis paths (no BlackBox calls)
2. `justificationMode: "minimal"` triggers BlackBox path
3. `nativeOnly: true` logs deprecation warning, behaves as `"causal"`
4. `explainInconsistency` unaffected by justificationMode

---

## Execution Sequence

### Phase 1: Track B (no WASM rebuild)
1. IU-B1 → IU-B2 + IU-B3 (parallel) → IU-B4 → IU-B5
2. Ship as v0.6.0
3. Validates TS synthesis approach before investing in C++ work

### Phase 2: Track A (WASM rebuild)
1. IU-A1 (axiom reverse mapping — foundation)
2. IU-A2 (cache schema) + IU-A3 (clash hook) + IU-A4 (analyser enrichment) — parallel after IU-A1
3. IU-B+1 (someValuesFrom + minCardinality) — parallel with IU-A3/A4, depends only on IU-A1
4. IU-A5 (TS integration) → IU-A6 (tests)
5. Ship as v0.7.0

### Phase 3: Finalize
1. IU-7 (justificationMode + deprecation)
2. Ship as v0.7.0 (same release as Track A)

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Clash-path patch (IU-A3) introduces tableau regression | High — breaks core reasoning | Feature flag `#ifdef WASM_JUSTIFICATION_HOOK`; full OWL 2 DL parity test suite regression run; ship Step 7 before removing BlackBox |
| `std::shared_mutex` not supported in Emscripten pthreads | Medium — thread safety | Fallback to regular `std::mutex` on both read/write paths; verify before implementing |
| Dep chain walks in realization are expensive (many sat tests) | Medium — performance | Cap walk depth at 200; profile with large ABox; consider lazy extraction (only when justification requested) |
| TS synthesis for FP/IFP misidentifies source | Low — wrong justification | FP/IFP pattern matching is deterministic from store data; same logic as existing workaround |
| someValuesFrom fixpoint tracking adds complexity to buildInferredTripleBuffer | Medium — maintainability | Isolate tracking logic; use existing Impl field pattern from learnings doc |
| Non-minimal justifications confuse users | Low — UX | Document clearly in README; defer post-hoc minimization to v0.8.0 |

## Open Questions (Deferred)

**Post-hoc minimization (v0.8.0):** Native justifications are supersets of minimal. Strategy: greedy axiom removal on dep chain subset — for each axiom in the dep chain, check if removing it still allows the entailment to hold (via cache lookup, not re-reasoning). Bounded by chain length (~5-20 axioms), should be sub-ms. Not blocking for v0.6.0/v0.7.0.

**Multiple native justifications:** Current dep chain capture gives one proof path per entailment. BlackBox HSDAG gives all minimal justifications. For v0.7.0, `maxJustifications > 1` with `justificationMode: "causal"` returns 1 justification with a note. Full multi-justification native support is a separate research question.

## Sources

- **Origin plan:** [docs/plans/2026-07-20-052-feat-expand-native-justification-coverage-plan.md](docs/plans/2026-07-20-052-feat-expand-native-justification-coverage-plan.md) (R6 section, lines 424-650)
- **Explanation API plan:** [docs/plans/2026-07-17-050-feat-explanation-api-expansion-plan.md](docs/plans/2026-07-17-050-feat-explanation-api-expansion-plan.md)
- **Native justification API plan:** [docs/plans/2026-07-17-051-feat-native-justification-api-plan.md](docs/plans/2026-07-17-051-feat-native-justification-api-plan.md)
- **Learnings:** `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`, `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`
- **Memory:** `project_blackbox_elimination.md`, `project_native_operation_mechanisms.md`, `project_entailment_oracle_optimization.md`
