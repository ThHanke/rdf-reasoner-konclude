---
title: "feat: Direct N3 Store index reading for input encode + fingerprint path"
type: feat
status: draft
date: 2026-07-22
---

# Direct N3 Store Index Reading for Input Path

## Problem

Every Store-based reasoning call does `store.getQuads(null, null, null, null)` which allocates a full `Quad[]` array from N3's internal indices. This array is then:

1. **`encodeToBuffers(quads)`** — iterates Quad[], calls `encodeTerm` per term (string extraction + type detection + InternTable lookup), builds string table + uint32 triple buffer
2. **`computeStoreFingerprint(quads)`** — iterates Quad[], serializes each to NTriples string, sorts, hashes

Both paths immediately decompose the Quad objects back into strings — the Quad allocation is pure waste. For large stores (10k+ quads), this creates significant GC pressure.

## Goal

Read N3 Store's internal `_graphs` / `_entityIndex._entities` directly to:
- Build the binary buffer (string table + uint32 triples) without Quad allocation
- Compute the store fingerprint without Quad allocation

## Approach

### `encodeStoreToBuffers(store, excludeGraphs?)`

Iterate `store._graphs` → for each graph (skipping excluded graphs like inferred/hypothetical/explanation), walk `subjects[s][p][o]` index. Convert N3 entity keys back to intern.ts format (reverse of `toN3EntityKey`), build InternTable entries and uint32 triple array. No Quad objects allocated.

Key conversion: `fromN3EntityKey(entityStr)` → `{ raw: string, type: 0|1|2 }`:
- Starts with `_:` → BlankNode (type 1), raw = after `_:`
- Starts with `"` → Literal (type 2), parse `"value"@lang` / `"value"^^dt` / `"value"` → `value\0dt\0lang`
- Otherwise → NamedNode (type 0), raw = as-is

### `computeStoreFingerprintDirect(store, excludeGraphs?)`

Same graph iteration but builds NTriples strings directly from N3 entity keys (no Quad allocation). The NTriples format is close to N3's internal format — just needs `<>` wrapping for IRIs.

### Call sites

Replace `encodeToBuffers(store.getQuads(null, null, null, null))` with `encodeStoreToBuffers(store)` at ~10 call sites in `ts/index.ts`.

Replace `computeStoreFingerprint(store.getQuads(null, null, null, null))` with `computeStoreFingerprintDirect(store)` at ~5 call sites.

Keep `encodeToBuffers(quads)` and `computeStoreFingerprint(quads)` unchanged — non-Store paths still need them.

## Scope

- **In scope**: Store → binary buffer, Store → fingerprint hash (both zero-alloc)
- **Out of scope**: Non-Store `encodeToBuffers(Quad[])` paths (reason/materialize with raw Quad[] input)
- **Out of scope**: Output path (already optimized in prior work)

## Success Criteria

- Round-trip: `encodeStoreToBuffers` produces identical binary buffers to `encodeToBuffers(store.getQuads(...))`
- Fingerprint: `computeStoreFingerprintDirect` produces identical hash to `computeStoreFingerprint(store.getQuads(...))`
- All existing integration tests pass
- Measurable reduction in allocation (fewer Quad objects created)

## Relevant Code

- `ts/intern.ts` — `encodeToBuffers()`, `InternTable`, `computeStoreFingerprint()`
- `ts/n3Inject.ts` — `assertN3Internals()`, `toN3EntityKey()` (reverse direction needed)
- `ts/index.ts` — ~10 `encodeToBuffers` call sites, ~5 `computeStoreFingerprint` call sites
- `node_modules/n3/src/N3Store.js` — `_graphs`, `_entityIndex._entities`
