---
title: "feat: Composable dep-chain justification — record at emission time, eliminate TS synthesis"
type: feat
status: active
date: 2026-07-21
origin: docs/plans/2026-07-20-053-feat-blackbox-deprecation-native-justification-plan.md
---

# Plan 054: Composable Dep-Chain Justification at Emission Time

## Overview

Move all justification recording into C++ `buildInferredTripleBuffer` / `buildPropertyTripleBuffer`. Every inferred triple gets its justification recorded at the moment it is emitted — either from tableau dep-chain data (classification/realization clash paths) or from workaround input data (Impl fields). This replaces 11 of 12 `_synthesize*` methods in TS with a cache lookup per triple, with classification-based composition as fallback for triples whose dep chain was not captured during tableau execution.

## Problem Frame

`explainEntailment()` currently uses a cascade of 12 TS-side `_synthesize*` methods to construct justifications by reverse-engineering the inference path from store data. This approach:
- Duplicates logic already present in C++ (`buildInferredTripleBuffer` knows exactly WHY each triple is emitted)
- Is fragile (each synthesis method independently reimplements pattern matching)
- Cannot access tableau dep-chain data (only available in C++)
- Grows linearly with new entailment types

The tableau already tracks `CDependencyTrackPoint` at every expansion step. When the reasoner clashes (proving an entailment), `CClashedDependencyDescriptor` carries the full proof. But this data is discarded before `buildInferredTripleBuffer` runs.

**Composable vision:** Capture dep chains during tableau execution → store in JustificationCache → at triple emission time, look up or construct the justification → record it in a new triple-keyed cache. TS becomes a thin lookup layer.

**Saturation-detected triples:** Some inferences (e.g., `X subClassOf owl:Thing`) are established during the saturation phase where no targeted tableau sat test runs — no clash descriptor or dep chain is produced. These triples have no proof to record; their justification entries will be empty.

## Requirements Trace

- R1. Every inferred triple emitted by `buildInferredTripleBuffer` / `buildPropertyTripleBuffer` has a justification recorded at emission time
- R2. 11 of 12 `_synthesize*` methods in `ts/index.ts` are removed (`_synthesizeDisjointWithJustification` retained — no C++ emission site for asserted disjointWith triples)
- R3. `explainEntailment()` in causal mode reduces to a single cache lookup — no store scanning, no pattern matching
- R4. `justification-matrix.test.ts` shows FULL status for every inferred triple (except `X subClassOf owl:Thing` — axiomatic, no tableau proof)
- R5. No regression in reasoning correctness or performance
- R6. BlackBox retained only for `justificationMode: "minimal"` and `explainInconsistency`

## Scope Boundaries

- `explainInconsistency` / `explainInconsistencyLaconic` — keep BlackBox (MIPS genuinely needs axiom-removal)
- Post-hoc minimization of native justifications — deferred to v0.8.0
- Multiple native justifications per entailment — deferred (one proof path per triple)
- `X subClassOf owl:Thing` justification — axiomatic, no tableau proof exists; PARTIAL status acceptable

### Deferred to Separate Tasks

- AllDisjointClasses / disjointUnionOf NTriples realization hang (known regression, tracked separately) — justification blocked until resolved
- `CAreAxiomsEntailedQuery` as faster BlackBox oracle — deprioritized per memory

## Context & Research

### Relevant Code and Patterns

**C++ emission sites** (13 sites across 2 methods):

| # | Triple Type | Method | Lines | Data Source | Justification Strategy |
|---|------------|--------|-------|-------------|----------------------|
| 1 | rdfs:subClassOf | buildInferredTripleBuffer | ~1799-1810 | CTaxonomy Hasse edges | Tag-based dep chain from JustificationCache (Classification) |
| 2 | owl:equivalentClass | buildInferredTripleBuffer | ~1776-1784 | CTaxonomy same-node IRIs | Bidirectional subClassOf dep chains |
| 3 | rdf:type (realization) | buildInferredTripleBuffer | ~1839-1897 | CConceptRealization visitor | Clash-path dep chain (Realization) — requires IU-3 |
| 4 | Object property assertions | buildInferredTripleBuffer | ~1899-2001 | CRoleRealization visitor | Clash-path dep chain (Realization) — requires IU-3 |
| 5 | owl:sameAs (native) | buildInferredTripleBuffer | ~2004-2045 | CSameRealization visitor | Clash-path dep chain (Realization) — requires IU-3 |
| 6 | Data property assertions | buildInferredTripleBuffer | ~2047-2069 | CDataAssertionLinker | Asserted fact — justification = the triple itself |
| 7 | owl:oneOf → rdf:type | buildInferredTripleBuffer | ~2072-2079 | Impl::mOneOfMemberships | oneOf axiom triples from input |
| 8 | minCardinality → rdf:type | buildInferredTripleBuffer | ~2081-2132 | Impl::mMinCardRestrictions + mMinCardRoleAssertions + mDifferentFromPairs | Restriction + role assertions + differentFrom |
| 9 | disjointUnionOf → subClassOf | buildInferredTripleBuffer | ~2137-2143 | Impl::mDisjointUnionOf | disjointUnionOf axiom triples from input |
| 10 | FP/IFP → owl:sameAs | buildInferredTripleBuffer | ~2146-2151 | Impl::mFpIfpSameAsPairs | FP/IFP declaration + role assertions |
| 11 | someValuesFrom → rdf:type | buildInferredTripleBuffer | ~2154-2198 | Impl::mSvfIndex + mSvfRoleAssertions + mSvfABoxTypes | Restriction + role assertion + propagation chain |
| 12 | rdfs:subPropertyOf | buildPropertyTripleBuffer | ~2279-2334 | CRolePropertiesHierarchy | Tag-based dep chain (PropertySubsumption) |
| 13 | equivalentProperty → subPropertyOf | buildPropertyTripleBuffer | ~2341-2344 | Impl::mEquivPropPairs | equivalentProperty axiom triple from input |

