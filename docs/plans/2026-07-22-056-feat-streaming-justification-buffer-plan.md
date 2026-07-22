---
title: "feat: Stream justifications inline in binary buffer"
type: feat
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-013-streaming-justification-buffer-requirements.md
---

# feat: Stream justifications inline in binary buffer

## Overview

Replace the NTriples-based bulk justification export with inline binary encoding in the existing combined buffer. Justification axiom triples share the string table, deduplicate via an axiom index table, and use deterministic named node IRIs (hashed dep tag sets) so N3 Store deduplicates automatically. Eliminates JustificationTripleCache, exportAllJustifications, NTriples round-trip, and per-triple WASM lookup APIs.

## Problem Frame

Explanation persistence OOMs on ABox ontologies (Roberts family: 5.3GB, killed after 8 min). Root cause: C++ accumulates NTriples strings in JustificationTripleCache → exports as one giant string → JS re-parses NTriples → creates RDF-star quads. The entire pipeline is string-based with zero dedup. Many inferred triples share identical justification axiom sets but store duplicated NTriples strings. (see origin: `docs/brainstorms/2026-07-22-013-streaming-justification-buffer-requirements.md`)

## Requirements Trace

- R1. Justification data inline in combined binary buffer
- R2. Axiom triples share InternTable / string table
- R3. Unique axioms emitted once, referenced by index
- R4. Extended buffer layout with axiom + justification sections
- R5. JustificationTripleCache removed
- R6. exportAllJustifications removed
- R7. lookupTripleJustification / hasTripleJustification removed
- R8. Inline resolution during buildInferredTripleBuffer
- R9. decodeBuffers extended for justification section
- R10. serializeExplanations uses structured data, no N3 Parser
- R11. explain() reads from Store, no WASM round-trip
- R12. Named node justifications via dep tag hash
- R13. Axiom index table dedup
- R14. N3 Store automatic dedup via addQuad no-op
- R15. Named nodes replace blank nodes
- R16. Zero overhead when explanations: false
- R17. API behavior unchanged (only node type changes)

## Scope Boundaries

- JustificationCache (tag→tag dep chain) stays as-is
- getAxiomsForConceptTag / getAxiomsForRoleTag logic unchanged — only output format changes
- No new vocabulary or RDF-star encoding changes
- No streaming/chunked postMessage — single buffer transfer suffices
- `getSubClassJustification`, `hasNativeJustification`, `getJustificationByType`, `hasJustificationByType` — these JustificationCache-based methods stay for now (used by explain() for non-triple-keyed lookups). Only JustificationTripleCache methods are removed.

### Deferred to Separate Tasks

- **TS workaround justification capture**: The TS synthesis paths (FP/IFP sameAs, someValuesFrom, disjointUnionOf, oneOf, minCardinality, intersectionOf, hasSelf) currently emit inferred triples without justifications. With the new inline buffer format, each workaround path can insert justification entries directly (it already knows which axiom patterns triggered the inference). Builds on Units 1-2 of this plan — same axiomDedup set, justDedup map, and tripleMappings vector.

## Context & Research

### Relevant Code and Patterns

- `src/KoncludeReasoner.cpp:2092` — InternTable: string→u32 map with type tags, build() serializes to `[count:u32][offsets...][UTF-8 data]`
- `src/KoncludeReasoner.cpp:2137` — buildInferredTripleBuffer: assembles `[strTableLen:u32][strTable][tripleIds]`
- `src/KoncludeReasoner.cpp:2842` — buildPropertyTripleBuffer: identical pattern
- `src/KoncludeReasoner.cpp:733` — getAxiomsForConceptTag: walks CConcept→CClassTermExpression→CClassAxiomExpression, handles SubClassOf/EquivalentClasses/DisjointClasses
- `src/KoncludeReasoner.cpp:806` — getAxiomsForRoleTag: handles SubObjectPropertyOf/EquivalentObjectProperties/ObjectPropertyDomain/ObjectPropertyRange
- `src/KoncludeReasoner.cpp:896` — resolveDepTagsToNTriples: iterates dep tags, calls getAxiomsFor*, concatenates strings
- `ts/intern.ts:104` — decodeBuffers: parses combined buffer, creates Quad[]
- `ts/explanationSerializer.ts:17` — serializeExplanations: parses NUL-delimited NTriples bulk export → RDF-star quads
- `ts/index.ts:1744-1753` — explain() causal mode: uses hasTripleJustification/lookupTripleJustification
- `ts/index.ts:1806-1817` — explain() domain-chain: uses hasTripleJustification/lookupTripleJustification
- `ts/worker.ts:210-219` — worker handlers for lookup/has/export methods
- `ts/inlineWorker.ts:193` — inline worker mirrors same handlers

