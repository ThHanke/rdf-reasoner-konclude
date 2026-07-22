---
title: "feat: Persist explanations as RDF-star in N3 Store named graph"
type: feat
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-012-incremental-reasoning-explanation-persistence-requirements.md
---

# feat: Persist explanations as RDF-star in N3 Store named graph

## Overview

Add explanation persistence to the store-based reasoning API. When `explanations: true`, justifications are serialized as RDF-star triples into a `urn:konclude:explanations` named graph in the same N3 Store that holds the inferred triples. Consumers query explanations via `store.getQuads()` or Comunica SPARQL — no new query API is needed.

Phase 1 only. Phase 2 (incremental reasoning via Konclude's revision chain) is deferred pending the prerequisite audit documented in the origin document section 2.0.

## Problem Frame

Currently justifications exist only as in-memory JS arrays of `Quad[]`, consuming memory proportional to inferred triple count and offering no semantic query capability. Per-triple justification lookup requires one worker round-trip each — O(N) round-trips for N inferred triples. Explanation data cannot be persisted, serialized, or queried with SPARQL.

(see origin: `docs/brainstorms/2026-07-22-012-incremental-reasoning-explanation-persistence-requirements.md`)

## Requirements Trace

- R1. `classify(store, { explanations: true })`, `materialize(store, ...)`, and `classifyProperties(store, ...)` write RDF-star justification triples to `urn:konclude:explanations` graph
- R2. Explanation graph queryable via `store.getQuads()` with correct results (Comunica SPARQL compatibility documented but not a gated requirement)
- R3. Explanation serialization overhead measured and documented — target less than 30% of reasoning time (advisory, not a hard gate; threshold validated by Unit 8 benchmarks on reference ontology)
- R4. Zero perf overhead when `explanations: false` (default)
- R5. Inferred triples without justifications appear as nil-path entries (justifies without axioms)
- R6. `computeStoreFingerprint()` excludes explanation graph — explanation writes must not invalidate reasoning caches
- R7. Ship vocabulary definition as Turtle file in npm package

## Scope Boundaries

- No SPARQL engine bundled — consumers bring their own
- No incremental reasoning (Phase 2)
- No `whatIf()` explanation support — `whatIf()` ignores the `explanations` flag
- No TS-synthesized justification supplementation (sameAs propagation, disjointWith, domain-chain) — these appear as nil-path entries in Phase 1
- No configurable explanation graph IRI — hardcoded `urn:konclude:explanations`
- One justification per inferred triple (JustificationTripleCache overwrites; multiple justifications deferred)

### Deferred to Separate Tasks

- TS-synthesized justification supplementation into explanation graph: future PR after Phase 1 validates the encoding
- Configurable explanation graph IRI (`opts.explanationGraph`): future PR if consumers request it
- Multiple justifications per triple: requires JustificationTripleCache refactor to store vectors
- Phase 2 incremental reasoning: separate plan after prerequisite audit (origin doc section 2.0)

## Context & Research

### Relevant Code and Patterns

| File | Role |
|------|------|
| `ts/index.ts` | `RdfReasoner` class — store-based API overloads, queue/cache management |
| `ts/worker.ts` | Worker dispatch — maps method names to Embind calls |
| `ts/types.ts` | Exported type interfaces, graph IRI constants |
| `ts/intern.ts` | `computeStoreFingerprint()`, `InternTable`, binary encode/decode |
| `src/KoncludeReasoner.cpp` | C++ Pimpl — `buildInferredTripleBuffer()` populates `JustificationTripleCache` |
| `src/KoncludeReasoner.h` | C++ public API header |
| `src/bindings.cpp` | Embind registration |
| `src/JustificationTripleCache.h` | IRI-keyed singleton cache (sub,pred,obj) → NTriples justification string |
| `src/JustificationCache.h` | Tag-keyed thread-safe cache (subTag,superTag,type) → dep tags |

**Store-based API pattern:** All three store methods (`classify`, `materialize`, `classifyProperties`) follow: fingerprint → cache check → clear inferred graph → encode → Worker load → reason → get buffer → decode → write to store. Explanation persistence plugs in after the decode/write step.

**Worker dispatch pattern:** `_call(method, ...args)` with typed `postMessage`. New Embind methods get a new method name in the dispatch. Binary data transferred via ArrayBuffer transfer list.

**JustificationTripleCache lifecycle:** Populated during `buildInferredTripleBuffer()` / `buildPropertyTripleBuffer()` (single-threaded, after KPSet threads join). Cleared on `reset()`. Already contains all C++-resolved justifications as NTriples strings by the time the TS layer receives the inferred triple buffer.

### Institutional Learnings

- **Threading invariants** (`docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`): All 9 invariants apply to new Embind surface. `exportAllJustifications()` runs single-threaded after KPSet join — no new threading concerns for Phase 1.
- **TS→C++ workaround migration pattern** (`docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`): Follow Impl fields + `buildXxxBuffer()` + `reset()` wiring pattern for new C++ API surface.
- **Over-materialization fix** (`docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`): Iterate unique `CHierarchyNode*` pointers, guard stale parents, use `getConceptTag()` for deterministic selection. Same care needed in justification traversal.
- **BackendAssCache n=3 corruption** (`docs/solutions/logic-errors/backend-asscache-slot-collision-same-individual-2026-05-28.md`): Phase 2 blocker. Not relevant to Phase 1 (no cross-call state preservation).

## Key Technical Decisions

- **Vocabulary namespace:** `urn:konclude:justification#` — matches existing `urn:konclude:*` pattern for inferred/hypothetical graphs. Three terms: `kj:Justification` (class), `kj:justifies` (property → RDF-star quoted triple), `kj:axiom` (property → RDF-star quoted triple).
- **Vocabulary file:** Ship `vocab/kj.ttl` in npm package for tool interoperability.
- **Bulk export wire format:** Concatenated NTriples blocks with `\x00` separator per entry. Each block: `sub\tpred\tobj\n` (the inferred triple key) followed by NTriples lines (justification axioms). Simplest format — JustificationTripleCache already stores NTriples strings. Single `std::string` return via Embind, single worker round-trip.
- **Explanation graph lifecycle:** Clear and rebuild on each reasoning call — matches inferred graph pattern. Prevents stale justifications for no-longer-inferred triples.
- **Parsing approach:** TS parses the bulk export string, creates RDF-star quads using N3.js `DataFactory.quad()` for quoted triples, writes to explanation graph. No binary protocol needed — justification data is already NTriples text.
- **Cache hit behavior:** When fingerprint matches (no store changes), explanation graph is already populated from prior call — no re-work. If user manually cleared explanation graph between calls, cache still reports hit (matches existing inferred graph behavior, documented caveat).

## Open Questions

### Resolved During Planning

- **kj: namespace URI:** `urn:konclude:justification#` — matches existing pattern, no hosting needed.
- **Ship OWL/Turtle vocab file:** Yes, as `vocab/kj.ttl`.
- **Explanation graph lifecycle:** Clear and rebuild each call (matches inferred graph).
- **whatIf() interaction:** Does not support `explanations` flag in Phase 1.
- **Wire format for bulk export:** Tab-separated key + NTriples body, NUL-separated entries. JustificationTripleCache already stores resolved NTriples; no tag resolution needed at export time.
- **TS-synthesized justifications:** Nil-path entries in Phase 1. TS synthesis paths (sameAs propagation, disjointWith, domain-chain in `explainEntailment`) are not wired into the explanation graph yet.

### Deferred to Implementation

- **N3 Store memory footprint of RDF-star explanation triples vs current Quad[][] representation:** Measure during PoC spike (Unit 1). If explanation triples use significantly more memory, document and revisit encoding.
- **Comunica SPARQL cross-graph join with RDF-star quoted triples:** Validate during PoC spike (Unit 1). Fallback: `store.getQuads()` pattern matching always works.
- **Blank nodes in RDF-star quoted triple positions:** Validate during PoC spike per origin doc section 1.0.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                         ┌─────────────────────────────────────┐
                         │        classify(store, opts)        │
                         │  explanations: true                 │
                         └─────────┬───────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  Existing reasoning pipeline │
                    │  encode → Worker → WASM →    │
                    │  buildInferredTripleBuffer() │
                    │  (populates JustTripleCache) │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  Decode inferred triples     │
                    │  Write to urn:konclude:inferred │
                    └──────────────┬───────────────┘
                                   │ if explanations: true
                    ┌──────────────▼──────────────┐
                    │  Worker: exportAllJustifications() │
                    │  Iterate JustTripleCache.entries   │
                    │  Return: "sub\tpred\tobj\n         │
                    │           <ntriples axioms>\x00..."│
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  TS: Parse bulk export       │
                    │  For each (triple, axioms):  │
                    │    _:jN a kj:Justification   │
                    │    _:jN kj:justifies <<s p o>>│
                    │    _:jN kj:axiom <<ax_s ax_p ax_o>>│
                    │  Write to urn:konclude:explanations │
                    └──────────────────────────────┘
```

## Implementation Units

- [x] **Unit 1: RDF-star PoC spike**

**Goal:** Validate core encoding assumptions before committing to implementation. Confirm RDF-star quoted triples work in N3 Store, Comunica can join across named graphs, and blank nodes in quoted positions behave correctly.

**Requirements:** R2 (queryability validation), R5 (nil-path validation)

**Dependencies:** None

**Files:**
- Create: `tests/integration/rdfstar-poc-spike.test.ts`

**Approach:**
- Write a self-contained test that creates an N3 Store with two named graphs: an "inferred" graph with real triples and an "explanations" graph with RDF-star justification triples using the `kj:` vocabulary
- Test `store.getQuads()` retrieval of RDF-star quads from explanation graph
- Test Comunica SPARQL query joining quoted triples against materialized triples across named graphs (if `@comunica/query-sparql-rdfjs` is available as dev dep; if not, skip SPARQL test and document)
- Test blank nodes in quoted triple positions (OWL restrictions often use blank nodes)
- Measure N3 Store memory footprint: create 1000 explanation quads and compare store size vs equivalent `Quad[][]` representation

**Patterns to follow:**
- Existing integration tests in `tests/integration/` (vitest, `describe`/`it` blocks)

**Test scenarios:**
- Happy path: Write RDF-star justification quad `_:j1 kj:justifies << :Dog rdfs:subClassOf :Animal >>` to explanation graph → `store.getQuads(null, kj:justifies, null, explanationGraph)` returns the quad with correct RDF-star object
- Happy path: Write both `kj:justifies` and `kj:axiom` RDF-star quads → query returns complete justification structure
- Edge case: Blank node in quoted triple position (`<< _:b1 rdf:type :Dog >>`) → Store stores and retrieves correctly
- Integration: Comunica SPARQL `SELECT ?j ?axiom WHERE { GRAPH <urn:konclude:explanations> { ?j kj:justifies << :Dog rdfs:subClassOf :Animal >> . ?j kj:axiom ?axiom } }` returns expected bindings (skip if Comunica not available)
- Edge case: Empty justification (nil-path) — `_:j1 kj:justifies <<s p o>>` with no `kj:axiom` triples → query returns justification with zero axioms

**Verification:**
- All PoC tests pass
- Memory measurement logged (informational, not a gate — document results for later reference)

---

- [x] **Unit 2: Vocabulary definition and constants**

**Goal:** Define the `kj:` RDF vocabulary and ship as a Turtle file. Add TS constants for explanation graph IRI and vocabulary terms.

**Requirements:** R1, R7

**Dependencies:** None (vocabulary definition is deterministic; Unit 1 validates encoding assumptions independently)

**Files:**
- Create: `vocab/kj.ttl`
- Modify: `ts/types.ts`
- Modify: `package.json` (add `vocab/` to `files` array)

**Approach:**
- Define `kj:Justification`, `kj:justifies`, `kj:axiom` in Turtle with `rdfs:label`, `rdfs:comment`, and `rdfs:domain`/`rdfs:range` declarations
- Add `EXPLANATION_GRAPH_IRI = "urn:konclude:explanations"` constant to `ts/types.ts` alongside existing `INFERRED_GRAPH_IRI` and `HYPOTHETICAL_IRI`
- Add `KJ_NS`, `KJ_JUSTIFICATION`, `KJ_JUSTIFIES`, `KJ_AXIOM` string constants to `ts/types.ts`
- Export all new constants from `ts/index.ts`
- Add `"vocab"` to `package.json` `files` array so the Turtle file ships with the npm package

**Patterns to follow:**
- Existing constant definitions in `ts/types.ts` lines 3-29

**Test expectation:** none — pure constants and static vocabulary file

**Verification:**
- `npm run build` succeeds
- Constants exported and accessible
- `vocab/kj.ttl` parses as valid Turtle (N3 Parser can load it)

---

- [x] **Unit 3: Fingerprint exclusion**

**Goal:** Exclude `urn:konclude:explanations` from `computeStoreFingerprint()` so explanation writes don't invalidate reasoning caches.

**Requirements:** R6

**Dependencies:** Unit 2 (constants defined)

**Files:**
- Modify: `ts/intern.ts`
- Modify: `tests/unit/intern.test.ts` (or create if not exists)

**Approach:**
- Add `EXPLANATION_GRAPH_IRI` to the skip condition on line 209 of `ts/intern.ts`, alongside existing `INFERRED_GRAPH_IRI` and `HYPOTHETICAL_IRI` exclusions
- Import the new constant from `ts/types.ts`

**Patterns to follow:**
- Existing exclusion pattern at `ts/intern.ts` line 209: `if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) continue;`

**Test scenarios:**
- Happy path: Store with quads in explanation graph → fingerprint matches store without explanation quads
- Edge case: Store with quads in explanation, inferred, AND hypothetical graphs → fingerprint only reflects non-excluded graphs

**Verification:**
- Fingerprint is stable across explanation graph additions/removals
- Existing tests still pass

---

- [x] **Unit 4: C++ bulk justification export**

**Goal:** Add `exportAllJustifications()` Embind method that returns all entries from `JustificationTripleCache` in a single call, eliminating O(N) worker round-trips.

**Requirements:** R1, R3

**Dependencies:** None (can be developed in parallel with Units 1-3 if WASM build is available)

**Files:**
- Modify: `src/KoncludeReasoner.h`
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `src/bindings.cpp`

**Approach:**
- Add `std::string exportAllJustifications()` method to `KoncludeReasoner`
- Iterate `JustificationTripleCache::instance().entries`
- For each entry: append `sub\tpred\tobj\n` + justification NTriples string + `\x00` separator
- Return concatenated string — Embind handles `std::string` → JS string conversion
- No mutex needed: called single-threaded after KPSet join (same thread safety model as `lookupTripleJustification`)
- Register in `bindings.cpp` alongside existing methods

**Patterns to follow:**
- `lookupTripleJustification()` in `src/KoncludeReasoner.cpp` for cache access pattern
- `buildInferredTripleBuffer()` for the single-threaded post-reasoning execution context
- Embind registration in `src/bindings.cpp`

**Test scenarios:**
- Happy path: After classify with known ontology → `exportAllJustifications()` returns non-empty string containing expected triple keys and axiom NTriples
- Happy path: After classifyProperties → export includes PropertySubsumption entries
- Edge case: No justifications available (empty ontology) → returns empty string
- Edge case: Workaround justifications (from `mWorkaroundJustifications`) present in JustificationTripleCache → included in export

**Verification:**
- Embind method callable from Worker
- Export contains all entries that `lookupTripleJustification()` would return individually
- No new threading concerns (single-threaded access confirmed)

---

- [x] **Unit 5: Worker dispatch for bulk export**

**Goal:** Wire `exportAllJustifications` through the Worker postMessage dispatch so TS can call it via `_call()`.

**Requirements:** R1

**Dependencies:** Unit 4 (C++ method exists)

**Files:**
- Modify: `ts/worker.ts`

**Approach:**
- Add `"exportAllJustifications"` case to the Worker dispatch switch/map
- Call `reasoner.exportAllJustifications()` and return string result
- Follow existing dispatch pattern — no binary transfer needed (string return)

**Patterns to follow:**
- Existing method dispatch in `ts/worker.ts` (e.g., `lookupTripleJustification`)

**Test expectation:** none — pure wiring, tested through integration in Unit 7

**Verification:**
- `_call("exportAllJustifications")` returns string from Worker without error

---

- [x] **Unit 6: TS explanation serializer**

**Goal:** Parse the bulk export string and serialize justifications as RDF-star triples into an N3 Store named graph.

**Requirements:** R1, R2, R5

**Dependencies:** Unit 2 (vocabulary constants), Unit 1 (encoding validated)

**Files:**
- Create: `ts/explanationSerializer.ts`
- Test: `tests/unit/explanationSerializer.test.ts`

**Approach:**
- Export function `serializeExplanations(store: Store, bulkExport: string, explanationGraph: string): void`
- Clear explanation graph in store before writing (clear-and-rebuild lifecycle)
- Split bulk export by `\x00` separator
- For each entry: parse key line (`sub\tpred\tobj`) and axiom NTriples body
- Create blank node `_:jN` for each justification
- Create RDF-star quoted triple for the justified inference: `DataFactory.quad(sub, pred, obj)` as the object of `kj:justifies`
- Parse axiom NTriples lines, create RDF-star quoted triple for each axiom as object of `kj:axiom`
- If no axiom lines present → nil-path: emit `kj:justifies` only (R5)
- After serializing all bulk export entries, iterate inferred triples in the store (from inferred graph). Any inferred triple without a corresponding `kj:justifies` entry in the explanation graph gets a nil-path entry (R5 completeness — covers triples where `storeTripleJustification` skipped insertion due to empty justification string)
- Write all quads to store with explanation graph as named graph
- Use N3.js `DataFactory` for all term/quad creation

**Patterns to follow:**
- N3.js `DataFactory.quad()` for RDF-star quoted triples (validated in Unit 1 PoC)
- NTriples parsing via N3 `Parser` with `format: 'N-Triples'`

**Test scenarios:**
- Happy path: Single justification with 2 axioms → store contains `_:j1 a kj:Justification`, `_:j1 kj:justifies <<s p o>>`, `_:j1 kj:axiom <<ax1>>`, `_:j1 kj:axiom <<ax2>>` in explanation graph
- Happy path: Multiple justifications → each gets unique blank node, all in explanation graph
- Edge case: Nil-path entry (no axioms) → `_:j1 kj:justifies <<s p o>>` with zero `kj:axiom` triples
- Edge case: Empty bulk export string → explanation graph cleared, no quads written
- Edge case: Axiom triple contains blank node IRI (e.g., `_:b1`) → RDF-star quoted triple uses blank node correctly
- Error path: Malformed NTriples in one bulk export entry → per-entry try/catch logs warning, emits nil-path entry for that triple, continues with remaining entries
- Happy path: Second call clears previous explanation quads → no stale data accumulates

**Verification:**
- `store.getQuads(null, null, null, explanationGraph)` returns expected RDF-star structure
- Nil-path entries distinguishable from full justifications via absence of `kj:axiom` triples

---

- [x] **Unit 7: Wire explanations into store-based API**

**Goal:** Add `explanations?: boolean` option to store-based API methods and wire the full pipeline: reasoning → bulk export → serialize to explanation graph.

**Requirements:** R1, R3, R4

**Dependencies:** Unit 5 (worker dispatch), Unit 6 (serializer) — Unit 3 (fingerprint exclusion) is independent and can proceed in parallel

**Files:**
- Modify: `ts/types.ts` (add `explanations` to option interfaces)
- Modify: `ts/index.ts` (wire explanation pipeline into classify/materialize/classifyProperties store paths)
- Test: `tests/integration/explanation-persistence.test.ts`

**Approach:**
- Add `explanations?: boolean` to `StoreReasoningOptions`, `MaterializeStoreOptions`, `ClassifyPropertiesStoreOptions`
- Note: explanation graph covers all entailments regardless of TS-side filtering (e.g., `materialize` without `includeClassHierarchy` still produces justifications for subClassOf triples). This is intentional — explanation graph is a superset.
- Clear explanation graph alongside inferred graph before encoding (prevents RDF-star quads from entering `encodeToBuffers` and reaching the WASM reasoner — explanation quads must never be sent to Konclude as input)
- In each store-based method path, after writing inferred quads to store:
  - If `explanations: true`: call `_call("exportAllJustifications")`, then `serializeExplanations(store, result, EXPLANATION_GRAPH_IRI)`
  - If `explanations: false` or absent: skip (R4 zero overhead)
- On cache hit path: if `explanations: true` but explanation graph is empty (prior call used `explanations: false`), run just the bulk export + serialize step without re-reasoning — `JustificationTripleCache` persists until `reset()`. If explanation graph already populated, skip.

**Patterns to follow:**
- Existing store-based method pattern in `ts/index.ts` (fingerprint → cache check → clear → encode → reason → decode → write)
- `returnDelta` option in `MaterializeStoreOptions` for how optional features are wired

**Test scenarios:**
- Happy path: `classify(store, { explanations: true })` with simple ontology (A subClassOf B, B subClassOf C) → explanation graph contains justification for A subClassOf C with axioms A⊑B and B⊑C as RDF-star quads
- Happy path: `materialize(store, { explanations: true })` with ABox → explanation graph contains rdf:type justifications
- Happy path: `classifyProperties(store, { explanations: true })` → explanation graph contains property subsumption justifications
- Happy path: `classify(store)` (no explanations flag) → explanation graph empty, no bulk export call made (R4)
- Happy path: Second `classify(store, { explanations: true })` without store changes → cache hit, explanation graph still populated
- Edge case: `classify(store, { explanations: true })` then `classify(store, { explanations: false })` on unchanged store → cache hit, explanation graph persists from prior call (matches cache-hit behavior described in approach)
- Integration: After `classify(store, { explanations: true })`, `store.getQuads(null, kj:justifies, null, explanationGraph)` returns one RDF-star quad per justified inference
- Edge case: Inferred triple with no C++ justification → nil-path entry in explanation graph

**Verification:**
- All 328+ existing tests still pass (no regression)
- Explanation graph populated only when `explanations: true`
- Existing perf benchmarks show no regression when `explanations: false`

---

- [x] **Unit 8: Performance benchmark**

**Goal:** Measure explanation serialization overhead and validate R3 (less than 30% added time).

**Requirements:** R3

**Dependencies:** Unit 7 (full pipeline working)

**Files:**
- Create: `tests/integration/explanation-perf.test.ts`

**Approach:**
- Use a reference ontology with meaningful justification coverage (reuse existing test ontologies or the OWL 2 DL parity suite)
- Time `classify(store)` vs `classify(store, { explanations: true })` — multiple runs, median
- Time `materialize(store)` vs `materialize(store, { explanations: true })` — same
- Log bulk export string size and explanation quad count
- Log N3 Store memory footprint with and without explanation graph (if measurable via `process.memoryUsage()` delta)
- Measure explanation overhead as percentage of reasoning time; document results; flag if exceeds 30% target (advisory — see R3)

**Patterns to follow:**
- Existing integration test patterns in `tests/integration/`

**Test scenarios:**
- Happy path: classify with explanations adds < 30% overhead for reference ontology
- Happy path: materialize with explanations adds < 30% overhead
- Measurement: Log absolute times, quad counts, and memory for documentation

**Verification:**
- 30% threshold met for all three operations
- Results documented for future reference

## System-Wide Impact

- **Interaction graph:** Store-based API methods (`classify`, `materialize`, `classifyProperties`) gain explanation persistence step after inferred triple write. Cache invalidation unchanged — explanation writes excluded from fingerprint.
- **Error propagation:** Bulk export failure propagates as promise rejection from `_call()`. Explanation serialization failure propagates similarly. Both handled by existing `_queue` error chain.
- **State lifecycle risks:** Explanation graph cleared alongside inferred graph on each reasoning call. Cache hit path leaves explanation graph from prior call intact. If user clears explanation graph manually between calls, stale-cache behavior matches existing inferred graph caveat.
- **API surface parity:** `whatIf()` does NOT support `explanations` flag — document this. Quad-array API overloads (non-store) do not support explanations.
- **Integration coverage:** Full round-trip test (Unit 7) covers: TS encode → Worker → WASM reasoning → justification cache population → bulk export → Worker → TS parse → RDF-star serialization → N3 Store write → getQuads retrieval.
- **Unchanged invariants:** Existing `explainEntailment()` / `getSubClassJustification()` / per-triple lookup APIs unchanged. Explanation graph is additive — no existing behavior modified.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| RDF-star in N3.js edge cases with blank nodes in quoted triples | PoC spike (Unit 1) tests this before implementation |
| Comunica cross-graph join with RDF-star may not work | PoC spike validates; fallback is `store.getQuads()` (always works) |
| Bulk export string size could be large for ontologies with many justifications | Measure in Unit 8; future optimization: binary buffer protocol |
| N3 Store memory for explanation triples may exceed current Quad[][] | Measure in Unit 1 (PoC) and Unit 8 (benchmark); nil-path entries are lightweight |
| JustificationTripleCache overwrites → only last justification stored per triple | Document as known limitation; multi-justification support deferred |
| WASM rebuild required for Unit 4 (~20-30 min) | Plan Unit 4 early; Units 1-3, 6 can proceed without WASM |

## Documentation / Operational Notes

- Add explanation persistence section to README with vocabulary definition, graph IRI, example queries
- Document nil-path behavior for inferred triples without justifications
- Document `whatIf()` limitation (no explanation support)
- Document cache hit behavior caveat (manually clearing explanation graph not detected)

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-22-012-incremental-reasoning-explanation-persistence-requirements.md](docs/brainstorms/2026-07-22-012-incremental-reasoning-explanation-persistence-requirements.md)
- Related code: `ts/index.ts` (store-based API), `src/KoncludeReasoner.cpp` (justification resolution), `src/JustificationTripleCache.h`
- Learnings: `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`, `docs/solutions/architecture-patterns/wasm-threading-model-invariants.md`
- N3.js RDF-star: confirmed working in v1.26.0 (installed), support since v1.17