**TS synthesis methods to eliminate** (12 methods, lines 1163-1630 in `ts/index.ts`):
`_synthesizeSameAsJustification`, `_synthesizeEquivalentPropertyJustification`, `_synthesizeEquivalentClassJustification`, `_synthesizeDisjointWithJustification`, `_synthesizeSomeValuesFromJustification`, `_synthesizeMinCardinalityJustification`, `_synthesizeDomainRangeJustification`, `_synthesizeHasValueJustification`, `_synthesizeAllValuesFromJustification`, `_synthesizeIntersectionOfJustification`, `_synthesizeHasSelfJustification`, `_synthesizeOneOfTypeJustification`

**Existing infrastructure:**
- `src/JustificationCache.h` — singleton, `(subTag, superTag, EntailmentType)` → `vector<int64_t>` dep tags (concept or role tag integers from the tableau dep chain), `shared_mutex` thread safety
- `src/KoncludeReasoner.h` — `getAxiomsForConceptTag(tag)`, `getAxiomsForRoleTag(tag)`, `getSubClassJustification(sub, sup)`, `hasNativeJustification(sub, sup)`, `getJustificationByType(sub, sup, type)`, `hasJustificationByType(sub, sup, type)`
- `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` — dep chain recording at lines 1628-1663 (subsumption) and 1688-1738 (unsatisfiability/clash)
- `src/bindings.cpp` — 18 methods exposed via Embind

### Institutional Learnings

- **Impl field pattern** (`docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`): per-call workaround state in `struct Impl`, cleared in `reset()`. Justification data follows same pattern.
- **Node-level granularity** (`docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`): taxonomy walk iterates `nodeToIris` keyed by `CHierarchyNode*`, not `CConcept*`. Stale-pointer guard: `nodeToIris.count() == 0 → skip`.
- **INV-1 singleton lifecycle** (`docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`): JustificationCache `clear()` must wipe all entry types in `reset()`.
- **INV-8 callback-once**: dep chain walks must not hold references to task-scoped memory after task completion.
- **Dep chain walk depth cap**: 200 (matches existing analyser pattern).
- **`librdf_model_remove_statement` ineffective**: skip-at-insertion is the only safe suppression mechanism.

## Key Technical Decisions

- **Triple-keyed cache layer**: Add `JustificationTripleCache` alongside existing tag-keyed `JustificationCache`. Key = `(subjectIRI, predicateIRI, objectIRI)`, value = justification NTriples string. Populated at emission time. This is the single lookup target for TS `explainEntailment`.

  **Rationale:** The existing tag-keyed cache works for classification but cannot key ABox triples — `CIndividual` has `getIndividualID()`, not `getConceptTag()`, so individuals are not keyed by concept tags in the JustificationCache schema at all. IRI-based keys are universal across TBox and ABox. Storing resolved NTriples at emission time (not raw concept tags) eliminates the need for tag→axiom resolution at lookup time — the resolution happens once at emission, using the same ontology structures already in scope.

- **Emit-time justification, not intercept-time**: Justification is recorded WHERE the triple is emitted (`buildInferredTripleBuffer`), not where the proof occurs (catch blocks/analysers). The tag-keyed JustificationCache bridges the gap — clash-path interception stores dep chains keyed by concept tags, emission code looks them up and resolves to axioms.

  **Rationale:** Emission code already knows the triple's subject/predicate/object and the data source. It can resolve dep chains to axioms using `getAxiomsForConceptTag` while the ontology is still in scope. This keeps justification construction co-located with triple construction.

- **Workaround justification in C++, not TS**: Instead of Plan 053's Track B (TS synthesis), workaround justifications are constructed in C++ at the emission site in `buildInferredTripleBuffer`. The Impl fields already contain all input data needed.

  **Rationale:** Eliminates TS↔C++ round-trips for justification. The C++ emission loop already has Impl data in scope. Constructing NTriples justification strings is trivial — same serialization used for the emitted triples themselves.

- **`X subClassOf owl:Thing` stays PARTIAL**: This is axiomatic (every class is a subclass of owl:Thing by definition). No tableau test runs, no dep chain exists. The justification-matrix test accepts PARTIAL for these triples.

  **Rationale:** Synthesizing a fake justification adds no value. The entailment is vacuously true.

## Open Questions

### Resolved During Planning

- **Tag-keyed vs IRI-keyed cache?** → Both. Tag-keyed JustificationCache stores dep chains during tableau execution (unchanged). New IRI-keyed JustificationTripleCache stores resolved justifications at emission time. The tag cache is intermediate; the triple cache is the API surface.

