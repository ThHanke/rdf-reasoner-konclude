---
title: "perf: WASM hash map and memory allocation optimization"
type: feat
status: active
date: 2026-05-18
---

# perf: WASM hash map and memory allocation optimization

## Overview

Replace `std::unordered_map` (separate chaining) with `robin_hood::unordered_node_map`
(open addressing, pool allocator) as the backing store for the `QHash` shim, and
replace `std::unordered_set` with `robin_hood::unordered_flat_set` for `QSet`. Add
`WASM_BIGINT=1` to the Emscripten link flags.

The two goals are intertwined:
- **Cache locality**: robin_hood open addressing eliminates the linked-list pointer chase on every `find()` / `operator[]` call.
- **Memory allocation**: robin_hood's node_map uses an internal pool allocator — entries are carved from large pre-allocated blocks instead of individual `operator new` per node. For Konclude's reasoning hot paths (thousands of per-concept/per-individual map lookups during tableau saturation), this reduces both allocator pressure and heap fragmentation in WASM's 1 GB flat linear memory.

## Problem Frame

After fixing single-threaded operation (`idealThreadCount()` returning 1) and suppressing
verbose WASM logging, the remaining performance gap between WASM and native Konclude is
driven by two factors:

1. **Pointer-chasing hash lookups**: `std::unordered_map` (separate chaining) requires two
   pointer dereferences per lookup minimum — array slot → node pointer → compare key.
   In WASM's linear memory model, each dereference is an `i32.load` with separate cache
   line pressure.

2. **Per-node heap fragmentation**: Every map insert calls `operator new` for a linked-list
   node, scattering thousands of small allocations across the heap. This defeats WASM
   mimalloc's coalescing and causes cold cache misses on subsequent access.

`robin_hood::unordered_node_map` eliminates both: open-addressing Robin Hood probing with
a built-in pool allocator. It is ABI-compatible with `std::unordered_map` at the type
level and preserves pointer/reference stability (node semantics), making it a safe
drop-in for the QHash shim.

## Requirements Trace

- R1. QHash lookup cost should be reduced through open-addressing (no pointer chase per bucket).
- R2. QHash allocation pattern should use pool allocation (bulk blocks, not per-node malloc).
- R3. QSet should use flat storage (no per-element allocation, no pointer chasing).
- R4. The change must not break correctness — golden-reference and integration tests must pass.
- R5. WASM_BIGINT eliminates 64-bit integer boxing at the JS/WASM boundary.

## Scope Boundaries

- Only `QHash` and `QSet` backing types change — all API surface (iterators, methods, semantics) preserved.
- No changes to `QList`, `QMap`, or other container shims.
- No changes to Konclude kernel source files — only `src/compat/QtCompat.h` and `emscripten.cmake`.
- No attempt to audit individual `QHash` call sites for flat_map eligibility — node_map is the safe universal swap.

### Deferred to Separate Tasks

- `SmallVector<V,1>` as `QHash` bucket type (replaces `vector<V>`, eliminates inner heap allocation for single-value entries): requires broader change and benchmarking to justify.
- WASM SIMD (`-msimd128`): ruled out in prior art — tableau is pointer-chasing, not vectorisable. See `docs/solutions/performance-issues/wasm-build-pipeline-optimization-2026-05-12.md`.
- `PTHREAD_POOL_SIZE_STRICT=8`: risks fatal failure in constrained browser environments. Current `STRICT=2` with `POOL_SIZE=8` is the correct browser-safe setting.

## Context & Research

### Relevant Code and Patterns

- `src/compat/QtCompat.h`: QHash struct (lines ~155–336), QSet struct (lines ~340–390). QHash uses `using Map = std::unordered_map<K, Bucket, QHasherFn<K>>;` — change this one typedef. QSet inherits from `std::unordered_set<T, QHasherFn<T>>` — change this one base class.
- `emscripten.cmake`: current link flags live here; `PTHREAD_POOL_SIZE`, `MALLOC=mimalloc`, `-flto` already present.
- `src/compat/overrides/` — build overrides; robin_hood.h goes in `src/compat/` alongside QtCompat.h.
- `tests/integration/` and `tests/unit/` — 112 tests, all must pass after rebuild.
- `tests/bench/bench.mjs` — benchmark runner; produces comparison table used in README.

### Institutional Learnings