### Institutional Learnings

- `docs/solutions/ts-to-cpp-workaround-migration-pattern.md` — InternTable wire format documentation, type tag encoding (top 2 bits)
- `docs/solutions/wasm-build-pipeline-optimization-2026-05-12.md` — unordered_set for triple dedup

## Key Technical Decisions

- **Pass `withExplanations` flag to C++ buildInferredTripleBuffer/buildPropertyTripleBuffer**: Currently TS-side only. C++ needs to know whether to emit justification sections. Add bool parameter to both methods and worker dispatch. (R16)
- **Parallel index-based axiom resolution**: Add `emitAxiomIndicesForConceptTag(InternTable&, ...)` and `emitAxiomIndicesForRoleTag(InternTable&, ...)` that intern axiom IRIs and return `vector<tuple<u32,u32,u32>>`. Keep existing NTriples methods for now (used by explain() legacy paths via JustificationCache). (R8)
- **Hash function for dep tags**: FNV-1a over sorted dep tag int64s → 16-char hex string. Deterministic, collision-negligible at justification scale. IRI: `urn:konclude:j#<hex>`. (R12)
- **No buffer version byte**: TS side knows if it requested explanations. decodeBuffers gets a `withJustifications` flag. (R4)
- **tripleCount sentinel is load-bearing**: The current decoder at `ts/intern.ts:131` computes `tripleCount = Math.floor((byteLength - tripleStart) / 12)` — it reads ALL remaining bytes as triples. Without the `tripleCount:u32` sentinel in the extended buffer, the old-path decoder would interpret justification bytes as garbage triples. The sentinel makes decoding unambiguous: when `withJustifications=false`, stop at `4 + strTableLen + tripleCount*12`; when true, read further. (R4, R16)
- **decodeBuffers uses TS overloads for backward compat**: `decodeBuffers(buf: ArrayBuffer): Quad[]` (existing signature, unchanged) and `decodeBuffers(buf: ArrayBuffer, opts: { withJustifications: true }): DecodeResult` where `DecodeResult = { quads: Quad[], justifications: JustificationData }`. The 9+ existing call sites that iterate `Quad[]` need zero changes. Only the 4 new explanation call sites use the overload. (R9)
- **explain() causal mode → Store query**: Replace `hasTripleJustification` + `lookupTripleJustification` with `store.getQuads(null, kj:justifies, quotedTriple, explGraph)`. Returns justification node → then query `kj:axiom` for axioms. Zero WASM calls. (R11)
- **explain() requires prior explanations:true**: After this change, explain() depends on the explanation graph being populated, which only happens with `explanations: true`. Currently explain() works even without `explanations: true` because JustificationTripleCache is always populated. This is a **behavioral change**: callers must pass `explanations: true` to classify/materialize before calling explain(). Document in API changelog. explain() auto-triggers a re-call with explanations if the graph is empty (same pattern as current _ensureExplanationGraph but via buffer re-fetch).
- **Cache-hit + explanations path**: On cache hit with `wantExplanations`, re-call `getInferredTripleBuffer(true)` — WASM state persists across classify calls so this is valid without re-classifying. Simpler than caching justification bytes (avoids cache type change for all 3 caches). The re-call is cheap relative to classification itself.

## Open Questions

### Resolved During Planning

- **getAxiomsForConceptTag refactoring approach**: Create parallel methods that emit interned indices rather than modifying existing NTriples methods. Existing methods stay for explain() JustificationCache path.
- **Buffer sentinel**: `tripleCount:u32` IS required — current decoder reads all remaining bytes as triples. Sentinel delimits triple section from justification section.
- **decodeBuffers return type**: Uses TS overloads — `decodeBuffers(buf): Quad[]` (default, unchanged) and `decodeBuffers(buf, {withJustifications: true}): DecodeResult`. JustificationData = `{ axioms: Quad[], entries: Array<{ iri: string, axiomIndices: number[] }>, mappings: Array<{ tripleIdx: number, justIdx: number }> }`.
- **explain() audit**: Two code paths use triple-keyed lookup — causal mode (line 1744) and domain-chain (line 1806). Both replaceable by Store getQuads on explanation graph.