- **Memory impact of storing NTriples strings per triple?** → Bounded by inferred triple count (typically hundreds to low thousands). Each justification is 2-10 axiom triples ≈ 200-2000 bytes payload. With `TripleKey` overhead (3 `std::string` per key, most OWL IRIs exceed SSO threshold) and `unordered_map` bucket/node overhead, realistic estimate for 5000 inferred triples: ~10-30 MB. Acceptable within WASM's 1 GB initial memory. Cleared on `reset()`.

- **Thread safety for JustificationTripleCache?** → Single-threaded access. `buildInferredTripleBuffer` runs on the Worker dispatch thread after all KPSet pthreads are joined/idle — there is a happens-before relationship between classification/realization completion and emission. This differs from `JustificationCache`, which uses `shared_mutex` because it IS written by KPSet worker threads during classification. No mutex needed for `JustificationTripleCache`.

### Blocking Verification Gate

- **Realization clash dep chain quality (gates IU-3/IU-4)** — must verify BEFORE committing to IU-4. Run a spike: classify+realize on roberts-family, dump realization JustificationCache entries, resolve every dep tag via `getAxiomsForConceptTag`, measure % that produce non-empty axiom NTriples. If dep chain tags resolve only to internal GCI concepts (negated subsumption triggers) rather than user-facing axioms, the entire ABox justification path falls back to classification-based composition. This determines whether IU-3→IU-4 is viable or needs architectural redesign.

### Deferred to Implementation

- **Exact Impl field names for workaround justification data** — depends on how much existing Impl state needs augmentation vs. reuse
- **Depth of someValuesFrom propagation chain recording** — fixpoint loop may require per-iteration tracking; complexity depends on actual chain lengths
- **Performance profiling** — dep chain walks during emission add overhead; profile with large ABox ontologies (pizza, roberts-family, real-world)

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────────────┐
│                    REASONING PIPELINE                            │
│                                                                  │
│  classify()                                                      │
│    └─ Tableau sat tests                                          │
│        ├─ Satisfiable → analyser chain → dep chain → ────────┐  │
│        └─ Clash → CClashedDependencyDescriptor → ────────────┤  │
│                                                               │  │
│  realize()                                                    │  │
│    └─ Instance sat tests                                      │  │
│        └─ Clash → dep chain → ───────────────────────────────┤  │
│                                                               ▼  │
│                                              ┌──────────────────┐│
│                                              │ JustificationCache││
│                                              │ (tag-keyed)       ││
│                                              │ (subTag,supTag,   ││
│                                              │  type) → depTags  ││
│                                              └────────┬─────────┘│
│                                                       │          │
│  buildInferredTripleBuffer()                          │          │
│    ├─ TBox: subClassOf ──── lookup depTags ◄──────────┤          │
│    │    └─ resolve tags → axiom NTriples ──────────┐  │          │
│    ├─ TBox: equivalentClass ◄─────────────────────┤│  │          │
│    ├─ ABox: rdf:type ──── lookup depTags ◄────────┤│  │          │
│    ├─ ABox: obj props ◄──────────────────────────┤│  │          │
│    ├─ ABox: sameAs ◄─────────────────────────────┤│  │          │
│    ├─ ABox: data props ── asserted (trivial) ────┤│  │          │
│    ├─ WK: oneOf → type ── Impl data → NTriples ──┤│  │          │
│    ├─ WK: minCard → type ── Impl data → NTriples ┤│  │          │
│    ├─ WK: disjointUnion → subClassOf ── Impl ────┤│  │          │
│    ├─ WK: FP/IFP → sameAs ── Impl data ──────────┤│  │          │
│    ├─ WK: svf → type ── Impl data + chain ───────┤│  │          │
│    └─ each emission records into ─────────────────┘│  │          │
│                                                    ▼  │          │
│                                     ┌────────────────────┐       │
│                                     │ JustTripleCache    │       │
│                                     │ (IRI-keyed)        │       │
│                                     │ (s,p,o) → NTriples │       │
│                                     └────────┬───────────┘       │
└──────────────────────────────────────────────┼───────────────────┘
                                               │
  TS: explainEntailment(s, p, o)               │
    └─ _call("lookupTripleJustification",s,p,o)│
        └─ JustTripleCache.lookup(s,p,o) ◄─────┘
            └─ return NTriples string → parse → Quad[][]