- **QHash iteration order is non-deterministic** — a prior bug (wrong representative IRI) arose from assuming iteration order. The fix (concept tag ordering) is already in place; golden-reference tests will catch any regression introduced by robin_hood's different hash probing order. See `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`.
- **Build flag changes require full kernel rebuild** (not just TS build). `docker compose run --rm build` + `npm run patch-wasm` is mandatory after any C++ or emscripten.cmake change.
- **WASM SIMD ruled out** — pointer-chasing graph traversal is not vectorisable. See `docs/solutions/performance-issues/wasm-build-pipeline-optimization-2026-05-12.md`.
- **mimalloc already enabled** — `MALLOC=mimalloc` is set. robin_hood's internal pool allocator acts at a higher level (pooling nodes before reaching mimalloc), so the two are complementary.

### External References

- robin_hood hashing: `https://github.com/martinus/robin-hood-hashing` (single header `src/include/robin_hood.h`, MIT licence, C++14+).
- `robin_hood::unordered_node_map<K,V>`: open addressing, Robin Hood probing, pool-allocated nodes (pointer/reference stable after mutations), drop-in for `std::unordered_map`.
- `robin_hood::unordered_flat_set<T>`: open addressing, elements stored inline (no per-element allocation), pointer-unstable on rehash (safe for sets of values/pointers-to-other-objects).

## Key Technical Decisions

- **`unordered_node_map` over `unordered_flat_map` for QHash**: QHash exposes iterator-based APIs (`find()` returning an iterator, `erase(iterator)`, `operator[]` returning a reference). Flat maps invalidate references on rehash. Konclude code may store iterators or value references across insertions — node_map preserves stability without requiring audit of all call sites.
- **`unordered_flat_set` for QSet**: QSet stores values (typically pointers-to-other-objects), not pointers into its own storage. Iterators are consumed immediately in range-for loops. Flat storage eliminates per-element allocation entirely. The inheritance-based structure of QSet is compatible with robin_hood flat_set (no virtual dispatch through base, no delete-through-base-pointer).
- **Pin a specific robin_hood commit / tag**: Vendor `robin_hood.h` at a known-good version to avoid CI dependency on GitHub. Latest stable release (v3.11.5, tag `3.11.5`) is appropriate.
- **`WASM_BIGINT=1`**: Removes i64/u64 boxing in the Emscripten JS glue. Low risk, enables future methods returning 64-bit values without wrapping.
- **`processorCount()` already implemented**: The C++ method, Embind wiring, and TypeScript types were added in the current session (pending the WASM rebuild now in progress). This plan's rebuild will include that work at no extra cost.

## Open Questions

### Resolved During Planning

- **Is robin_hood.h compatible with Emscripten/WASM?**: Yes. It uses standard C++14 template metaprogramming, no OS-specific APIs, no SIMD intrinsics. It compiles cleanly with clang-based Emscripten and is used in multiple WASM projects.
- **Does `QHasherFn` work with robin_hood's hasher interface?**: Yes. robin_hood accepts any type satisfying `std::hash`'s `size_t operator()(const K&) const` interface, which `QHasherFn` already satisfies.
- **Will robin_hood's different hash distribution break the iteration-order-non-determinism contract?**: No change in contract — iteration order was already unspecified. The golden-reference tests (plan-016) verify output correctness regardless of internal ordering.

### Deferred to Implementation

- **Exact version tag / commit hash to pin**: Verify the latest stable tag at download time.
- **Compilation warnings under Emscripten with `-Wall`**: robin_hood headers occasionally emit unused-variable warnings in some compiler versions. Suppress with `#pragma GCC diagnostic` wrapper if needed.

## Implementation Units

- [ ] **Unit 1: Vendor `robin_hood.h`**

  **Goal:** Add the robin_hood single-header library to the source tree as a vendored dependency.

  **Requirements:** R1, R2, R3

  **Dependencies:** None

  **Files:**
  - Create: `src/compat/robin_hood.h` (downloaded from the martinus/robin-hood-hashing release)

  **Approach:**
  - Download `robin_hood.h` from the v3.11.5 release (or latest stable tag at the time of implementation). Do not use a symlink or git submodule — a flat vendored file is simpler for the Docker build context.
  - Add a one-line comment at the top noting the source URL and version/commit.
  - No CMakeLists changes needed — `src/compat/` is already on the force-include path via `-include QtCompat.h`; robin_hood.h will be included from QtCompat.h.

  **Test scenarios:**
  Test expectation: none — this unit is vendoring a well-tested external header with no behavioral change yet.

  **Verification:**
  - `src/compat/robin_hood.h` exists and contains the robin_hood namespace.
  - `docker compose run --rm build` completes without errors (confirms the header compiles under Emscripten). Full rebuild deferred to Unit 4.