### Deferred to Implementation

- Exact FNV-1a hash implementation in C++ (standard library vs inline)
- Whether `emitAxiomIndicesForConceptTag` can share the expression-walking code with existing methods via template/callback pattern, or should duplicate

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Extended Buffer Layout

```
[strTableLen:u32][strTable bytes...][inferred triples: s,p,o × N]
[tripleCount:u32]                                    ← sentinel: tells decoder where justification section starts
[axiomCount:u32][axiom triples: ax_s,ax_p,ax_o × M] ← unique axiom triples (interned)
[justCount:u32]                                      ← justification entries
  [jHashHigh:u32, jHashLow:u32,                      ← 64-bit dep tag hash → named node IRI
   numAxioms:u32, axiomIdx0, axiomIdx1, ...]          ← per unique justification
[mappingCount:u32]                                   ← triple→justification mappings
  [tripleIdx:u32, justIdx:u32] × K                   ← which inferred triple maps to which justification
```

The `tripleCount` sentinel lets the decoder know where the triple section ends and the justification section begins, even without knowing in advance whether justifications are present.

### Data Flow

```
buildInferredTripleBuffer(withExplanations=true):
  for each inferred triple:
    emit triple as before (interned s,p,o)
    look up JustificationCache dep tags for this triple
    if dep tags found:
      sort dep tags → compute hash → look up/create justification entry
      for each dep tag: resolve to axiom expressions → intern axiom s,p,o → add to axiom dedup set
      record mapping (tripleIdx → justIdx)
  assemble buffer: [strTable][triples][tripleCount][axioms][justifications][mappings]

JS side:
  decodeBuffers(buffer, { withJustifications: true })
    → parse triples as before
    → parse axiom section → Quad[]
    → parse justification entries → { jNodeIri, axiomIndices }[]
    → parse mappings → tripleIdx→justIdx[]
  serializeExplanations(store, decodedJustifications)
    → for each unique justification: addQuad(jNode, rdf:type, kj:Justification)
    → for each axiom: addQuad(jNode, kj:axiom, <<axiom quoted triple>>)
    → for each mapping: addQuad(jNode, kj:justifies, <<inferred quoted triple>>)
```

## Implementation Units

- [ ] **Unit 1: C++ axiom index resolution methods**

**Goal:** Add parallel axiom resolution methods that emit interned indices instead of NTriples strings.

**Requirements:** R2, R8

**Dependencies:** None

**Files:**
- Modify: `src/KoncludeReasoner.cpp`

**Approach:**
- Add `emitAxiomIndicesForConceptTag(int64_t tag, InternTable& intern)` → returns `vector<tuple<uint32_t,uint32_t,uint32_t>>` (interned s,p,o for each axiom)
- Same expression-walking logic as `getAxiomsForConceptTag` but interns IRIs via the shared InternTable instead of string-concatenating NTriples
- Add `emitAxiomIndicesForRoleTag(int64_t tag, InternTable& intern)` — same pattern for role axioms
- Both methods are on the Impl class, same access to mTagToConcept/mTagToRole/mOntology

**Patterns to follow:**
- `getAxiomsForConceptTag` at line 733 — same dynamic_cast walks, same expression types
- `getAxiomsForRoleTag` at line 806 — same pattern

**Test scenarios:**
- Happy path: concept tag with SubClassOf axiom → returns correct interned (s,p,o) tuple
- Happy path: role tag with SubObjectPropertyOf → returns correct interned tuple
- Edge case: tag not found in mTagToConcept → returns empty vector
- Edge case: concept with EquivalentClasses expression → returns N*(N-1)/2 axiom pairs
- Edge case: concept with no class axiom mappings → returns empty vector

**Verification:**
- New methods compile. Existing getAxiomsFor* methods unchanged. Unit tests confirm correct index resolution.

---

- [ ] **Unit 2: C++ dep tag hashing + justification collection**

**Goal:** During buildInferredTripleBuffer, collect justification data inline using the new axiom index methods, dedup by dep tag hash.