```

**Data flow:**
1. Tableau clash/analyser → dep chain concept tags → `JustificationCache` (existing, tag-keyed)
2. `buildInferredTripleBuffer` emits triple → looks up `JustificationCache` for dep tags → resolves via `getAxiomsForConceptTag` → stores resolved NTriples in `JustificationTripleCache` (new, IRI-keyed)
3. For workaround types: constructs justification NTriples directly from Impl fields → stores in `JustificationTripleCache`
4. TS calls `lookupTripleJustification(s, p, o)` → returns NTriples string → done

## Implementation Units

---

- [ ] **IU-1: JustificationTripleCache — IRI-keyed triple justification store**

**Goal:** New C++ cache mapping `(subjectIRI, predicateIRI, objectIRI)` → justification NTriples string. Populated during `buildInferredTripleBuffer`, queried from TS via Embind.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `src/JustificationTripleCache.h`
- Modify: `src/KoncludeReasoner.h` — add `lookupTripleJustification(sub, pred, obj)`, `hasTripleJustification(sub, pred, obj)` declarations
- Modify: `src/KoncludeReasoner.cpp` — implement methods, call `JustificationTripleCache::instance().clear()` in `reset()`
- Modify: `src/bindings.cpp` — expose `lookupTripleJustification`, `hasTripleJustification` via Embind
- Test: `tests/integration/justification-triple-cache.test.ts`

**Approach:**
- Singleton with `static JustificationTripleCache& instance()`
- Key: `struct TripleKey { string sub, pred, obj; }` with FNV hash
- Value: `string` (NTriples lines of justification axioms)
- No mutex needed — single-threaded write during `buildInferredTripleBuffer`, single-threaded read from JS
- `clear()` called in `KoncludeReasoner::reset()` alongside `JustificationCache::instance().clear()`
- Follow existing singleton pattern from `JustificationCache.h`

**Patterns to follow:**
- `src/JustificationCache.h` — singleton pattern, Key struct, hash function

**Test scenarios:**
- Happy path: after `reason()`, `hasTripleJustification(s, p, o)` returns true for an inferred subClassOf triple
- Edge case: lookup for non-existent triple returns empty string
- Edge case: after `reset()`, previous entries are cleared
- Integration: worker dispatch wires `lookupTripleJustification` correctly

**Verification:** Cache is instantiable, Embind methods callable from JS, `reset()` clears entries.

---

- [ ] **IU-2: TBox emission justification — subClassOf + equivalentClass**

**Goal:** At each subClassOf and equivalentClass triple emission in `buildInferredTripleBuffer`, look up the tag-based dep chain from `JustificationCache`, resolve concept tags to axiom NTriples via `getAxiomsForConceptTag`, and store in `JustificationTripleCache`.

**Requirements:** R1, R4

**Dependencies:** IU-1

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` subClassOf emission loop (~lines 1799-1810) and equivalentClass emission (~lines 1776-1784)

**Approach:**
- After emitting each subClassOf triple `(subIri, rdfs:subClassOf, supIri)`:
  - Look up `(subTag, supTag)` in `JustificationCache` (Classification type)
  - If found: for each dep tag, call `getAxiomsForConceptTag(tag)`, concatenate NTriples
  - Store concatenated NTriples in `JustificationTripleCache` keyed by `(subIri, rdfs:subClassOf, supIri)`
  - If not found: store empty string (saturation-detected, no dep chain)
- For equivalentClass: look up both direction dep chains `(tagA, tagB)` and `(tagB, tagA)`, combine
- Use `mTagToConcept` / `mConceptByIri` maps already built in `buildInferredTripleBuffer` for tag resolution
- Guard against stale taxonomy pointers per learning #3 (node-level granularity)

**Patterns to follow:**
- Existing `getSubClassJustification()` in `src/KoncludeReasoner.cpp` — same tag→axiom resolution logic
- `nodeToIris` map iteration pattern already in `buildInferredTripleBuffer`

**Test scenarios:**
- Happy path: after `reason()` on roberts-family, every inferred subClassOf triple has a justification in JustificationTripleCache
- Happy path: equivalentClass triples have justifications combining both direction chains
- Edge case: `X subClassOf owl:Thing` has empty justification (axiomatic, no dep chain — saturation-detected)
- Edge case: stale taxonomy pointer skipped safely

**Verification:** `justification-matrix.test.ts` shows FULL for all non-Thing subClassOf and equivalentClass triples.

---

- [ ] **IU-3: Clash-path dep chain interception for realization**

**Goal:** Intercept `CClashedDependencyDescriptor` in the tableau catch blocks and store dep chains in `JustificationCache` with `EntailmentType::Realization` key.

**Requirements:** R1

**Dependencies:** None (JustificationCache schema already supports Realization entries)

**Files:**
- Modify: `patches/016-clash-justification-hook.patch` — existing patch already inserts `#ifdef WASM_JUSTIFICATION_HOOK` blocks in both catch paths; update keying scheme (see Approach)
- Modify: `CMakeLists.txt` — ensure `-DWASM_JUSTIFICATION_HOOK` compile definition is present

**Approach:**
- Existing patch-016 already inserts `#ifdef WASM_JUSTIFICATION_HOOK` blocks in both catch paths
- **Current keying bug:** patch-016 stores `(negConceptTag, negConceptTag, Realization)` — both sub and super are the same negated concept tag. IU-4 cannot look up by `(individualTag, classTag)` because: (a) individuals have `getIndividualID()`, not `getConceptTag()`, and (b) using the same negConceptTag for both fields conflates all individuals proven to be of that type into one entry
- **Fix required:** Update patch-016 to extract individual identity from the sat test task context. The realization test proves "individual x cannot NOT be of type C" — the task context carries both the individual node and the target concept. Store as `(individualID, classConceptTag, Realization, depTags)` where individualID comes from the processing task's individual reference
- Walk `CClashedDependencyDescriptor` linked list (same algorithm as analyser override lines 1688-1738)
- Collect concept tags from dep chain (depth cap 200)
- Extract dep chain inline within catch block — do not persist descriptor pointer (per INV-8, catch-block-local)
- Feature flag `#ifdef WASM_JUSTIFICATION_HOOK` allows disabling if regression detected

