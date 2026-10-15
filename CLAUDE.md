# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Port the Konclude OWL-DL tableau reasoning kernel to WebAssembly and publish as the `rdf-reasoner-konclude` npm package. The package exposes an async TypeScript API (`RdfReasoner`) backed by a Web Worker running the WASM reasoning kernel. Input and output use `@rdfjs/types` Quad objects throughout.

## Common Commands

| Target | Command | What it does |
| --- | --- | --- |
| `make build` | `npm run build` | TypeScript compilation only (fast) |
| `make build-wasm` | `docker compose run --rm build` | Full WASM rebuild — ~20–30 min; use ccache for incremental |
| — | `npm run patch-wasm` | **Must run after every `make build-wasm`** — patches `dist/konclude.mjs` for browser compat |
| `make test` | `npm test` | Vitest unit + integration suite |
| `make smoke` | `docker compose run --rm smoke-test` | Quick WASM sanity check |
| `make reason` | `node dist/cli.js $(ARGS)` | Run CLI locally: `make reason ARGS="--input ont.ttl"` |
| `make shell` | `docker compose run --rm shell` | Interactive Emscripten shell for debugging |
| `make patches` | `npm run apply-patches` | Re-apply Qt-removal patches to `vendor/konclude/` |
| `make reset-patches` | `bash scripts/apply-patches.sh --force` | Reset vendor to clean state and re-apply all patches (use after adding/modifying patches) |
| `make fmt` | `trunk fmt` | Format all changed files |
| `make lint` | `trunk check` | Lint all changed files |

**Docker ownership:** `dist/` becomes root-owned after `docker compose run build`. Fix before `npm run build`:

```bash
sudo chown -R $USER dist/
```

**Patch workflow (patch 001):** `scripts/generate-patches.sh` → `make patches` → verify → commit.

**Patch numbering:** the former per-fix patches 000-041 are aggregated into 000-004 (`patches/README.md` maps old to new numbers; originals in `patches/archive/per-fix/`). New vendor patches start at 005.

**Patch workflow (vendor C++ patches 005+):** Use `scripts/new-vendor-patch.py <NNN> <description> <mod_script.py>` — always multi-file capable. Write a mod script that defines `FILES = [...]` and `modify(path, content) -> str`. The framework fetches exact content via `git show HEAD:path`, calls `modify()`, diffs, and writes `patches/NNN-description.patch`. Indentation is handled automatically — content is the exact file text, so `str.replace()` matches without manual tab counting. After adding a new patch: `make reset-patches` before `make build-wasm`.

**Mod script template:**

```python
FILES = [
    "Source/Reasoner/Kernel/Cache/Foo.h",
    "Source/Reasoner/Kernel/Cache/Foo.cpp",
]

def modify(path, content):
    if path.endswith(".h"):
        return content.replace("old_text", "new_text")
    if path.endswith(".cpp"):
        return content.replace("old_text", "new_text")
    return content
```

## Konclude Knowledge Graph (Graphify)

A graphify knowledge graph of `vendor/konclude/Source/Reasoner` (38,462 nodes, 94,143 edges, 889 communities) is available for navigating code paths, call chains, and class hierarchies before writing patches.

