---
title: "feat: Direct N3 Store index injection for inferred + explanation writes"
type: feat
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-014-n3-direct-index-injection-requirements.md
---

# feat: Direct N3 Store index injection for inferred + explanation writes

## Overview

Replace all `decodeBuffers()` → Quad[] → `store.addQuad()` paths with direct N3 Store internal index population. Bypasses Quad object allocation, DataFactory, and N3's `termToId()` entirely. Covers both inferred triples and explanation RDF-star quads. JS-only change — no C++ modifications.

## Problem Frame

Every quad returned from the WASM worker currently goes through three allocation layers:

1. `decodeBuffers()` creates `Quad` objects via `DataFactory.quad/namedNode/blankNode/literal`
2. For explanations, `serializeExplanations()` creates additional RDF-star Quad objects
3. `store.addQuad()` converts each Quad back to strings via `termToId()`, assigns numeric IDs, builds 3 index permutations

The intermediate Quad objects are immediately decomposed back into strings — pure waste. PoC shows 2.6× speedup for simple triples, 5.0× for RDF-star quoted triples (see origin: `docs/brainstorms/2026-07-22-014-n3-direct-index-injection-requirements.md`).

## Requirements Trace

- R1. (Deferred) Inferred triples written to N3 Store via direct index injection — generalize after explanation path proven
- R2. Explanation RDF-star quads written via direct index injection (no addQuad, no serializeExplanations)
- R3. All existing `getQuads()` queries return identical results to current addQuad path
- R4. `_lookupJustificationFromStore` works unchanged (quoted triple pattern matching)
- R5. Non-Store decode paths (`_reasonOnQuads`, `_materializeOnQuads`, `_classifyPropertiesOnQuads`) unchanged
- R6. N3 version compatibility check at runtime
- R7. Measurable speedup on explanation write path (target: ≥2× on RDF-star quads)

## Scope Boundaries

- JS-only — no C++ InternTable format changes (N3-format string emission deferred)
- Output write path only (Store ← buffer)
- Input read path unchanged (Store → encodeToBuffers)

### Deferred to Separate Tasks

- C++ emitting strings in N3 termToId format directly (eliminates `toN3EntityKey` conversion)
- Input path optimization (reading N3 internals instead of `store.getQuads()` → `encodeToBuffers()`)
- Inferred triple injection (generalize the explanation injection to cover inferred triples — after explanation path is proven)

## Context & Research

### Relevant Code and Patterns

- `ts/intern.ts` — `decodeBuffers()`, `parseStringTable()`, `decodeTriples()`, `decodeTerm()` — current decode path
- `ts/explanationSerializer.ts` — `serializeExplanations()` — current RDF-star write path
- `ts/index.ts:209-215` — `_ensureExplanationGraphFromBuffer` — cache-hit explanation write
- `ts/index.ts:274-287` — `_reasonOnStore` explanation path
- `ts/index.ts:515-522` — `_materializeOnStore` explanation path
- `ts/index.ts:657-665` — `_classifyPropertiesOnStore` explanation path
- `ts/index.ts:1166-1186` — `_lookupJustificationFromStore` — queries explanation graph
- `tests/unit/n3-direct-injection.test.ts` — PoC with `getOrCreateId`, `injectQuad`, `getOrCreateQuotedTripleId`, `toN3EntityKey`
- `node_modules/n3/src/N3Store.js:83-135` — N3EntityIndex internals (`_ids`, `_entities`, `_id`)
- `node_modules/n3/src/N3Store.js:355-389` — `addQuad()` — what we bypass
- `node_modules/n3/src/N3DataFactory.js:243-272` — `termToId()` — string format we must match

### Institutional Learnings

- Type-tag encoding (top 2 bits of uint32) is load-bearing for existing non-Store decode paths — must preserve for `decodeBuffers()` without `withJustifications` flag (see `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md`)
- `store._size = null` invalidation: `computeStoreFingerprint` explicitly excludes explanation graph, so no hot-path issue
- `librdf_model_remove_statement` unreliable — only skip at insertion time works (not relevant here but informs design thinking)

