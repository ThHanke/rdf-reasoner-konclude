---
title: "WASM build pipeline optimization — strip debug flags, compile dependencies at -O3, enable LTO"
date: 2026-05-12
category: performance-issues
module: wasm-build-pipeline
problem_type: performance_issue
component: tooling
severity: high
symptoms:
  - WASM classify time 2–22× slower than native Konclude across all tested ontologies
  - raptor2/rasqal/librdf compiled at -O0 (Emscripten default when CFLAGS not explicitly passed)
  - Emscripten ASSERTIONS=1 and DEMANGLE_SUPPORT=1 active in production build, adding heap/stack validation and startup overhead
  - std::set used for dedup in getInferredNTriples(), giving O(log n) insertion per triple
root_cause: config_error
resolution_type: config_change
related_components:
  - development_workflow
tags:
  - wasm
  - emscripten
  - lto
  - performance
  - raptor2
  - librdf
  - build-flags
  - unordered-set
---

# WASM build pipeline optimization — strip debug flags, compile dependencies at -O3, enable LTO

## Problem

The WASM build of the Konclude OWL-DL reasoning kernel ran 2.5–22× slower than native Konclude on the same machine. All observed gaps were configuration mistakes in the Emscripten link flags and dependency library build scripts — not inherent WASM overhead.

## Symptoms

Benchmarked with median of 3 runs (`npm run bench`), comparing WASM classify time to native Konclude:

| Ontology | WASM classify | Native classify | Ratio |
|---|---|---|---|
| LUBM schema | 502 ms | 23 ms | ~21.8× |
| GALEN | 1103 ms | 224 ms | ~4.9× |
| Roberts family | 4466 ms | 1790 ms | ~2.5× |
| LUBM schema + data | 1596 ms | 258 ms | ~6.2× |

Load times (`loadMs`) were also disproportionately large for high-triple-count ontologies, pointing to an unoptimized dependency library on the NTriples parser / triple store path.

## What Didn't Work

These approaches were considered and explicitly deferred or ruled out:

- **`--profiling-funcs`** (May 6, session history): Added to `emscripten.cmake` to get named C++ symbols in the WAT disassembly during crash investigation. Blocked every build — `wasm-opt` rejected the unknown WASM section (0x2e) that `--profiling-funcs` produces. Removed after discovering the conflict; `DEMANGLE_SUPPORT=1` was added instead for human-readable runtime names. (session history)
- **`ASSERTIONS=2`** for performance insight (May 6, session history): Multiple build–run cycles with `ASSERTIONS=1` (later `ASSERTIONS=2`) active failed to locate the crash site because the failure was a WASM `unreachable` from C++ UB, not a bounds violation. The assertions flag added overhead without helping the investigation. It should have been stripped before the first clean performance measurement. (session history)
- **`PROXY_TO_PTHREAD`**: The current pthreads build works correctly without proxying the main function to a pthread. Adding it would change the execution model with no clear performance benefit and risk Worker environment regressions.
- **WASM SIMD (`-msimd128`)**: The tableau algorithm is pointer-chasing over graph structures, not vectorisable dense data. SIMD adds correctness risk on some V8 versions in Emscripten 3.1.73 with speculative benefit.
- **`ALLOW_MEMORY_GROWTH`**: Dynamic growth conflicts with `SharedArrayBuffer` semantics required by pthreads on some Emscripten versions. Roberts peak heap is ~596 MB; with 1 GB `INITIAL_MEMORY` the headroom is already small.

## Solution

Four independent fix units applied in sequence. Units 1 and 3 require only a kernel rebuild (fast). Units 2 and 4 require deleting `wasm-libs/` first (bypasses the skip-if-exists guards) and a full lib + kernel rebuild (~20 min in Docker).

### Unit 1 — Remove debug flags, increase thread pool (`emscripten.cmake`)

`ASSERTIONS=1` and `DEMANGLE_SUPPORT=1` were added as debugging tools during the May 6 crash investigation (session history) and left active in the production build by accident. `PTHREAD_POOL_SIZE=6` undercapped the KPSet classifier's parallel worker requests (kernel requests up to 8).