**Requirements:** R1, R3, R4, R5, R8, R12, R13, R16

**Dependencies:** Unit 1

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `src/KoncludeReasoner.h`

**Approach:**
- Add `bool withExplanations` parameter to `buildInferredTripleBuffer()` and `buildPropertyTripleBuffer()`
- Add dep tag hash function: sort int64_t vector, FNV-1a over bytes → 64-bit hash
- Add local data structures during build:
  - `axiomDedup: unordered_set<tuple<u32,u32,u32>>` → unique axiom triples + vector for ordered emission
  - `justDedup: unordered_map<uint64_t, JustEntry>` where JustEntry = { hash, axiomIndices[] }
  - `tripleMappings: vector<pair<u32 tripleIdx, u32 justIdx>>`
- At each of the 16 `storeTripleJustification` call sites: replace with inline justification collection. Note: sites are heterogeneous — some call JustificationCache directly (line 2251), some merge forward+reverse dep chains (line 2212-2216 for EquivalentClasses), some use iterator-stored justification strings (`jit->second` at lines 2559, 2600, 2614, 2628, 2721, 2734), and some use realization-type lookups (line 2332-2333 with same tag twice). For `jit->second` sites: the dep tags are available at the iterator scope (the justification map was populated from JustificationCache earlier in the same loop); thread them through instead of resolving from the pre-resolved NTriples string. A custom hash functor for `tuple<u32,u32,u32>` is needed for `axiomDedup` since C++ stdlib has no default tuple hash.
- After triple emission, append justification sections to the buffer
- When `withExplanations=false`, skip all justification work (R16)

**Patterns to follow:**
- Existing `emitTriple` lambda at line 2155 — same dedup-and-append pattern
- Buffer assembly at line 2792 — extend with additional sections

**Test scenarios:**
- Happy path: buildInferredTripleBuffer(true) produces buffer with justification sections
- Happy path: buildInferredTripleBuffer(false) produces buffer identical to current format
- Edge case: no justifications available (TBox-only told subsumptions) → axiomCount=0, justCount=0, mappingCount=0
- Edge case: two inferred triples sharing same dep tag set → one justification entry, two mappings
- Integration: buffer round-trips correctly through JS decoder

**Verification:**
- Buffer contains valid justification sections when withExplanations=true. Buffer is unchanged when false. WASM compiles.

---

- [ ] **Unit 3: Remove JustificationTripleCache + exportAllJustifications**

**Goal:** Delete JustificationTripleCache and all methods that read/write it.

**Requirements:** R5, R6, R7

**Dependencies:** Unit 2

**Files:**
- Delete: `src/JustificationTripleCache.h`
- Modify: `src/KoncludeReasoner.cpp` — remove storeTripleJustification, exportAllJustifications, lookupTripleJustification, hasTripleJustification
- Modify: `src/KoncludeReasoner.h` — remove method declarations
- Modify: `src/bindings.cpp` — remove Embind bindings for exportAllJustifications, lookupTripleJustification, hasTripleJustification