- [ ] **Unit 2: Swap `QHash` backing map to `robin_hood::unordered_node_map`**

  **Goal:** Replace `std::unordered_map<K, Bucket, QHasherFn<K>>` with `robin_hood::unordered_node_map<K, Bucket, QHasherFn<K>>` in the QHash shim. This eliminates linked-list pointer chasing and switches to pool allocation for hash map nodes.

  **Requirements:** R1, R2, R4

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/compat/QtCompat.h` (QHash struct, `using Map = ...` typedef)

  **Approach:**
  - Add `#include "robin_hood.h"` near the top of QtCompat.h (after the existing std includes).
  - Change `using Map = std::unordered_map<K, Bucket, QHasherFn<K>>;` to `using Map = robin_hood::unordered_node_map<K, Bucket, QHasherFn<K>>;`.
  - The `QHash::iterator` and `QHash::const_iterator` structs use `typename Map::iterator` and `typename Map::const_iterator` — these types exist on robin_hood node_map with the same `it->first` / `it->second` dereference interface. No iterator struct changes needed.
  - The `mData.erase(outerIt)` call in `QHash::erase()` returns an iterator in both `std::unordered_map` and `robin_hood::unordered_node_map` — no change needed.
  - The `mData[k]` operator (get-or-create) exists on robin_hood node_map with identical semantics.

  **Patterns to follow:**
  - Existing QHash typedef: `using Map = std::unordered_map<K, Bucket, QHasherFn<K>>;` — single-line change.

  **Test scenarios:**
  Test expectation: none at this unit level — correctness is validated end-to-end in Unit 4 after rebuild. The robin_hood API is a drop-in; no new logic is introduced.

  **Verification:**
  - `src/compat/QtCompat.h` uses `robin_hood::unordered_node_map` for `QHash::Map`.
  - No other changes to QHash struct.