## Key Technical Decisions

- **New module `ts/n3Inject.ts`**: Isolate all N3 internal access in one file. If N3 changes internals, only this file needs updating. Cleaner than spreading `_ids`/`_entities` access across intern.ts and explanationSerializer.ts.
- **Keep `decodeBuffers()` unchanged**: Non-Store paths (legacy `reason(quads)`, `materialize(quads)`, etc.) still return Quad[]. Only Store-based paths use direct injection.
- **Single function `injectBufferIntoStore()`**: Takes the combined buffer + store + graph IRI + optional justification flag. Does string table parse → N3 entity key conversion → bulk ID registration → triple injection + optional explanation injection in one pass. No intermediate Quad[] allocation.
- **Explanation graph clear via N3 internals**: Instead of `store.removeQuads(store.getQuads(...))` (which allocates Quad objects to delete them), delete `store._graphs[explGraphId]` directly.
- **N3 version guard**: Check `store._entityIndex` and `store._graphs` exist at call time. Throw clear error if N3 internals changed.

## Open Questions

### Resolved During Planning

- **Why not optimize non-Store paths too?** Non-Store paths (`_reasonOnQuads`, etc.) return `Quad[]` to the caller — they NEED Quad objects. Only Store paths can skip allocation.
- **Thread safety of N3 internals?** N3 Store is single-threaded JS. No concern.
- **Does Object.freeze on graphItem matter?** Yes — N3 freezes the graphItem shell object but NOT the nested index objects. Our injection writes to the nested objects (subjects/predicates/objects), which are mutable. The freeze only prevents adding new properties to the graphItem itself. Must match: create graphItem with `{ subjects: {}, predicates: {}, objects: {} }` then `Object.freeze()`.

### Deferred to Implementation

- Exact performance numbers on roberts-family (run timing breakdown test after implementation)
- Whether `toN3EntityKey` literal format edge cases exist beyond the PoC test coverage

## Implementation Units

- [ ] **Unit 1: Extract and harden N3 injection helpers into `ts/n3Inject.ts`**

**Goal:** Move PoC helpers from test file into production module with proper typing and N3 version guard.

**Requirements:** R2, R6

**Dependencies:** None

**Files:**
- Create: `ts/n3Inject.ts`
- Modify: `tests/unit/n3-direct-injection.test.ts` (import from production module instead of inline)
- Test: `tests/unit/n3-direct-injection.test.ts`

**Approach:**
- Move `toN3EntityKey`, `getOrCreateId`, `getOrCreateQuotedTripleId`, `injectQuad` from test to `ts/n3Inject.ts`
- Add `assertN3Internals(store)` guard that checks `store._entityIndex?._ids` and `store._graphs` exist, throws if not
- Add `clearGraph(store, graphId)` helper that deletes `store._graphs[graphId]` and sets `store._size = null`
- Update PoC test to import from production module

**Patterns to follow:**
- `ts/intern.ts` module structure (exports, TextDecoder usage, type definitions)
- `ts/explanationSerializer.ts` function signature pattern

**Test scenarios:**
- Happy path: existing PoC tests pass when importing from `ts/n3Inject.ts` instead of inline
- Edge case: `assertN3Internals` throws on a plain object `{}` that lacks `_entityIndex`
- Edge case: `clearGraph` removes all quads from a specific named graph, leaves other graphs intact
- Edge case: `toN3EntityKey` handles literal with empty language and empty datatype → `'"value"'`
- Edge case: `toN3EntityKey` handles literal with `xsd:string` datatype → `'"value"'` (suppressed, matches N3 convention)

**Verification:**
- All 4 existing PoC tests pass
- New guard and clearGraph tests pass
- `npm run build` succeeds (TypeScript compiles)

---

- [ ] **Unit 2: Implement `injectExplanationsFromBuffer()` for justification/explanation data**

**Goal:** New function that takes the combined buffer (with justifications) and populates the N3 Store's explanation graph via direct index injection — no Quad objects, no serializeExplanations.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `ts/n3Inject.ts`
- Create: `tests/unit/n3-inject-buffer.test.ts`

