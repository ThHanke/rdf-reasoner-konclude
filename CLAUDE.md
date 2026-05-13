# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Port the Konclude OWL-DL tableau reasoning kernel to WebAssembly and publish as the `rdf-reasoner-konclude` npm package. The package exposes an async TypeScript API (`RdfReasoner`) backed by a Web Worker running the WASM reasoning kernel. Input and output use `@rdfjs/types` Quad objects throughout.

## Common Commands

| Target            | Command                              | What it does                                               |
| ----------------- | ------------------------------------ | ---------------------------------------------------------- |
| `make build`      | `npm run build`                      | TypeScript compilation only (fast)                         |
| `make build-wasm` | `docker compose run --rm build`      | Full WASM rebuild — ~20–30 min; use ccache for incremental |
| `make test`       | `npm test`                           | Vitest unit + integration suite                            |
| `make smoke`      | `docker compose run --rm smoke-test` | Quick WASM sanity check                                    |
| `make reason`     | `node dist/cli.js $(ARGS)`           | Run CLI locally: `make reason ARGS="--input ont.ttl"`      |
| `make shell`      | `docker compose run --rm shell`      | Interactive Emscripten shell for debugging                 |
| `make patches`    | `npm run apply-patches`              | Re-apply Qt-removal patches to `vendor/konclude/`          |
| `make fmt`        | `trunk fmt`                          | Format all changed files                                   |
| `make lint`       | `trunk check`                        | Lint all changed files                                     |

**Docker ownership:** `dist/` becomes root-owned after `docker compose run build`. Fix before `npm run build`:

```bash
sudo chown -R $USER dist/
```

**Patch workflow:** Edit `vendor/konclude/` → `scripts/generate-patches.sh` → `make patches` → verify → commit `patches/`.

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

NTriples string is the wire format across the JS/WASM boundary:

- JS serializes `Quad[]` → NTriples (via `n3` Writer)
- WASM: Raptor parses NTriples from memory buffer → librdf model → `mapTriples()` → tableau → `getInferredNTriples()` returns NTriples
- JS parses NTriples → `Quad[]` (via `n3` Parser)

Named graphs are dropped at serialization (NTriples is triple-only). v1 reasons over the union of all graphs.

### TypeScript layer (`ts/`)

- `ts/worker.ts` — Worker entry: owns WASM module lifecycle, typed `postMessage` dispatch
- `ts/index.ts` — `RdfReasoner` class: serializes quads, calls Worker via `_call(method, ...args)`, deserializes results
- `ts/types.ts` — exported `ReasoningOptions` / `ReasoningResult` interfaces

No Comlink — custom typed dispatch over raw `postMessage`. `KoncludeReasoner` WASM instance is stateful (load → classify order required); call `.delete()` when done.

### Emscripten flags

`ENVIRONMENT=node,worker`, `MODULARIZE=1`, `EXPORT_ES6=1`, `EXPORT_NAME=createKoncludeModule`, `NO_EXIT_RUNTIME=1`, `--bind`, `USE_PTHREADS=1`, `PTHREAD_POOL_SIZE=8`, `PTHREAD_POOL_SIZE_STRICT=2`, `MALLOC=mimalloc`, `INITIAL_MEMORY=1073741824`, `NO_DISABLE_EXCEPTION_CATCHING`, `ALLOW_BLOCKING_ON_MAIN_THREAD=1`, `-flto`. `ASSERTIONS=0` and `DEMANGLE_SUPPORT=0` (both are now the explicit default — removed from the flag list). Pthreads are required — the KPSet classifier spins waiting for parallel test results; cooperative single-thread dispatch deadlocks (see `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`). `PROXY_TO_PTHREAD` is not used — the current build works correctly without it.

## Key Constraints

- `KONCLUDE_REDLAND_INTEGRATION` must be defined when compiling the `mapTriples()` path
- `KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED` suppresses Konclude's Qt-based debug logging
- Raptor2 must be built with `--without-www --without-curl` (no network I/O in WASM)
- `QHash` iteration order differs from `std::unordered_map` — no Konclude kernel code depends on deterministic iteration order (reasoner correctness-critical paths do not iterate maps for ordering)
- LGPL compliance: ship `NOTICE` file in npm package; `package.json` license for TS wrapper is MIT; WASM binary is LGPLv3

## Plan Documents

Origin requirements: [2026-05-04-007-rdf-reasoner-konclude-requirements.md](2026-05-04-007-rdf-reasoner-konclude-requirements.md)

Documented solutions: `docs/solutions/` — architecture decisions, solved bugs, and best practices; organized by category with YAML frontmatter (`module`, `tags`, `problem_type`).
