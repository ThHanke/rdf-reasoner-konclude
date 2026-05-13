---
id: 2026-05-13-003
title: Binary protocol follow-up — node cache, duplicate-check removal, output binary path
status: active
created: 2026-05-13
---

# Binary protocol follow-up

Continue the binary triple protocol optimization in rdf-reasoner-konclude.

## Context

We shipped `loadTripleBuffer` (branch `feat/binary-triple-protocol`) — a zero-copy binary wire
format replacing the NTriples round-trip between JS and WASM. All 104 tests pass.
Benchmark baseline (post-merge `main`):

| Ontology | loadTripleBuffer C++ | TS total |
|---|---|---|
| LUBM schema (307 q) | 4 ms | 307 ms |
| GALEN (30 817 q) | 296 ms | 1 042 ms |
| Roberts family (3 866 q) | 34 ms | 2 563 ms |
| LUBM schema + data (100 850 q) | 780 ms | 2 008 ms |

Old TS total (NTriples path, pre-binary-protocol):

| Ontology | TS total (old) |
|---|---|
| LUBM schema | 266 ms |
| GALEN | 941 ms |
| Roberts family | 2 603 ms |
| LUBM schema + data | 2 104 ms |

## Implementation Units

### Unit 1 — C++ node cache in `loadTripleBuffer`

**Goal:** Eliminate redundant `librdf_node` allocations for repeated terms.

**Files:**
- Modify: `src/KoncludeReasoner.cpp`

**Approach:**

Currently `makeNode` calls `librdf_new_node_from_uri_string` / `librdf_new_node_from_blank_identifier`
/ `librdf_new_literal_*` for every term occurrence, even when the same string-table index repeats
across thousands of triples. For LUBM+data (300k term slots, ~20k unique terms) this is ~280k
redundant URI-parse+alloc cycles.

Add `std::vector<librdf_node*> nodeCache(count, nullptr)` indexed by string-table index
(lower 30 bits of the uint32 id):
- First use of index `idx`: create node, store in `nodeCache[idx]`.
- Repeat use: call `librdf_new_node_from_node(nodeCache[idx])` — ref-count copy, no string parse.
- After the triple loop: free all non-null cache entries with `librdf_free_node`.

The `makeNode` lambda already has access to `idx` — thread the cache through it.

**Verification:** `ts-runner.mjs` shows `loadTripleBuffer` C++ time drops by ≥40% for
LUBM+data; all 104 tests pass after `make build-wasm`.

---

### Unit 2 — Remove duplicate-check in the hot loop

**Goal:** Eliminate N hash-table lookups for N input triples.

**Files:**
- Modify: `src/KoncludeReasoner.cpp`

**Approach:**

Remove the block:

```cpp
if (librdf_model_contains_statement(model, stmt)) {
    librdf_free_statement(stmt);
    continue;
}
```

Input always comes from `n3.Store` which already deduplicates. librdf's hash-backed model
handles re-insertion safely (it is idempotent). This eliminates N hash lookups for N triples
with no correctness risk.

**Verification:** All 104 tests pass; `loadTripleBuffer` timing improves slightly.

---

### Unit 3 — Output binary protocol (`getInferredTripleBuffer`)

**Goal:** Eliminate the remaining NTriples serialization/parse round-trip on the output path.
Currently `getInferredNTriples()` returns a NTriples string; JS parses it with `n3.Parser`.
For GALEN (3 287 inferred triples) this adds ~150 ms.

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — implement `getInferredTripleBuffer`
- Modify: `src/KoncludeReasoner.h` — add declaration
- Modify: `src/bindings.cpp` — register method
- Modify: `ts/konclude.d.mts` — add `getInferredTripleBuffer(): string`
- Modify: `ts/intern.ts` — add `decodeBuffers(tripleBuffer, strTableBuffer): Quad[]`
- Modify: `ts/worker.ts` — add `getInferredTripleBuffer` dispatch case
- Modify: `ts/index.ts` — replace `getInferredNTriples` + `parseNTriples` in all 3 call sites
- Modify: `tests/unit/intern.test.ts` — add `decodeBuffers` tests
- Modify: `tests/unit/worker.test.ts`, `RdfReasoner.test.ts`, `RdfReasoner.store.test.ts` — update mocks

**Wire format (output):**

Pack both buffers into one WASM heap allocation and return via `std::string` byte carrier:

```
[strTableLen:u32][strTableBytes…][tripleBytes…]
```

JS slices at `strTableLen` to recover the two buffers. String-table and triple-buffer layout
are identical to the input wire format (see `KoncludeReasoner.h` wire-format comment and
`ts/intern.ts`).

**C++ approach:**

Walk `librdf_model` via `librdf_model_as_stream` → `librdf_stream_next`. For each statement:
- Intern subject/predicate/object into an `InternTable`-equivalent (C++ `std::unordered_map<std::string, uint32_t>`)
- Accumulate `[s, p, o]` uint32 tuples

Then serialize: write the header `[strTableLen:u32]`, the string table, and the triple tuples.
Allocate via `malloc`, return pointer+length to JS.

**JS decode — `decodeBuffers(tripleBuffer, strTableBuffer): Quad[]`:**

Reverse of `encodeToBuffers`. Read string-table entries using `DataView`; for each triple tuple
read type bits (top 2 bits) and index (bottom 30 bits); construct `DataFactory.namedNode` /
`DataFactory.blankNode` / `DataFactory.literal` accordingly. Literal entries are
`value\0datatype\0language` — split on `\0`.

**Worker pattern (SAB → plain AB):**

```ts
const ptr = mod._malloc(byteLen);
// ... call getInferredTripleBuffer which writes to ptr ...
const plain = new Uint8Array(mod.HEAPU8.buffer, ptr, byteLen).slice(); // SAB → AB
mod._free(ptr);
self.postMessage({ id, result: plain.buffer }, [plain.buffer]);
```

**Patterns to follow:**
- `ts/intern.ts` `InternTable` / `encodeToBuffers` — mirror for decode
- `src/compat/overrides/CRDFRedlandRaptorParser.cpp` — model walk via `librdf_model_as_stream`
- Worker SAB→plain AB: existing `loadTripleBuffer` case in `ts/worker.ts`

**Verification:**
- New `intern.test.ts` tests: `decodeBuffers` happy path + round-trip
  (`encodeToBuffers(quads)` → `decodeBuffers(...)` returns same subject/predicate/object values)
- All 104 tests pass after `make build-wasm`
- `ts-runner.mjs` shows TS total improvement for GALEN (≥100 ms)

---

## Key files summary

| File | Units |
|---|---|
| `src/KoncludeReasoner.cpp` | 1, 2, 3 |
| `src/KoncludeReasoner.h` | 3 |
| `src/bindings.cpp` | 3 |
| `ts/konclude.d.mts` | 3 |
| `ts/intern.ts` | 3 |
| `ts/worker.ts` | 3 |
| `ts/index.ts` | 3 |
| `tests/unit/intern.test.ts` | 3 |
| `tests/unit/worker.test.ts` | 3 |
| `tests/unit/RdfReasoner.test.ts` | 3 |
| `tests/unit/RdfReasoner.store.test.ts` | 3 |

## Success criteria

- All 104 existing tests pass
- `npm run build` clean
- `make build-wasm` succeeds
- `ts-runner.mjs` shows improvement vs baseline table above
- `decodeBuffers` round-trip test passes