**Interactive dashboards** (served at http://docker-dev.iwm.fraunhofer.de:7890):
- `/graph.html` — force-directed community graph; click a community node to see cross-community connections
- `/callflow.html` — Mermaid call-flow diagrams across 16 architectural sections with zoom/pan

**Start the server** (if not running):
```bash
python3 -m http.server 7890 --directory vendor/konclude/Source/Reasoner/graphify-out &
```

**Rebuild the graph** after vendor changes:
```bash
graphify vendor/konclude/Source/Reasoner
graphify export html --graph vendor/konclude/Source/Reasoner/graphify-out/graph.json --node-limit 5000
graphify export callflow-html vendor/konclude/Source/Reasoner --output vendor/konclude/Source/Reasoner/graphify-out/callflow.html
```

**MANDATORY — all C++ work:** Before reading, patching, or analyzing any Konclude C++ file, you MUST use graphify to trace call chains and understand the code topology. This is not optional. Do not write, edit, or propose any C++ patch without first running `graphify path` or `graphify explain` to verify your assumptions about callers, callees, and class relationships. Skipping this step has caused deadlocks and wrong-assumption bugs.

**Graphify over grep:** For any code exploration in `vendor/konclude/` — locating symbols, tracing call chains, finding class relationships — prefer `graphify explain` and `graphify path` over `grep`. Use grep only when graphify cannot answer the question (e.g. literal string search in non-indexed files). Never use grep as the first tool for C++ symbol lookup.

**Before patching any Konclude C++ file:**
1. Run `graphify explain "<ClassName>"` to understand the node and its neighbors.
2. Run `graphify path "<Source>" "<Target>"` to trace the call chain you intend to modify.
3. Only then read the source file and write the patch.

**Before writing any saturation clash patch** (`CCalculationTableauApproximationSaturationTaskHandleAlgorithm`): use graphify to determine if data is precomputed or requires runtime ABox traversal. Rule: role flags (`isAsymmetric()`, `isIrreflexive()`, `getIndirectSuperRoleList()`) are set during the generator/preprocessing layer — safe to read during saturation. Never call `getAssertionRoleLinker()` inside saturation role-assertion processing — this causes deadlocks for all ontologies. Clash checks that only read precomputed role flags go BEFORE the `othIndiNode = getIndividualNodeForIndividual(...)` call (feedback pattern).

**CLI path shortcuts:**
```bash
graphify path "CCalculationTableauApproximationSaturationTaskHandleAlgorithm" "CIndividualSaturationProcessNode" --graph vendor/konclude/Source/Reasoner/graphify-out/graph.json
graphify explain "CReasonerManagerThread" --graph vendor/konclude/Source/Reasoner/graphify-out/graph.json
```

## Running Tests

Always redirect full test output to a file, then tail the file for a summary:

```bash
npx vitest run --reporter=verbose 2>&1 > /tmp/vitest-full-output.txt; tail -30 /tmp/vitest-full-output.txt
```

**Never pipe test runs through `tail` directly** (`npx vitest run | tail -30`) — it discards failure details that appear in the middle of output. Save first, tail second.

To find failures after a run:
```bash
grep "FAIL  tests/" /tmp/vitest-full-output.txt
```

## Linting

Trunk manages all linters. Run via:

```bash
trunk check          # lint all changed files
trunk fmt            # format all changed files
trunk check --all    # lint entire repo
```

Enabled linters: `prettier` (formatting), `markdownlint` (docs), `git-diff-check` (merge artifacts), `trufflehog` (secret scanning). Pre-push hooks are disabled; pre-commit formatting is disabled — run `trunk fmt` manually before committing.

## Build System

The build has two layers:

1. **C++ → WASM** via Emscripten + CMake: `emcmake cmake . && emmake make` → `dist/konclude.mjs` + `dist/konclude.wasm`
2. **TypeScript → ESM** via `tsc`: `ts/**` → `dist/**`

Scripts entry points:

- `npm run build` — compile TypeScript (`ts/**` → `dist/**`)
- `npm test` — Vitest unit + integration tests
- `npm run apply-patches` — runs `scripts/apply-patches.sh` to apply patches over `vendor/konclude/`
- WASM rebuild: `docker compose run --rm build` (use `make build-wasm`)

## Architecture

### C++ layer (`vendor/konclude/` + `src/`)

Konclude source lives in `vendor/konclude/` as a git submodule (upstream: github.com/konclude/Konclude, LGPLv3). Qt is removed via three mechanisms:

| Mechanism                     | Location                                        | What it covers                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container shim + header stubs | `src/compat/QtCompat.h` + `src/compat/Q*` stubs | `QHash→unordered_map`, `QList→vector`, `QSet→unordered_set`, `QString→string`, `QPair→pair`, etc. CMake force-includes `QtCompat.h`; `src/compat/QHash` etc. are empty stubs that satisfy `#include <QHash>` without Qt installed. |
| Source file overrides         | `src/compat/overrides/`                         | WASM-specific replacements for vendor `.cpp` files with wholesale behavioral changes. CMakeLists.txt excludes the vendor original and compiles the override instead.                                                               |
| Minimal patches               | `patches/*.patch`                               | Small additions that cannot be injected from outside (e.g. `using ::qHash;` inside class/namespace scope, correctness fixes). Applied automatically at CMake configure time via `execute_process` in `CMakeLists.txt`.             |

**Never edit `vendor/konclude/` directly.**

Patch vs. override decision rule:

- **Override** (`src/compat/overrides/`): vendor `.cpp` has wholesale behavioral changes (different threading model, different API). The override is a self-contained WASM implementation. When the submodule is updated, manually diff the vendor file against the override to incorporate upstream fixes.
- **Patch** (`patches/*.patch`): small additions inside class/namespace scope that can't be injected from outside, or tiny correctness fixes. Keep patches minimal so they survive upstream context shifts.

Patches are applied at CMake configure time (`cmake -B build`). To force re-apply: `rm vendor/konclude/.patches-applied`.

The C++ surface exposed to JS is `KoncludeReasoner` (in `src/`), three methods: `loadNTriples(string)`, `classify(): bool`, `getInferredNTriples(): string`. Embind wires this to JS in `src/bindings.cpp`.

Key retained Konclude source paths (not all of Konclude is compiled):

- `Source/Reasoner/Kernel/` — tableau algorithm (Qt-free)
- `Source/Reasoner/Triples/CRedlandStoredTriplesData` — librdf wrapper (Qt-free)
- `Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper` — the `mapTriples()` seam
- `Source/Reasoner/Preprocess/`, `Source/Reasoner/Classifier/`, `Source/Reasoner/Ontology/`, `Source/Scheduler/`

Excluded entirely: `Source/Network/` (HTTP/OWLlink server), `Source/Control/Loader/`, all `main*.cpp`.

### JS↔WASM bridge

Binary wire format (see `ts/intern.ts`, `src/KoncludeReasoner.h`): string table + `u32` triple ids (top 2 bits = term type). Self-invalidating contract (plan `docs/plans/2026-10-10-001-*`, doc `docs/solutions/architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md`):

- Every public `RdfReasoner` call encodes the store (default inferred/explanation/hypothetical graphs and a custom `inferredGraph` excluded) and sends worker message `sync`. C++ hashes each triple (type tag + term string, 128 bit), compares the digest set with the last synced one and answers `{changed, added, removed, generation}`. Order, duplicates, Store identity and interned ids do not matter. Blank-node labels count as content.
- Changed content bumps `generation` and hides cached results; the ontology is rebuilt lazily by the next `classification()` / `realization()` / `consistency()`. These verbs are idempotent per generation. Load variant (realization vs classification/consistency, differing in FP/IFP pre-scan) is part of the validity: switching variant rebuilds once.
- TS keeps per-Store result caches keyed on `{store, generation}` only to skip re-injection; C++ stays authoritative. The Worker is recycled (heap > `recycleHeapBytes`) only when changed content arrives.
- Wasm32 pointers above 2 GiB come back negative from Embind `int`: always `>>> 0` before indexing `HEAPU8`.
- Named graphs are dropped at serialization; v1 reasons over the union of all graphs.

### TypeScript layer (`ts/`)

- `ts/worker.ts` — Worker entry: owns WASM module lifecycle, typed `postMessage` dispatch
- `ts/index.ts` — `RdfReasoner` class: serializes quads, calls Worker via `_call(method, ...args)`, deserializes results
- `ts/types.ts` — exported `ReasoningOptions` / `ReasoningResult` interfaces

No Comlink — custom typed dispatch over raw `postMessage`. `KoncludeReasoner` WASM instance is stateful (load → classify order required); call `.delete()` when done.

### Emscripten flags

`ENVIRONMENT=node,worker`, `MODULARIZE=1`, `EXPORT_ES6=1`, `EXPORT_NAME=createKoncludeModule`, `NO_EXIT_RUNTIME=1`, `--bind`, `USE_PTHREADS=1`, `PTHREAD_POOL_SIZE=32`, `PTHREAD_POOL_SIZE_STRICT=2`, `MALLOC=mimalloc`, `INITIAL_MEMORY=1073741824`, `NO_DISABLE_EXCEPTION_CATCHING`, `ALLOW_BLOCKING_ON_MAIN_THREAD=1`, `-flto`. `ASSERTIONS=0` and `DEMANGLE_SUPPORT=0` (both are now the explicit default — removed from the flag list). Pthreads are required — the KPSet classifier spins waiting for parallel test results; cooperative single-thread dispatch deadlocks (see `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`). `PROXY_TO_PTHREAD` is not used — the current build works correctly without it.

## Key Constraints

- `KONCLUDE_REDLAND_INTEGRATION` must be defined when compiling the `mapTriples()` path
- `KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED` suppresses Konclude's Qt-based debug logging
- Raptor2 must be built with `--without-www --without-curl` (no network I/O in WASM)
- `QHash` iteration order differs from `std::unordered_map` — no Konclude kernel code depends on deterministic iteration order (reasoner correctness-critical paths do not iterate maps for ordering)
- LGPL compliance: ship `NOTICE` file in npm package; `package.json` license for TS wrapper is MIT; WASM binary is LGPLv3

## Plan Documents

Origin requirements: [2026-05-04-007-rdf-reasoner-konclude-requirements.md](2026-05-04-007-rdf-reasoner-konclude-requirements.md)

Documented solutions: `docs/solutions/` — architecture decisions, solved bugs, and best practices; organized by category with YAML frontmatter (`module`, `tags`, `problem_type`).