**Execution note:** After adding patch, run `make reset-patches` then `make build-wasm`. Run full OWL 2 DL parity test suite for regression.

**Patterns to follow:**
- `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` lines 1688-1738 — existing clash dep chain walk pattern
- Patch workflow: `scripts/new-vendor-patch.sh`

**Test scenarios:**
- Happy path: after `reason()` on abox fixture, `hasJustificationByType(individual, class, Realization)` returns true
- Happy path: dep chain contains meaningful concept tags (not just bottom concept)
- Edge case: catch block with null clash descriptor — no crash, no cache entry
- Edge case: dep chain depth > 200 — truncated, still stored
- Error path: feature flag disabled — no Realization entries, existing Classification entries unaffected
- Integration: 328 OWL 2 DL parity tests still pass

**Verification:** Realization dep chains appear in JustificationCache. No regression in reasoning correctness.

---

- [ ] **IU-4: ABox emission justification — rdf:type, object properties, sameAs**

**Goal:** At each ABox triple emission in `buildInferredTripleBuffer`, look up the Realization dep chain from `JustificationCache` and store resolved justification in `JustificationTripleCache`.

**Requirements:** R1, R4

**Dependencies:** IU-1, IU-3

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` ABox emission sections:
  - rdf:type via CConceptRealization (~lines 1839-1897)
  - Object property assertions via CRoleRealization (~lines 1899-2001)
  - owl:sameAs via CSameRealization (~lines 2004-2045)
  - Data property assertions (~lines 2047-2069)

**Approach:**
- **Key design constraint:** `CIndividual` has `getIndividualID()`, not `getConceptTag()`. Individual IRIs are NOT in `mConceptByIri` — they are in `mIndividualByIri`. The existing `getJustificationByType(individualIri, classIri, Realization)` silently fails because it looks up both args in `mConceptByIri`. IU-3's updated keying `(individualID, classConceptTag, Realization)` solves this — IU-4 looks up using the individual's ID from `mIndividualByIri` + the class concept tag from `mConceptByIri`.
- For rdf:type: at each `(indiIri, rdf:type, classIri)` emission:
  - Get individualID from `mIndividualByIri[indiIri]->getIndividualID()`
  - Get classTag from `mConceptByIri[classIri]->getConceptTag()`
  - Look up `(individualID, classTag, Realization)` in JustificationCache
  - If found: resolve dep tags → axiom NTriples → store in JustificationTripleCache
  - If not found: fall back to classification-based justification — check if individual has an asserted type A where `(A, classTag)` has a Classification entry. Compose justification = rdf:type assertion + subClassOf chain.
- For object properties: look up `(individualID, roleTag, Realization)` key
- For sameAs: look up `(individualID1, individualID2, Realization)` key
- For data properties: justification = the asserted triple itself (trivial — store the triple as its own justification)

**Patterns to follow:**
- IU-2 pattern for tag→axiom resolution
- `buildInferredTripleBuffer` existing visitor pattern for individual/type/role iteration

**Coverage note:** 5 TS synthesis methods (domainRange, hasValue, allValuesFrom, intersectionOf, hasSelf) have no explicit C++ emission site — their rdf:type triples reach JustificationTripleCache through emission site #3 (CConceptRealization visitor) via this IU's dep chain path. The blocking verification gate (dep chain quality spike) must confirm that realization dep chains carry useful concept tags for these restriction-induced rdf:type inferences. If the spike shows gaps for specific restriction types, retain the corresponding TS synthesis methods as fallback.

**Test scenarios:**
- Happy path: rdf:type inferred via subClassOf chain has justification containing the type assertion + subClassOf axioms
- Happy path: rdf:type inferred via realization has justification from clash dep chain
- Happy path: rdf:type inferred via domain/range has justification from dep chain (covers `_synthesizeDomainRangeJustification`)
- Happy path: rdf:type inferred via hasValue/allValuesFrom/intersectionOf/hasSelf has justification from dep chain
- Happy path: object property assertion has justification
- Happy path: owl:sameAs has justification
- Edge case: data property assertion → justification = the triple itself
- Edge case: realization dep chain miss → classification-based fallback produces justification
- Edge case: `rdf:type owl:Thing` — no justification (axiomatic)

**Verification:** ABox triples from abox fixture have FULL status in justification-matrix test. Specifically verify hasValue/allValuesFrom/intersectionOf/hasSelf rdf:type triples.

---

- [ ] **IU-5a: Workaround emission justification — simple types (FP/IFP, disjointUnionOf, oneOf, equivalentProperty)**

**Goal:** At each workaround triple emission for the 4 simple types, construct justification NTriples from Impl field data and store in `JustificationTripleCache`.

**Requirements:** R1, R4

**Dependencies:** IU-1

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — workaround emission sections in `buildInferredTripleBuffer()`:
  - FP/IFP → sameAs (~lines 2146-2151)
  - disjointUnionOf → subClassOf (~lines 2137-2143)
  - oneOf → rdf:type (~lines 2072-2079)
  - equivalentProperty → subPropertyOf in `buildPropertyTripleBuffer` (~lines 2341-2344)

**Approach:**
- **FP/IFP → sameAs**: At each `(a, owl:sameAs, b)` emission from `mFpIfpSameAsPairs`:
  - Augment `mFpIfpSameAsPairs` during `loadTripleBuffer` to carry the source triples (FP/IFP declaration IRI + the two role assertion triples)
  - Serialize source triples as justification NTriples

- **disjointUnionOf → subClassOf**: At each `(member, rdfs:subClassOf, unionClass)` emission:
  - Justification = the `owl:disjointUnionOf` axiom triples from input
  - Augment `mDisjointUnionOf` to carry the source axiom NTriples

- **oneOf → rdf:type**: At each `(individual, rdf:type, oneOfClass)` emission:
  - Justification = the `owl:oneOf` axiom triples (class + list nodes)
  - Augment `mOneOfMemberships` or add `mOneOfJustifications`

- **equivalentProperty**: At each `(P, rdfs:subPropertyOf, Q)` + `(Q, rdfs:subPropertyOf, P)` emission:
  - Justification = the `owl:equivalentProperty` axiom triple from input
  - Trivial — `mEquivPropPairs` already has both IRIs

**Patterns to follow:**
- Existing Impl field pattern: add new fields, populate during `loadTripleBuffer`, consume during `buildInferredTripleBuffer`, clear in `reset()`
- Existing NTriples serialization pattern in `buildInferredTripleBuffer`

**Test scenarios:**
- Happy path: FP/IFP sameAs triple has justification containing FP declaration + 2 role assertions
- Happy path: disjointUnionOf subClassOf triple has justification containing disjointUnionOf axiom
- Happy path: oneOf type triple has justification containing oneOf axiom
- Happy path: equivalentProperty → bidirectional subPropertyOf both have justification
- Integration: property-characteristics fixture triples have FULL status

**Verification:** All 4 simple workaround types show FULL status in justification-matrix test.

---

- [ ] **IU-5b: Workaround emission justification — complex types (someValuesFrom, minCardinality)**

**Goal:** At each someValuesFrom/minCardinality triple emission, construct justification NTriples with per-step provenance tracking.

**Requirements:** R1, R4

**Dependencies:** IU-1, IU-5a (pattern established)

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — workaround emission sections:
  - minCardinality → rdf:type (~lines 2081-2132)
  - someValuesFrom → rdf:type (~lines 2154-2198)

**Approach:**
- **minCardinality → rdf:type**: At each emission:
  - Justification = restriction axiom + role assertions + differentFrom pairs used in the cardinality check
  - Build justification NTriples from `mMinCardRestrictions` entry + the specific role assertions and differentFrom pairs that satisfied the check

- **someValuesFrom → rdf:type**: Baseline = single-step justification (restriction + role assertion). Chain tracking is stretch goal.
  - Single-step: at each emission, record which restriction + role assertion produced the inference → store in `JustificationTripleCache`
  - Chain (stretch): track per-fixpoint-iteration provenance via `mSvfJustifications` map `(indiIri, classIri)` → justification NTriples. Chain tracking deferred to follow-up if fixpoint loop complexity proves excessive.

**Patterns to follow:**
- IU-5a pattern for Impl field augmentation

**Test scenarios:**
- Happy path: minCardinality type triple has justification containing restriction + role assertions + differentFrom
- Happy path: someValuesFrom type triple has justification containing restriction + role assertion (single-step)
- Edge case: someValuesFrom chain (multi-step propagation) — if chain tracking implemented, justification includes full chain; otherwise single-step justification
- Integration: restrictions fixture triples have FULL status

**Verification:** minCardinality and someValuesFrom triples show FULL status in justification-matrix test.

---

- [ ] **IU-6: Property hierarchy emission justification**

**Goal:** At each rdfs:subPropertyOf emission in `buildPropertyTripleBuffer`, look up the PropertySubsumption dep chain and store resolved justification in `JustificationTripleCache`.

**Requirements:** R1, R4

**Dependencies:** IU-1

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — `buildPropertyTripleBuffer()` subPropertyOf emission (~lines 2279-2334)

**Approach:**
- At each `(subPropIri, rdfs:subPropertyOf, superPropIri)` emission:
  - Look up `(subRoleTag, superRoleTag, PropertySubsumption)` in JustificationCache
  - If found: resolve dep tags → axiom NTriples via `getAxiomsForRoleTag`
  - Store in JustificationTripleCache
- Use `mRoleByIri` / `mRoleTagToIri` maps for tag resolution

**Patterns to follow:**
- IU-2 pattern (same tag lookup → axiom resolution → store pattern)

**Test scenarios:**
- Happy path: inferred subPropertyOf triple has justification
- Edge case: property hierarchy node with multiple equivalent properties — each pair justified

**Verification:** Property hierarchy triples in justification-matrix test show FULL status.

---

- [ ] **IU-7: TS simplification — replace _synthesize* with cache lookup**

**Goal:** Replace 11 of 12 `_synthesize*` methods and the probe-kind cascade in `explainEntailment()` with a cache lookup. Retain `_synthesizeDisjointWithJustification` (no C++ emission site).

**Requirements:** R2 (amended: 11 of 12), R3, R6

**Dependencies:** IU-1, IU-2, IU-3, IU-4, IU-5a, IU-5b, IU-6

**Rollback gate:** Before deleting synthesis methods, run `justification-matrix.test.ts` with BOTH paths active (cache lookup preferred, synthesis fallback). Diff FULL/PARTIAL counts. Only delete synthesis methods when the matrix shows zero FULL→PARTIAL regressions. If gaps remain, keep affected synthesis methods behind `_USE_SYNTHESIS_FALLBACK` flag for one release cycle.

**Files:**
- Modify: `ts/index.ts` — rewrite `explainEntailment()` causal mode, remove `_synthesize*` methods
- Modify: `ts/worker.ts` — add `lookupTripleJustification` and `hasTripleJustification` message handlers

**Approach:**
- Add worker dispatch for `lookupTripleJustification(sub, pred, obj)` and `hasTripleJustification(sub, pred, obj)`
- Rewrite `explainEntailment()` causal mode (default):
  1. Call `hasTripleJustification(subjectIri, predicateIri, objectIri)`
  2. If true: call `lookupTripleJustification(...)`, parse NTriples → `Quad[]`, return `{ isEntailed: true, justifications: [quads] }`
  3. If false: check inferred graph for the triple (causal fallback for saturation-detected triples with no dep chain)
  4. Special case: `X subClassOf owl:Nothing` → call `_isSatisfiableClassDirect` (suppressed from inferred output)
- `justificationMode: "minimal"` path unchanged (BlackBox)
- Delete 11 of 12 `_synthesize*` methods (~430 lines)
- **Retain `_synthesizeDisjointWithJustification`** — owl:disjointWith has no C++ emission site (disjointWith triples are asserted, not inferred, and never appear in `JustificationTripleCache`). Keep the existing asserted-triple store scan as a thin lookup for this probe kind. Revisit if Konclude gains disjointWith inference.
- Delete `_synthesizeDomainRangeJustification` async helper and its `_getSubClassJustificationDirect` call chain (subClassOf justification now comes from JustificationTripleCache directly)
- Keep `_hasNativeJustificationDirect`, `_getSubClassJustificationDirect`, `_hasJustificationByTypeDirect`, `_getJustificationByTypeDirect` — needed by `validate()` unsatisfiability path. These are private internal helpers, not part of the public API.

**Patterns to follow:**
- Existing `_call(method, ...args)` dispatch pattern in `ts/index.ts`
- Existing `hasNativeJustification` / `getSubClassJustification` worker message handlers in `ts/worker.ts`

**Test scenarios:**
- Happy path: `explainEntailment(store, s, subClassOf, o)` returns justification via single cache lookup
- Happy path: `explainEntailment(store, s, rdf:type, o)` returns justification via cache lookup (no synthesis cascade)
- Happy path: `explainEntailment(store, s, owl:sameAs, o)` returns justification via cache lookup
- Happy path: all 12 former synthesis paths now resolved by cache
- Edge case: triple in inferred graph but no justification → `isEntailed: true, justifications: []`
- Edge case: `justificationMode: "minimal"` still runs BlackBox
- Error path: triple not inferred → `isEntailed: false`
- Integration: `validate()` still works (uses `_hasNativeJustificationDirect` for unsatisfiability, unaffected)

**Verification:** `explainEntailment` works for all probe kinds without any `_synthesize*` method. TS bundle size decreases.

---

- [ ] **IU-8: Update tests and acceptance criterion**

**Goal:** Update `justification-matrix.test.ts` to assert FULL status for all inferred triples (except `X subClassOf owl:Thing`). Remove or update unit tests that mock synthesis methods.

**Requirements:** R4

**Dependencies:** IU-7

**Files:**
- Modify: `tests/integration/justification-matrix.test.ts` — tighten assertions
- Modify: `tests/unit/RdfReasoner.explainEntailment.test.ts` — update for new cache-based flow
- Modify: `tests/unit/RdfReasoner.validate.test.ts` — update mock for `lookupTripleJustification` / `hasTripleJustification`

**Approach:**
- `justification-matrix.test.ts`: change from "expect 0 MISSING" to "expect 0 MISSING and PARTIAL only for owl:Thing triples"
- Add new fixture tests: ABox with domain/range inferences, hasValue, allValuesFrom, intersectionOf, hasSelf — all must show FULL
- Update validate test mock to handle new worker messages
- Remove unit tests that directly test `_synthesize*` methods (they no longer exist)

**Test scenarios:**
- Happy path: roberts-family — all non-Thing triples FULL
- Happy path: pizza — all non-Thing triples FULL
- Happy path: abox — all non-Thing triples FULL
- Happy path: restrictions — all non-Thing triples FULL
- Happy path: property-characteristics — all non-Thing triples FULL
- Edge case: `X subClassOf owl:Thing` — PARTIAL (accepted)

**Verification:** `npm test` passes. `justification-matrix.test.ts` shows 0 MISSING, PARTIAL only for owl:Thing triples.

---

## Execution Sequence

```text
Phase 0: Spike (no WASM rebuild needed if using existing patch-016)
  Dep chain quality spike — verify realization dep chains resolve to useful axioms
  Gate: IU-3/IU-4 proceed only if spike confirms non-empty axiom resolution