**Approach:**
- Remove all `#include "JustificationTripleCache.h"` references
- Remove `JustificationTripleCache::instance().clear()` from reset()
- Remove `storeTripleJustification` method and all call sites (replaced by Unit 2's inline collection)
- Remove `exportAllJustifications`, `lookupTripleJustification`, `hasTripleJustification` from KoncludeReasoner class
- Remove corresponding Embind bindings

**Patterns to follow:**
- Existing Embind binding removal pattern in `src/bindings.cpp`

**Test scenarios:**
- Test expectation: none — pure deletion. Compilation verifies no dangling references.

**Verification:**
- WASM compiles without JustificationTripleCache. No linker errors.

---

- [ ] **Unit 4: Worker dispatch — pass withExplanations flag**

**Goal:** Pass `withExplanations` flag from TS through worker to C++ buildInferredTripleBuffer/buildPropertyTripleBuffer.

**Requirements:** R16

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `ts/worker.ts`
- Modify: `ts/inlineWorker.ts`
- Modify: `ts/index.ts`

**Approach:**
- `getInferredTripleBuffer` and `getPropertyTripleBuffer` worker handlers gain an optional `withExplanations` boolean arg
- Worker passes it to `reasoner.buildInferredTripleBuffer(withExplanations)` / `reasoner.buildPropertyTripleBuffer(withExplanations)`
- `ts/index.ts` passes `{ explanations: true }` flag when calling `_call("getInferredTripleBuffer", [true])` vs `_call("getInferredTripleBuffer", [])` (backward compat: undefined → false in C++)
- Remove `exportAllJustifications` handler from worker.ts and inlineWorker.ts
- Remove `lookupTripleJustification` and `hasTripleJustification` handlers

**Patterns to follow:**
- Existing `loadTripleBuffer` handler passes `forRealization` boolean arg — same pattern

**Test scenarios:**
- Happy path: getInferredTripleBuffer with true → buffer includes justification section
- Happy path: getInferredTripleBuffer without arg → no justification section
- Edge case: getPropertyTripleBuffer with true → buffer includes property justification section

**Verification:**
- Worker correctly dispatches flag. Removed handlers don't appear. TS compilation succeeds.

---

- [ ] **Unit 5: JS decoder — parse justification sections**

**Goal:** Extend decodeBuffers to parse axiom, justification, and mapping sections from the extended buffer.

**Requirements:** R4, R9

**Dependencies:** Unit 2

**Files:**
- Modify: `ts/intern.ts`
- Test: `tests/unit/intern.test.ts` (or new file if none exists)

**Approach:**
- Use TS overloads: `decodeBuffers(buf: ArrayBuffer): Quad[]` (unchanged default) and `decodeBuffers(buf: ArrayBuffer, opts: { withJustifications: true }): DecodeResult`. Existing 9+ call sites that iterate `Quad[]` need zero changes.
- Both overloads read `tripleCount:u32` sentinel after the string table to know where triples end (current decoder derives count from remaining bytes — that breaks with appended justification data)
- When `withJustifications` is true, after parsing triples, read:
  - `axiomCount:u32` + axiom triples (decoded to Quad[] via same decodeTerm)
  - `justCount:u32` + justification entries (hash high/low → hex IRI string, axiom indices)
  - `mappingCount:u32` + triple→justification index pairs
- DecodeResult type: `{ quads: Quad[], justifications: { axioms: Quad[], entries: Array<{ iri: string, axiomIndices: number[] }>, mappings: Array<{ tripleIdx: number, justIdx: number }> } }`

**Patterns to follow:**
- Existing decodeBuffers at `ts/intern.ts:104` — DataView parsing, decodeTerm dispatch

**Test scenarios:**
- Happy path: buffer with justification sections → correct axioms, entries, mappings
- Happy path: buffer without justification sections (withJustifications=false) → returns quads only
- Edge case: zero justifications (axiomCount=0, justCount=0, mappingCount=0) → empty justification data
- Edge case: axiom with BlankNode subject → correctly decoded via type tag
- Error path: buffer truncated mid-justification-section → graceful fallback to quads-only

**Verification:**
- Round-trip test: hand-crafted buffer → decoded correctly. Existing decodeBuffers tests still pass.

---

- [ ] **Unit 6: Rewrite serializeExplanations for structured data**

**Goal:** Replace NTriples-parsing serializeExplanations with one that consumes decoded justification data directly.

**Requirements:** R10, R12, R14, R15

**Dependencies:** Unit 5

**Files:**
- Modify: `ts/explanationSerializer.ts`
- Modify: `tests/unit/explanationSerializer.test.ts`

**Approach:**
- New signature: `serializeExplanations(store, justificationData, explanationGraphIri)` where justificationData is the structured type from Unit 5
- For each unique justification entry:
  - Create named node `namedNode(entry.iri)` (the `urn:konclude:j#<hex>` IRI)
  - `addQuad(jNode, rdf:type, kj:Justification, explGraph)`
  - For each axiomIdx: `addQuad(jNode, kj:axiom, <<axiom quoted triple>>, explGraph)` — N3 Store deduplicates
- For each mapping:
  - `addQuad(jNode, kj:justifies, <<inferred quoted triple>>, explGraph)`
- Remove N3 Parser import — no longer needed
- Remove NUL-split / tab-split parsing logic

**Patterns to follow:**
- Existing `buildQuotedTriple` helper in `ts/explanationSerializer.ts`

**Test scenarios:**
- Happy path: structured data with 2 justifications, 3 axioms → correct RDF-star quads in Store
- Happy path: two inferred triples sharing same justification → one jNode, two kj:justifies, shared kj:axiom quads
- Edge case: justification with zero axioms → jNode + kj:justifies but no kj:axiom
- Edge case: second call clears previous explanation graph
- Happy path: named node IRI matches `urn:konclude:j#<hex>` pattern

**Verification:**
- Unit tests pass. Store contains correct RDF-star triples. N3 Parser no longer imported.

---

- [ ] **Unit 7: Wire up index.ts — replace exportAllJustifications flow**

**Goal:** Replace all exportAllJustifications + serializeExplanations(bulkExport) call sites with decoded buffer justification data.

**Requirements:** R1, R9, R10, R16

**Dependencies:** Unit 4, Unit 5, Unit 6

**Files:**
- Modify: `ts/index.ts`

**Approach:**
- In _reasonOnStore / _materializeOnStore / _classifyPropertiesOnStore:
  - Pass `wantExplanations` flag to `_call("getInferredTripleBuffer", [wantExplanations])`
  - `decodeBuffers(resultBuf, { withJustifications: wantExplanations })` returns justification data
  - If justification data present, call new `serializeExplanations(store, justData, EXPLANATION_GRAPH_IRI)`
  - Remove all `exportAllJustifications` calls (4 call sites: lines 212, 284, 532, 663)
  - Replace `_ensureExplanationGraph` with a buffer-based equivalent: on cache hit with `wantExplanations`, check if explanation graph is already populated (store.getQuads count > 0 in explGraph). If not, re-call `getInferredTripleBuffer(true)` — WASM state persists so no re-classification needed — decode justifications and serialize into Store. This replaces the 3 cache-hit call sites (lines 257, 488, 637).

**Patterns to follow:**
- Existing `decodeBuffers` usage at line 274, 320, 514, etc.

**Test scenarios:**
- Happy path: classify(store, { explanations: true }) populates explanation graph from buffer
- Happy path: materialize(store, { explanations: true }) populates explanation graph
- Happy path: classifyProperties(store, { explanations: true }) populates explanation graph
- Edge case: explanations: false → no explanation graph, no justification parsing overhead
- Edge case: cache hit with explanations → explanation graph still populated
- Integration: Roberts family materialize with explanations completes without OOM

**Verification:**
- All 4 exportAllJustifications call sites removed. Explanation graph populated correctly. No regression on explanations: false path.

---

- [ ] **Unit 8: Replace explain() triple-keyed lookups with Store queries**

**Goal:** Replace _lookupTripleJustificationDirect / _hasTripleJustificationDirect with N3 Store getQuads on the explanation graph.

**Requirements:** R7, R11

**Dependencies:** Unit 7

**Files:**
- Modify: `ts/index.ts`
- Test: `tests/unit/RdfReasoner.explain.test.ts`
- Test: `tests/unit/RdfReasoner.explainEntailment.test.ts`
- Test: `tests/integration/native-justification.test.ts`

**Approach:**
- explain() causal mode (line 1744): replace `_hasTripleJustificationDirect` + `_lookupTripleJustificationDirect` with:
  - Ensure explanation graph is populated (may need a classify/materialize with explanations first)
  - `store.getQuads(null, kj:justifies, <<s p o>>, explGraph)` → find justification nodes
  - For each jNode: `store.getQuads(jNode, kj:axiom, null, explGraph)` → extract axiom quads
- explain() domain-chain (line 1806): mixed-source composition — triple justification comes from Store getQuads (replacing `_hasTripleJustificationDirect`), subclass justification comes from WASM via `_getSubClassJustificationDirect` (stays, uses JustificationCache). Merge both into the result quads array. Current code concatenates NTriples strings from both sources then parses; new code merges quad arrays directly.
- Remove `_lookupTripleJustificationDirect`, `_hasTripleJustificationDirect`, `_parseNTriplesJustification` methods
- Remove `_callDirect("lookupTripleJustification")` and `_callDirect("hasTripleJustification")`

**Patterns to follow:**
- Existing Store getQuads usage throughout index.ts

**Test scenarios:**
- Happy path: explain() for a subClassOf triple with justification → returns correct axiom quads
- Happy path: explain() for a rdf:type triple via domain-chain → returns correct justification
- Edge case: explain() for a triple with no justification in Store → falls through to legacy path
- Edge case: explain() mode "causal" without prior explanations call → graceful fallback
- Integration: existing explain test suite passes unchanged

**Verification:**
- _lookupTripleJustificationDirect and _hasTripleJustificationDirect removed. explain() tests pass. No WASM round-trips for triple-keyed lookups.

---

- [ ] **Unit 9: Cleanup — remove dead code and update tests**

**Goal:** Remove all dead code, update test suites for new behavior.

**Requirements:** R15, R17

**Dependencies:** Unit 8

**Files:**
- Modify: `ts/inlineWorker.ts` — remove lookupTripleJustification/hasTripleJustification/exportAllJustifications type declarations and handlers
- Modify: `tests/unit/explanationSerializer.test.ts` — update to use structured data input
- Modify: `tests/integration/explanation-persistence.test.ts` — verify named nodes instead of blank nodes
- Modify: `tests/integration/explanation-perf.test.ts` — update materialize threshold (was 500%, target <100%)
- Modify: `tests/integration/native-justification.test.ts` — if tests use triple-keyed lookup, update

**Approach:**
- Remove KoncludeReasonerInstance type members for deleted methods in inlineWorker.ts
- Update explanation-persistence tests: justification nodes are named (`urn:konclude:j#...`) not blank
- Update perf thresholds to reflect improved overhead
- Verify all existing test suites pass

**Patterns to follow:**
- Existing test patterns in explanation-persistence.test.ts

**Test scenarios:**
- Happy path: all explanation-persistence tests pass with named nodes
- Happy path: perf test: materialize overhead < 100%
- Happy path: classify overhead < 30%
- Integration: full test suite passes (476+ tests)

**Verification:**
- No dead code remains. All tests pass. Named node justifications verified.

## System-Wide Impact

- **Interaction graph:** buildInferredTripleBuffer → InternTable → axiom resolution → buffer assembly. Worker dispatch adds flag parameter. decodeBuffers → serializeExplanations → N3 Store. explain() → Store getQuads (no longer → WASM).
- **Error propagation:** Malformed justification data in buffer → decoder returns quads-only (graceful degradation). Missing dep tags → no justification for that triple (same as current behavior with JustificationTripleCache miss).
- **State lifecycle risks:** JustificationTripleCache removal eliminates a singleton cache. No cross-call state for justifications. Each buffer is self-contained.
- **API surface parity:** inlineWorker.ts must mirror worker.ts changes (remove same handlers, add same flag).
- **Integration coverage:** Roberts family materialize with explanations is the key integration test — must complete without OOM.
- **Unchanged invariants:** JustificationCache (tag→tag dep chain) is unchanged. getSubClassJustification/hasNativeJustification/getJustificationByType/hasJustificationByType methods stay — they serve explain() for dep-chain-based lookups that don't go through the triple-keyed cache.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Buffer format change requires WASM rebuild (~20-30 min) | Units 1-3 are C++ only; batch into single WASM rebuild |
| explain() regression — removing triple-keyed lookup breaks edge cases | Unit 8 tests against existing explain test suite; fallback to dep-chain path |
| Hash collision in dep tag hash → two justifications get same IRI | FNV-1a on int64 arrays has negligible collision at justification scale (<10K unique sets) |
| N3 Store addQuad performance for named-node RDF-star still slow | Dedup reduces total addQuad calls dramatically; if still slow, batch addQuads |
| explain() without prior explanations:true returns empty after this change | Auto-trigger buffer re-fetch on empty explanation graph (same UX as current _ensureExplanationGraph); document behavioral change |
| mWorkaroundJustifications (41 NTriples string refs) not dep-tag-based | Deferred to separate task (TS workaround justification capture). Current workaround paths emit triples without justifications — same gap exists today, not a regression |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-22-013-streaming-justification-buffer-requirements.md](docs/brainstorms/2026-07-22-013-streaming-justification-buffer-requirements.md)
- Related code: `src/KoncludeReasoner.cpp` (buffer assembly, axiom resolution), `ts/intern.ts` (decoder), `ts/explanationSerializer.ts` (serializer)
- Related plan: `docs/plans/2026-07-22-055-feat-explanation-persistence-n3-store-plan.md` (predecessor)