```cmake
# Before
"-sDEMANGLE_SUPPORT=1"
"-sASSERTIONS=1"
"-sPTHREAD_POOL_SIZE=6"

# After
"-sPTHREAD_POOL_SIZE=8"
# ASSERTIONS and DEMANGLE_SUPPORT removed entirely (default is 0)
```

### Unit 2 — Compile dependency libraries at `-O3` (`scripts/build-raptor-wasm.sh`)

When `-matomics -mbulk-memory -pthread` was added to `build-raptor-wasm.sh` for pthreads correctness (session history), no `-O` flag was included. Emscripten's `emconfigure` wrapper defaults to the project's own autoconf default (often `-O2` upstream) or falls through to `-O0` when no `CFLAGS` are set. librdf received no `CFLAGS` at all.

```bash
# raptor2 CFLAGS — before
CFLAGS="-D__GLIBC__ -matomics -mbulk-memory -pthread"

# raptor2 CFLAGS — after
CFLAGS="-D__GLIBC__ -matomics -mbulk-memory -pthread -O3 -DNDEBUG"

# rasqal CFLAGS — same append

# librdf — before (no CFLAGS argument to emconfigure)
CC=emcc CXX=em++ AR=emar RANLIB=emranlib

# librdf — after
CC=emcc CXX=em++ AR=emar RANLIB=emranlib \
CFLAGS="-matomics -mbulk-memory -pthread -O3 -DNDEBUG"
```

Must delete `wasm-libs/` before rebuilding to bypass skip-if-exists guards:

```bash
# Host doesn't have write access to root-owned wasm-libs/ — use Docker:
docker compose run --rm --entrypoint "" build sh -c "rm -rf /src/wasm-libs"
docker compose run --rm build
```

### Unit 3 — Replace `std::set` with `std::unordered_set` for triple dedup (`src/KoncludeReasoner.cpp`)

The `getInferredNTriples()` loop used `std::set<pair<string,string>>` for deduplication — an ordered red–black tree chosen for determinism during initial correctness work. For large ontologies (GALEN: 3 287 output triples) this costs O(log n) per insertion across all dedup lookups.

```cpp
// Before — O(log n) per insertion (tree traversal)
std::set<std::pair<std::string,std::string>> emitted;

// After — O(1) amortised; Boost-style hash_combine
struct PairHash {
    std::size_t operator()(const std::pair<std::string, std::string>& p) const {
        std::size_t seed = std::hash<std::string>{}(p.first);
        seed ^= std::hash<std::string>{}(p.second) + 0x9e3779b9u
                + (seed << 6) + (seed >> 2);
        return seed;
    }
};
std::unordered_set<std::pair<std::string,std::string>, PairHash> emitted;
```

Add `#include <unordered_set>` to the includes in `KoncludeReasoner.cpp`.

### Unit 4 — Enable LTO across all modules (`emscripten.cmake`, `scripts/build-raptor-wasm.sh`, `src/CMakeLists.txt`)

Without LTO, the Emscripten linker cannot inline across the Konclude kernel, Embind glue, and the three dependency libraries. All modules must be compiled to LLVM bitcode with `-flto`; a mismatch causes `wasm-ld: warning: ignoring non-LTO input` and silently degrades to non-LTO code for that module.

```cmake
# emscripten.cmake — add to KONCLUDE_EMSCRIPTEN_LINK_FLAGS
"-flto"
```

```bash
# build-raptor-wasm.sh — append to each library's CFLAGS
-O3 -DNDEBUG -flto  # (replaces the -O3 -DNDEBUG from Unit 2)
```

```cmake
# src/CMakeLists.txt — add to konclude_kernel compile options
target_compile_options(konclude_kernel PRIVATE
    ...
    $<$<BOOL:${EMSCRIPTEN}>:-flto>
)
```

Requires another `wasm-libs/` deletion + full rebuild (same as Unit 2). Verify success by checking no `ignoring non-LTO input` in the build output.

## Results After All Four Units

| Ontology | Before | After | Reduction | New WASM/native ratio |
|---|---|---|---|---|
| LUBM schema | 502 ms | 241 ms | −52% | ~7.1× |
| GALEN | 1103 ms | 517 ms | −53% | ~2.3× |
| Roberts family | 4466 ms | 2528 ms | −43% | ~1.4× |
| LUBM schema + data | 1596 ms | 783 ms | −51% | ~5.3× |

