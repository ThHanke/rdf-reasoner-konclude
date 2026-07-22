---
title: "feat: Direct N3 Store index injection for explanation write path"
type: feat
status: draft
date: 2026-07-22
---

# Direct N3 Store Index Injection

## Problem

The explanation write path currently:
1. C++ builds binary buffer (string table + uint32 triples + justification data)
2. JS `decodeBuffers()` → creates `Quad[]` + `JustificationData` objects
3. JS `serializeExplanations()` → creates RDF-star Quad objects via `DataFactory.quad()`
4. N3 `store.addQuad()` → `termToId()` → numeric ID → 3× nested object index insert

Each quad goes through: buffer decode → string parse → Quad object allocation → DataFactory.namedNode/blankNode/literal → N3 termToId string construction → _ids lookup → _entities insert → 3× _addToIndex.

This round-trip allocates intermediate Quad objects that are immediately decomposed back into strings/IDs by N3 Store. The overhead scales linearly with quad count.

## Goal

Eliminate Quad object allocation and N3's termToId overhead for the explanation output path by writing directly to N3 Store's internal index structures. C++ emits term strings already in N3's internal `termToId` format so JS does zero conversion.

## Approach: C++ Emits N3 Format + JS Bulk Inject

### Phase 1: C++ String Table in N3 Format

Change C++ `InternTable` to emit strings in N3's `termToId` format instead of raw values with type-tag bits:

| Term type  | Current format                      | N3 format                                     |
|------------|-------------------------------------|-----------------------------------------------|
| NamedNode  | `"http://ex.org/Foo"` + tag=0       | `"http://ex.org/Foo"` (same — no change)      |
| BlankNode  | `"b0"` + tag=1                      | `"_:b0"` (prefix `_:`)                        |
| Literal    | `"val\0dt\0lang"` + tag=2           | `'"val"@lang'` or `'"val"^^dt'` or `'"val"'`  |

Type tags (top 2 bits of uint32) become unnecessary — N3 format strings are self-describing. The string table entries ARE the `_ids` keys directly.

### Phase 2: JS Bulk Index Population

Replace `decodeBuffers()` → Quad[] → `serializeExplanations()` → addQuad() with:

1. Parse string table from buffer → strings are already N3 entity keys
2. Bulk-register all strings into `store._entityIndex._ids` / `._entities` (one pass)
3. For each triple tuple `(s,p,o)`: read uint32 indices → look up pre-registered numeric IDs → insert into `_graphs[g].subjects[s][p][o]` + `.predicates` + `.objects`
4. For RDF-star quoted triples: compute `.${sId}.${pId}.${oId}` entity string, register it, use as object ID
5. Set `store._size = null`

### What This Eliminates

- Zero `DataFactory.quad()` / `DataFactory.namedNode()` / `DataFactory.literal()` calls
- Zero `Quad` object allocation
- Zero `termToId()` calls — C++ already produced the format
- Zero `_termToNewNumericId()` overhead
- Zero intermediate `JustificationData` / `JustificationEntry` object allocation
- String table decode is one `TextDecoder.decode()` pass (already the case)

### Measured Speedup (PoC)

`tests/unit/n3-direct-injection.test.ts` — 1000 quads:
- `addQuad()`: 29.49 ms
- Direct inject (simple triples): 11.24 ms (**2.6× faster**)
- Direct inject (RDF-star quoted triples): 5.92 ms (**5.0× faster**)

RDF-star benefits most because `_termToNewNumericId` does recursive Quad decomposition. Explanation quads are predominantly RDF-star → expect ~5× speedup on the write path.

With N3-format strings from C++ (no JS conversion step), expect additional speedup from eliminating `toN3EntityKey()`.

### Risk: N3 Internal API Coupling

Accesses `_ids`, `_entities`, `_graphs`, `_size`, `_entityIndex._id` directly. Private internals of `n3` package.

Mitigation: pin N3 version. Internals stable since v1.x. Add version check assertion. Wrap in a single `injectExplanationsFromBuffer()` function — if N3 changes, only one function to update.

## Scope

- **In scope**: C++ string table format change + JS bulk inject for explanation write path
- **Out of scope**: Input read path (N3 Store → encodeToBuffers). Follow-up.
- **Out of scope**: Inferred triple insertion path (low quad count, not a bottleneck)
- **Out of scope**: Existing `decodeBuffers()` for non-explanation path (stays as-is)

## Success Criteria

- Round-trip test: inject explanation quads via bulk inject, verify `store.getQuads()` returns identical results to addQuad path
- RDF-star quoted triples query correctly (`_lookupJustificationFromStore` works unchanged)
- All existing explanation + persistence tests pass
- Measurable speedup on explanation write path

## Implementation Sequence

1. Add N3-format string emission mode to C++ `InternTable` (or a parallel `InternTableN3`)
2. Wire into `buildInferredTripleBuffer` justification section
3. New JS function `injectExplanationsFromBuffer(store, buffer)` — parses justification section, bulk-populates N3 internals
4. Replace `serializeExplanations()` call in `_materializeOnStore` / `_reasonOnStore` / `_classifyPropertiesOnStore`
5. Verify with existing test suite + timing benchmark