**Approach:**
- Parse string table from buffer (reuse `parseStringTable` logic from `ts/intern.ts` — import or inline)
- Build N3 entity key cache: on first encounter of each string table index (via triple ID), extract type from top 2 bits, convert via `toN3EntityKey`, register in N3's `_ids`/`_entities`
- Scan for magic marker `0xDEADBEEF` to find justification section
- Parse axiom triples, justification entries, mappings from buffer (same layout as current `decodeBuffers`)
- For each justification entry: register `urn:konclude:j#<hex>` as N3 entity key, inject `rdf:type kj:Justification` quad
- For each axiom in entry: register inner s/p/o terms, compute quoted triple ID via `getOrCreateQuotedTripleId`, inject `kj:axiom` quad with quoted triple as object
- For each mapping: register inferred triple's s/p/o terms, compute quoted triple ID, inject `kj:justifies` quad
- Pre-register the fixed vocabulary IRIs (`rdf:type`, `kj:Justification`, `kj:justifies`, `kj:axiom`) once

**Technical design:** *(directional guidance, not implementation specification)*

Key detail on type tags: the type tag is baked into each uint32 ID at intern time (`id = (index & 0x3FFFFFFF) | (type << 30)`). Each string table entry has exactly one type. Extract type from the first triple ID that references a given index, cache the converted N3 entity key. Subsequent references reuse the cached key.

The function also needs to parse the inferred triples section (before the magic marker) to resolve triple indices in the mapping section — but it does NOT inject the inferred triples into the store (that stays on the existing addQuad path for now; generalization deferred).

**Patterns to follow:**
- `decodeBuffers()` justification parsing (intern.ts lines 147-198)
- `serializeExplanations()` RDF-star quad construction (explanationSerializer.ts)
- PoC `getOrCreateQuotedTripleId` for `.sId.pId.oId` format

**Test scenarios:**
- Happy path: buffer with 1 justification, 2 axioms, 1 mapping → store has `rdf:type Justification`, `kj:axiom` with quoted axiom triples, `kj:justifies` with quoted inferred triple
- Happy path: multiple justifications sharing axioms → axiom entity keys deduplicated (same numeric ID)
- Happy path: `_lookupJustificationFromStore` pattern works: `getQuads(null, kj:justifies, <<quoted>>, explGraph)` returns the justification node; `getQuads(jNode, kj:axiom, null, explGraph)` returns axiom quoted triples
- Edge case: zero justifications (no magic marker) → no explanation graph entries
- Edge case: justification with zero axioms → `rdf:type Justification` present, no `kj:axiom` quads
- Integration: compare full explanation output against `decodeBuffers({withJustifications: true})` + `serializeExplanations()` for same buffer — identical `getQuads` results on explanation graph

**Verification:**
- All unit tests pass
- `_lookupJustificationFromStore` pattern verified in test
- Comparison test proves identical results to current path

---

- [ ] **Unit 3: Wire `injectExplanationsFromBuffer` into `ts/index.ts`**

**Goal:** Replace `serializeExplanations` calls with `injectExplanationsFromBuffer`. Inferred triples stay on existing `decodeBuffers` + `addQuad` path for now.

**Requirements:** R2, R3, R4, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `ts/index.ts`
- Test: `tests/integration/explanation-persistence.test.ts`
- Test: `tests/integration/explanation-perf.test.ts`

**Approach:**
- In `_reasonOnStore` (wantExplanations branch): keep `decodeBuffers` for inferred Quad[], keep addQuad loop for inferred triples. Replace `serializeExplanations(store, decoded.justifications, decoded.quads, ...)` with `injectExplanationsFromBuffer(store, resultBuf, EXPLANATION_GRAPH_IRI)`
- Same pattern in `_materializeOnStore` and `_classifyPropertiesOnStore`
- In `_ensureExplanationGraphFromBuffer`: replace decodeBuffers + serializeExplanations with `injectExplanationsFromBuffer`
- Remove explanation graph clear from calling code — `injectExplanationsFromBuffer` handles it via `clearGraph`
- Keep `serializeExplanations` module (may have external consumers), remove import from `ts/index.ts`
- Keep `decodeBuffers` unchanged — still used for inferred triples and non-Store paths