Phase 1: Foundation + TBox (WASM rebuild)
  IU-1 (JustificationTripleCache) → IU-2 (TBox emission justification)
  
Phase 2: Clash-path + ABox + Workarounds (WASM rebuild)
  IU-3 (clash-path hook keying fix) → IU-4 (ABox emission justification)
  IU-5a (simple workaround justification) — parallel with IU-3/IU-4
  IU-5b (complex workaround justification) — after IU-5a pattern established
  IU-6 (property hierarchy) — parallel with IU-3/IU-4
  
Phase 3: TS cleanup (no WASM rebuild)
  IU-7 (replace _synthesize* with cache lookup — rollback-gated)
  IU-8 (update tests)
```

IU-1 is the foundation. IU-2 and IU-5a/IU-6 can proceed in parallel after IU-1. IU-3 must precede IU-4 (clash data needed for ABox), and both are gated on the dep chain quality spike. IU-5b follows IU-5a. IU-7 requires all C++ work complete and is gated on justification-matrix diff showing zero FULL→PARTIAL regressions. IU-8 finalizes.

Minimum WASM rebuilds: 2 (one for IU-1+IU-2, one for IU-3+IU-4+IU-5a+IU-5b+IU-6). Can batch into 1 rebuild if all C++ work is done before testing.

## System-Wide Impact

- **Interaction graph:** `buildInferredTripleBuffer` → `JustificationTripleCache` → `lookupTripleJustification` (Embind) → `ts/worker.ts` → `ts/index.ts` `explainEntailment`. The `validate()` unsatisfiability path (`_hasNativeJustificationDirect`) is unchanged.
- **Error propagation:** If dep chain lookup returns empty, emission continues normally — justification is empty string, TS returns `isEntailed: true, justifications: []` (PARTIAL, not failure).
- **State lifecycle:** `JustificationTripleCache::clear()` in `reset()` alongside `JustificationCache::clear()`. Both are singleton caches that persist across calls until explicit reset.
- **API surface parity:** `lookupTripleJustification` and `hasTripleJustification` added to Embind. TS `explainEntailment` behavior unchanged from user perspective (same return shape). `_synthesize*` methods removed (internal only, not exported).
- **Integration coverage:** `justification-matrix.test.ts` covers all emission sites end-to-end. Unit tests cover worker dispatch.
- **Unchanged invariants:** `reason()`, `classify()`, `materialize()`, `validate()` return types unchanged. `explain()` (BlackBox) unchanged. `explainInconsistency()` unchanged. Inferred triple output unchanged (same triples emitted, just with justification recorded alongside).

## Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| Clash-path patch (IU-3) introduces tableau regression | High | Feature flag `#ifdef WASM_JUSTIFICATION_HOOK`; full 328-test parity suite regression; ship IU-7 with fallback to empty justification |
| Dep chain tags don't resolve to useful axioms for ABox inferences | High — gates IU-3/IU-4 | Blocking spike in Phase 0; fall back to classification-based justification for rdf:type if spike shows gaps |
| Memory overhead of NTriples strings in JustificationTripleCache | Low | Bounded by inferred triple count (~thousands); ~10-30 MB for large ontologies including key/hash overhead; cleared on reset() |
| someValuesFrom fixpoint chain tracking adds complexity | Medium | Start with single-step justification (restriction + role assertion); chain tracking deferred if too complex |
| Workaround Impl augmentation grows struct size | Low | Only adds string fields per workaround type; cleared on reset() |
| WASM rebuild required for all C++ changes | Medium — slow iteration | Batch C++ work (IU-1 through IU-6) into minimum rebuilds; test with unit tests before WASM build |