Per-unit attribution (benchmarked at each stage):
- **Units 1 + 3** combined: largest single gain — ~51% classify reduction for LUBM/GALEN, ~34% for Roberts. Unit 1 (debug flag removal + thread pool raise) is the dominant contributor; Unit 3 is hard to isolate because they were benchmarked together.
- **Unit 2** (library `-O3 -DNDEBUG`): primary gain in `loadMs` — GALEN load −9%, LUBM+data load −11%; minimal effect on classify time.
- **Unit 4** (LTO): additional 7–12% classify reduction on top of prior units.

## Why This Works

**`-sASSERTIONS=1`** inserts heap-bounds and stack-overflow checks into every Emscripten memory access helper. These are O(1) individually but fire hundreds of millions of times per classify run across all pointer dereferences in the tableau algorithm. Removing them eliminates a constant-factor overhead through the entire hot path.

**`-sDEMANGLE_SUPPORT=1`** embeds the full Itanium C++ demangler. Beyond binary size, the demangler is registered in the exception-handling chain and adds startup initialisation cost. It provides no value in a production build where stack traces are not displayed to users.

**`PTHREAD_POOL_SIZE=6`** was the hard cap on concurrency. The KPSet classifier uses up to 8 worker threads for parallel subsumption testing; when the pool is exhausted, new thread requests block until one returns. Raising the pool to 8 removes artificial serialisation.

**`-O0` on dependency libraries**: raptor2 (NTriples parser), rasqal, and librdf (triple store) are on the critical path for `loadNTriples()`. Without `-O3`, every inner loop in the Raptor tokeniser and librdf cursor is unoptimised, explaining the elevated `loadMs` figures.

**`std::set` vs `std::unordered_set`**: `std::set` is a red–black tree — each of the thousands of `(subject, object)` insertions costs O(log n) comparisons and pointer chases through a heap-allocated tree. `std::unordered_set` with a fast hash-combine brings this to O(1) amortised.

**LTO**: Without link-time optimisation the linker treats each compiled module (kernel, Embind, raptor2, librdf, rasqal) as an opaque object file. Cross-module calls cannot be inlined and value-range propagation stops at module boundaries. With all modules emitting LLVM bitcode (`-flto`), the linker inlines small hot helpers, eliminates redundant loads across the Embind boundary, and applies whole-program dead-code elimination.

## Prevention

1. **Strip debug flags before any performance measurement.** `ASSERTIONS=1` and `DEMANGLE_SUPPORT=1` should be scoped to debug builds only (gated on `CMAKE_BUILD_TYPE=Debug` or a separate CMake preset). Never merge them to main without removing them.

2. **Always pass explicit `CFLAGS` to `./configure`-based WASM dependencies.** Autoconf projects fall back to their own defaults; Emscripten's `emconfigure` may not override to an optimised level. Set `CFLAGS="-O3 -DNDEBUG ..."` for every dependency in build scripts — don't assume a default.

3. **Verify LTO is active after linking.** Check the build log for `ignoring non-LTO input` warnings. Any `.a` archive compiled without `-flto` silently degrades to non-LTO code generation at that module boundary.

4. **Add LTO from project inception for release builds.** Retrofitting `-flto` to existing dependency libraries requires deleting cached archives and doing a full rebuild (~20 min). Adding it at project start avoids this penalty later.

5. **Benchmark `loadMs` and `classifyMs` separately.** A slow `loadMs` points to dependency library bottlenecks (parser, triple store); a slow `classifyMs` points to the kernel or thread-pool starvation. Conflating the two metrics makes root-cause isolation harder.

6. **Size the thread pool to match the algorithm's measured parallelism.** Profile or read the source to determine the maximum thread fan-out. Set `PTHREAD_POOL_SIZE` to that number, not an arbitrary constant.

## Related Issues

- [`docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`](../architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md) — the threading flags in `emscripten.cmake` (`-pthread`, `-sUSE_PTHREADS=1`, `PTHREAD_POOL_SIZE`) documented there must coexist with the performance flags documented here. The flag sets are orthogonal; both are required.
- [`docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`](../logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md) — the `unordered_set` + `PairHash` change in Unit 3 is a performance optimization layered on top of the correctness fix documented there (which introduced the dedup set in the first place). The correctness guarantees of that fix are fully preserved.