**Test scenarios:**
- Happy path: `classify(store, { explanations: true })` → explanation graph populated, `_lookupJustificationFromStore` works
- Happy path: `materialize(store, { explanations: true })` → inferred triples in inferred graph, explanations in explanation graph
- Happy path: `classifyProperties(store, { explanations: true })` → property hierarchy + explanations
- Happy path: cache hit → `_ensureExplanationGraphFromBuffer` populates explanation graph on demand
- Happy path: without explanations → no explanation graph, inferred triples present
- Edge case: sequential calls with different explanation flags → graph correctly cleared/populated each time
- Integration: full pipeline with explanations matches current output

**Verification:**
- All existing explanation-persistence integration tests pass
- All existing explanationSerializer unit tests still pass (module untouched)
- Explanation perf test passes with improved or equal timing

---

- [ ] **Unit 4: Timing validation and threshold update**

**Goal:** Run timing breakdown test, verify speedup, update perf thresholds if warranted.

**Requirements:** R7

**Dependencies:** Unit 3

**Files:**
- Modify: `tests/integration/explanation-timing-breakdown.test.ts` (update to measure new path)
- Modify: `tests/integration/explanation-perf.test.ts` (tighten thresholds if speedup confirmed)

**Approach:**
- Run explanation-timing-breakdown test, capture before/after numbers
- The overhead breakdown should show reduced `OUT_serializeExpl` and `OUT_addQuad_expl` times
- If materialize explanation overhead drops significantly, tighten the 1600% threshold in explanation-perf.test.ts

**Test scenarios:**
- Happy path: explanation overhead % is lower than before the change
- Happy path: all perf thresholds pass

**Verification:**
- Timing breakdown test shows measurable improvement
- Perf test passes with current or tightened thresholds

## System-Wide Impact

- **Interaction graph:** `_lookupJustificationFromStore` (used by `explainEntailment`, `explainUnsatisfiability`) queries the explanation graph via `store.getQuads()` with quoted triple patterns. Must produce identical index entries.
- **Error propagation:** `assertN3Internals` throws synchronously if N3 internals changed — clear failure mode, not silent corruption.
- **State lifecycle risks:** `clearGraph` deletes graph entry before injection. If injection fails mid-way, the store has partial data. Same risk as current `removeQuads` + addQuad loop — acceptable.
- **API surface parity:** Non-Store paths (`reason(quads)`, `materialize(quads)`, etc.) are unchanged — they still return Quad[] via `decodeBuffers()`.
- **Unchanged invariants:** `decodeBuffers()` function signature and behavior unchanged. `serializeExplanations()` module unchanged (just no longer called from index.ts). `encodeToBuffers()` unchanged. Binary buffer format unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| N3 internal API changes in future version | Pin n3 version range. `assertN3Internals` guard. Single-file isolation (`ts/n3Inject.ts`). |
| Subtle format mismatch in toN3EntityKey | Comparison tests verify identical getQuads results against current addQuad path. |
| `_lookupJustificationFromStore` breaks with quoted triple format change | Explicit test for the exact query pattern used by explain methods. |
| Performance regression on very small ontologies (function call overhead) | Unlikely — PoC shows speedup even at 1000 quads. Monitor via explanation-perf.test.ts. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-22-014-n3-direct-index-injection-requirements.md](docs/brainstorms/2026-07-22-014-n3-direct-index-injection-requirements.md)
- **Predecessor:** [docs/plans/2026-07-22-056-feat-streaming-justification-buffer-plan.md](docs/plans/2026-07-22-056-feat-streaming-justification-buffer-plan.md) — binary buffer format this plan consumes
- **PoC test:** `tests/unit/n3-direct-injection.test.ts`
- **N3 Store internals:** `node_modules/n3/src/N3Store.js` (N3EntityIndex, addQuad, _graphs structure)
- **Learnings:** `docs/solutions/architecture-patterns/ts-to-cpp-workaround-migration-pattern.md` — type-tag encoding, InternTable format