## Relationship to Plan 053

This plan supersedes Plan 053's Track B (TS workaround synthesis) with C++ emission-time recording. It preserves Plan 053's Track A architecture (clash-path interception, analyser enrichment, axiom reverse mapping) but redirects the output into `JustificationTripleCache` at emission time rather than exposing tag-based data to TS for resolution.

**What changes from 053:**
- IU-B1 (probeKind extension for sameAs, equivalentProperty, disjointWith) already implemented — no action needed
- IU-B3 (data property probe fix) made unnecessary by IU-7's universal cache lookup (no probe-kind routing survives in causal mode)
- IU-B2, IU-B4, IU-B5 workaround synthesis replaced by IU-5 (C++ workaround emission justification)
- Track B+1 (IU-B+1: someValuesFrom + minCardinality) absorbed into IU-5
- TS synthesis methods eliminated entirely (IU-7) instead of just adding more
- New `JustificationTripleCache` provides unified IRI-keyed lookup

**What carries forward from 053:**
- Clash-path interception approach (IU-A3 → IU-3 here)
- Axiom reverse mapping via `getAxiomsForConceptTag` (already implemented)
- JustificationCache tag-keyed storage as intermediate layer
- `justificationMode: "causal" | "minimal"` API option (IU-7 → IU-7 here)
- Feature flag approach for catch-block patch

## Sources & References

- **Origin plan:** [docs/plans/2026-07-20-053-feat-blackbox-deprecation-native-justification-plan.md](docs/plans/2026-07-20-053-feat-blackbox-deprecation-native-justification-plan.md)
- **Research plan:** [docs/plans/2026-07-20-052-feat-expand-native-justification-coverage-plan.md](docs/plans/2026-07-20-052-feat-expand-native-justification-coverage-plan.md)
- **Learnings:** `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md` (Impl field pattern), `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md` (INV-1 singleton, INV-8 callback), `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` (node-level granularity)
- **Memory:** `project_blackbox_elimination.md`, `project_native_operation_mechanisms.md`, `project_ts_to_cpp_workaround_pattern.md`