- [x] **Unit 3: Add `WASM_BIGINT=1`; QSet flat_set reverted** *(QSet change reverted — see note below)*

  **Goal:** Add `WASM_BIGINT=1` to Emscripten link flags. QSet flat_set was attempted but reverted.

  **Implementation note:** `robin_hood::unordered_flat_set` was initially used for QSet, but caused the roberts-family integration test (ABox realization) to return 0 triples. Root cause: flat_set rehashes at ~80% load factor vs std's 100%, invalidating iterators mid-iteration in Konclude's ABox realization code (`mRealizerSet` grows while being iterated). All TBox-only tests passed because those QSets never grow past 80% during an active iteration. QSet reverted to `std::unordered_set`. WASM_BIGINT=1 was retained.

  **Requirements:** R3, R5

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/compat/QtCompat.h` (QSet base class and `using Base = ...` alias)
  - Modify: `emscripten.cmake` (add `-sWASM_BIGINT=1`)

  **Approach:**
  - In QSet: change `struct QSet : public std::unordered_set<T, QHasherFn<T>>` to `struct QSet : public robin_hood::unordered_flat_set<T, QHasherFn<T>>`.
  - Change `using Base = std::unordered_set<T, QHasherFn<T>>;` to `using Base = robin_hood::unordered_flat_set<T, QHasherFn<T>>;`.
  - All existing QSet methods that call `Base::insert`, `Base::erase`, `Base::count`, `Base::size`, `this->cbegin()`, `this->cend()` work identically on robin_hood flat_set — no method body changes.
  - In `emscripten.cmake`: add `"-sWASM_BIGINT=1"` to `KONCLUDE_EMSCRIPTEN_LINK_FLAGS`.
  - `std::remove_reference.h` and related headers: robin_hood.h already pulls in what it needs; no additional includes required.

  **Patterns to follow:**
  - Existing QSet base class line — single change.
  - Other flags in `emscripten.cmake` — follow the same `-sKEY=VALUE` format.

  **Test scenarios:**
  Test expectation: none at this unit level — correctness validated in Unit 4 after rebuild.

  **Verification:**
  - `src/compat/QtCompat.h` QSet base class is `robin_hood::unordered_flat_set`.
  - `emscripten.cmake` contains `-sWASM_BIGINT=1`.

- [ ] **Unit 4: Rebuild WASM, run full test suite, run benchmark, commit**

  **Goal:** Validate all optimizations end-to-end and produce a benchmark comparison proving the improvement.

  **Requirements:** R1–R5

  **Dependencies:** Units 1, 2, 3; current background WASM rebuild (braw2yc4a) must complete and be patched first.

  **Files:**
  - Modify: `README.md` (Performance section — update table with new numbers)
  - Modify: `docs/solutions/performance-issues/` — add or update a solutions doc capturing the robin_hood result.

  **Approach:**
  - Once the background build (parallelism fix) finishes: `npm run patch-wasm`, run `npm test` to confirm 112/112 pass, then run `node tests/bench/bench.mjs` to get baseline numbers.
  - Apply Units 1–3, then run `docker compose run --rm build` + `npm run patch-wasm`.
  - Run `npm test` — all 112 tests must pass. Iteration-order-sensitive output is verified by golden-reference tests from plan-016; any regression will surface here.
  - Run `node tests/bench/bench.mjs` (verbose logging suppressed via `{ print: () => {} }` in wasm-runner.mjs — already fixed).
  - Update README Performance table with results from both the parallelism-fix rebuild and the robin_hood rebuild, showing the progression.
  - Commit with descriptive message referencing the change categories.

  **Test scenarios:**
  - Happy path: `npm test` exits 0 with 112/112 passing — confirms no correctness regression from different robin_hood hash distribution.
  - Integration: GALEN golden-reference test produces correct representative IRIs (Haem not Heme) — confirms iteration-order fix survives backing-map change.
  - Integration: Roberts family realization produces correct individual type assertions — confirms ABox pipeline works end-to-end with robin_hood maps.
  - Benchmark: WASM LUBM schema time is within 3× of native (was 4× before parallelism fix, expected <2× after).
  - Benchmark: WASM GALEN time is within 3× of native (was 4× before parallelism fix).

  **Verification:**
  - `npm test` passes 112/112.
  - Benchmark output shows improved median times vs baseline.
  - README Performance section updated.

## System-Wide Impact

- **Interaction graph:** QHash and QSet are used throughout the Konclude reasoning kernel — class hierarchy, individual sets, role maps, saturation caches. All affected by the backing-map swap.
- **Iteration order**: robin_hood's hash function and probing sequence produce a different iteration order than `std::unordered_map`. Any code that silently relied on a particular iteration order will produce different (not necessarily wrong) output. The golden-reference tests verify correctness of output content, not internal ordering.
- **Pointer/iterator stability**: `unordered_node_map` guarantees pointer and reference stability after insertions (like `std::unordered_map`). No change in stability guarantees.
- **API surface parity**: No TypeScript API changes — only C++ internal implementation.
- **Unchanged invariants**: All existing `QHash` and `QSet` method signatures and semantics are preserved. No call sites change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| robin_hood.h emits compiler warnings under Emscripten | Wrap include with `#pragma GCC diagnostic push/pop` to suppress in QtCompat.h |
| Different robin_hood hash distribution breaks assumption in undetected call site | Golden-reference tests (plan-016) verify all output triples; 112 unit tests provide coverage of all code paths |
| `robin_hood::unordered_flat_set` iterator invalidation breaks a QSet iteration pattern | `flat_set` iterators are consumed immediately in range-for; no iterator is stored across mutations in QSet methods. Rebuild + test suite validates |
| WASM_BIGINT=1 breaks JS caller compatibility | WASM_BIGINT is a pure Emscripten internal optimization; it does not change the published TypeScript API |
| Rebuild OOM/timeout in Docker | Build already confirmed to complete in ~20 min with ccache; this rebuild is incremental (few files changed) |

## Documentation / Operational Notes

- Update `CLAUDE.md` build section note: once robin_hood is vendored, `src/compat/robin_hood.h` should not be edited or regenerated — it is a pinned vendor file.
- If benchmark shows GALEN still >3× native, investigate whether the remaining gap is pthread synchronization overhead (STPU semaphores) — a profiling-guided investigation rather than speculative optimization.

## Sources & References

- Related code: `src/compat/QtCompat.h`, `emscripten.cmake`
- Prior performance work: `docs/solutions/performance-issues/wasm-build-pipeline-optimization-2026-05-12.md`
- QHash iteration-order bug: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- robin_hood: `https://github.com/martinus/robin-hood-hashing`
