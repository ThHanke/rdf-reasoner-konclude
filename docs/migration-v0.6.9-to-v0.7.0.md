# Migration Guide: rdf-reasoner-konclude v0.6.9 → v0.7.0

## TL;DR

**No breaking changes.** v0.7.0 is fully backward-compatible with v0.6.9.
All existing API signatures, return types, and behaviors are preserved.
You can `npm update` and your code will work as-is.

The value of upgrading is correctness fixes and new opt-in APIs.

---

## What Changed

### 1. Correctness: 3 upstream Konclude bugs fixed in WASM kernel

v0.6.9 silently returned `consistent = true` for three OWL 2 DL patterns
that are actually inconsistent. v0.7.0 fixes this:

| Pattern | What was wrong | Impact |
|---------|---------------|--------|
| `AsymmetricProperty` self-loop | `checkConsistency()` returned `true` | Now correctly returns `false` |
| `IrreflexiveProperty` reflexive triple | `checkConsistency()` returned `true` | Now correctly returns `false` |
| `AllDisjointProperties` + `EquivalentProperties` | `checkConsistency()` returned `true` | Now correctly returns `false` |

**Action required:** If your app stored cached consistency results from v0.6.9,
those caches may contain stale `true` values for ontologies that are actually
inconsistent. Clear any persisted consistency caches after upgrading.

If you don't use `AsymmetricProperty`, `IrreflexiveProperty`, or
`AllDisjointProperties` in your ontologies, this doesn't affect you.

### 2. Correctness: ALIF+ hang eliminated (FP/IFP single-filler)

v0.6.x could hang indefinitely on ontologies with `FunctionalProperty` or
`InverseFunctionalProperty` that have exactly one filler. v0.7.0 fixes this
at the WASM kernel level (patches 020–021).

**Action required:** If you had timeouts or workarounds for FP/IFP hangs,
you can remove them.

### 3. Correctness: Inferred triple deduplication

v0.7.0 automatically skips inferred triples that already exist in source
graphs. Previously, `materialize()` could write duplicates into the inferred
graph.

**Action required:** If you had dedup logic in your application layer
(e.g. filtering inferred quads against source quads before display), it is
now redundant — though keeping it is harmless.

### 4. Behavioral: Mode-switching now works

In v0.6.x, calling `classify()` then `materialize()` then
`checkConsistency()` on the **same** `RdfReasoner` instance could produce
wrong results or errors. v0.7.0 fixes this — you can now freely switch
between operations without creating a new instance.

**Action required:** If you were creating a new `RdfReasoner` per operation
type as a workaround, you can now reuse a single instance.

---

## New APIs (all opt-in)

### `Symbol.dispose` + `FinalizationRegistry`

`RdfReasoner` now implements `Symbol.dispose`, enabling the TS 5.2+
`using` keyword for automatic Worker cleanup:

```ts
// Before (still works, not deprecated):
const reasoner = new RdfReasoner();
try {
  await reasoner.classify(store);
} finally {
  reasoner.terminate();
}

// After (opt-in, requires TS 5.2+ / ES2022+):
{
  using reasoner = new RdfReasoner();
  await reasoner.classify(store);
} // Worker terminated automatically
```

A `FinalizationRegistry` backstop also terminates the Worker on GC if
`terminate()` was never called. This is a safety net, not a replacement
for explicit cleanup.

**Action required:** None. `terminate()` still works. Adopt `using` at
your own pace.

### `createManagedStore(store)`

New export that wraps an N3 Store with write guards on the three
reasoner-owned graphs (`urn:konclude:inferred`, `urn:konclude:explanations`,
`urn:konclude:hypothetical`). Accidental writes throw `RangeError`.

```ts
import { createManagedStore, RdfReasoner } from 'rdf-reasoner-konclude';

const store = createManagedStore(new Store());
const reasoner = new RdfReasoner();
await reasoner.classify(store);  // writes inferred graph internally ✓
store.addQuad(s, p, o, namedNode('urn:konclude:inferred'));  // throws RangeError ✗
```

**Action required:** None — purely opt-in. Recommended for apps that
allow user-driven store mutations alongside reasoning (prevents
corrupting the inferred graph).

---

## Ontosphere-specific migration notes

Ontosphere's `DlReasoner` wrapper in `rdfManager.runtime.ts` is already
compatible — it uses the Store-based API (`materialize(store, {...})`,
`checkConsistency(store)`, etc.) which is unchanged.

Key observations for the ontosphere integration:

1. **Custom inferred graph** (`urn:vg:inferred`) — still works via
   `inferredGraph` option, unchanged.

2. **`reason(kStore)` call** (line 3206) — calls `DlReasoner.reason()`
   which maps to `materialize(store, { returnDelta: true, ... })`. No
   change needed.

3. **`checkConsistency`** — now correctly detects 3 additional
   inconsistency patterns. If users had ontologies with
   AsymmetricProperty/IrreflexiveProperty/AllDisjointProperties that were
   previously reported consistent, they will now correctly see inconsistency
   errors. This is **correct behavior**, not a regression.

4. **Dedup** — ontosphere had its own `reasoning_inferred_dedup` logic.
   This is now redundant (the reasoner deduplicates internally), but
   keeping it is harmless.

5. **`createManagedStore`** — consider wrapping the kStore with
   `createManagedStore()` to prevent accidental writes to
   `urn:vg:inferred` from non-reasoning code paths. Since ontosphere
   uses a custom graph IRI, this would only guard the default
   `urn:konclude:inferred` — not `urn:vg:inferred`. A future version
   may allow configuring managed graph IRIs.

---

## Upgrade checklist

- [ ] `npm install rdf-reasoner-konclude@^0.7.0`
- [ ] Clear any persisted consistency caches
- [ ] Remove FP/IFP hang timeouts/workarounds if present
- [ ] (Optional) Remove application-layer inferred triple dedup
- [ ] (Optional) Remove per-operation `RdfReasoner` instance workarounds
- [ ] (Optional) Adopt `using` keyword for Worker cleanup
- [ ] (Optional) Wrap stores with `createManagedStore()`
- [ ] Run your test suite — no API changes, but consistency results may
      differ for edge-case ontologies (correctly)
