# rdf-reasoner-konclude

WebAssembly port of the [Konclude](https://github.com/konclude/Konclude) OWL-DL tableau reasoning kernel, published as an npm package with a TypeScript/RDF.js API.

**Status:** Phase 1 (Qt elimination) and Phase 2 (WASM build pipeline) complete. Phase 3 (TypeScript npm package) in progress.

## What it does

Brings OWL-DL reasoning (nominals, inverse roles, complex cardinality) to the browser. The package accepts `Iterable<Quad>` input and returns inferred `Quad[]` — fully typed with `@rdfjs/types`.

```typescript
const reasoner = new RdfReasoner()
await reasoner.ready
const inferred = await reasoner.reason(quads)  // Promise<Quad[]>
```

The reasoning runs in a Web Worker backed by a WebAssembly binary compiled from Konclude's C++ tableau engine.

## Build

Requires Docker.

```bash
# First time: cross-compile Raptor2/librdf for WASM and build the kernel
docker compose run build

# Verify: smoke-test a 3-class ontology (A⊑B + B⊑C → A⊑C)
docker compose run smoke-test

# Interactive shell inside the build container
docker compose run shell
```

`docker compose run build` runs in sequence:
1. `scripts/apply-patches.sh` — applies Qt-removal patches over `vendor/konclude/`
2. `scripts/build-raptor-wasm.sh` — cross-compiles Raptor2 2.0.16 + librdf 1.0.17 to WASM (installs to `wasm-libs/`)
3. `emcmake cmake -B build` + `emmake make` — compiles the kernel to `dist/konclude.mjs` + `dist/konclude.wasm`

Build output: `dist/konclude.mjs` (ES module, `EXPORT_NAME=createKoncludeModule`) and `dist/konclude.wasm`.

## Architecture

### End-to-end pipeline

```
JS (main thread)
  RdfReasoner.reason(quads)
    → serialize Quad[] to NTriples (n3.js Writer)
    → postMessage to Worker

Worker
  → KoncludeReasoner::loadNTriples(ntriplesStr)       // C++ via Embind
      → CRDFRedlandRaptorParser::parseTriples()        // NTriples → librdf model
      → CConcreteOntologyRedlandTriplesDataExpressionMapper::mapTriples()
  → KoncludeReasoner::classify()                      // synchronous tableau
      → CPreprocessingThread::start()  → run()
      → CPrecomputationThread::start() → run()
      → COptimizedKPSetClassSubsumptionClassifierThread::start() → run()
  → KoncludeReasoner::getInferredNTriples()           // taxonomy → NTriples string
    → postMessage result back

JS (main thread)
  → parse NTriples → Quad[] (n3.js Parser)
  → return Quad[]
```

NTriples is the wire format at the JS↔WASM boundary. Named graphs are dropped (NTriples is triple-only); v1 reasons over the union of all graphs.

### Qt removal strategy

Konclude's C++ source uses Qt throughout. Four layers are removed:

| Layer | Qt usage | Removal |
|-------|----------|---------|
| Containers | `QHash`, `QList`, `QSet`, `QString`, … | `src/compat/QtCompat.h` — typedef shim to `std::` equivalents |
| Threading spine | `CThread : public QThread`, `QSemaphore`, `QMutex` | `patches/002-cthread-sync.patch` — `start()` calls `run()` directly; primitives stubbed to no-ops |
| I/O | `QIODevice` in Raptor parser | `patches/003-raptor-istream.patch` — replaced with `raptor_new_iostream_from_string()` |
| Network | `Source/Network/HTTP/CQt*` | Excluded from build entirely |

All changes to `vendor/konclude/` are captured as `.patch` files and applied at build time. The submodule itself stays clean.

### Repository structure

```
vendor/konclude/          git submodule — upstream Konclude source (LGPLv3)
patches/
  001-qt-compat-header.patch   adds #include "QtCompat.h" to 141 kernel headers
  002-cthread-sync.patch       replaces Qt threading spine (25 files)
  003-raptor-istream.patch     replaces QIODevice with raptor_new_iostream_from_string
src/
  compat/QtCompat.h            Qt→std:: type shim (containers, QMutex, QSemaphore, …)
  KoncludeReasoner.h/.cpp      C++ wrapper: loadNTriples / classify / getInferredNTriples
  bindings.cpp                 Emscripten Embind bindings
  CMakeLists.txt               kernel sources + WASM target
scripts/
  apply-patches.sh             idempotent patch applicator
  build-raptor-wasm.sh         cross-compiles Raptor2 + librdf for WASM
  generate-patches.sh          regenerates patches/* from vendor/ diffs
tests/smoke/
  smoke.mjs                    ESM smoke test (requires dist/ to be built)
  raptor-smoke.c               standalone Raptor2 link verification
CMakeLists.txt                 top-level CMake (conditionally includes emscripten.cmake)
emscripten.cmake               Emscripten flags: ENVIRONMENT=worker, MODULARIZE=1, …
Dockerfile                     emscripten/emsdk:3.1.73 + build deps
docker-compose.yml             build / smoke-test / shell services
```

### Emscripten flags

`ENVIRONMENT=worker` · `MODULARIZE=1` · `EXPORT_ES6=1` · `EXPORT_NAME=createKoncludeModule` · `ALLOW_MEMORY_GROWTH=1` · `NO_EXIT_RUNTIME=1` · `--bind` · `--oformat=esm`

No pthreads — the Web Worker is the threading boundary. All Konclude thread subclasses run synchronously (`start()` → `run()` direct call).

### Patching workflow

```bash
# Apply patches to vendor/konclude/ before building (done automatically by docker compose run build)
scripts/apply-patches.sh

# Regenerate patches after editing vendor/konclude/ sources
cd vendor/konclude
# ... make changes ...
git diff > ../../patches/NNN-description.patch
git checkout -- .
```

## LGPL notice

The WASM binary (`dist/konclude.wasm`) contains the Konclude reasoning kernel, which is © University of Ulm and released under **LGPLv3**. The TypeScript wrapper and build scripts in this repository are MIT-licensed.

As required by LGPLv3 §4, the complete Konclude source with all applied modifications is available at `vendor/konclude/` (git submodule) together with `patches/` containing every change. To recompile: clone this repository with `--recurse-submodules` and run `docker compose run build`.

> Liebig, T., Jaeger, M., Möller, R., & Möller, B. (2014). *Konclude: System Description.*
> Web Semantics, 27–28, 78–85. doi:10.1016/j.websem.2014.06.003

## Acknowledgements

Konclude was developed at the Institute of Artificial Intelligence, University of Ulm, by Thorsten Liebig, Murat Özcep, Stefan Wandelt, and others. All credit for the reasoning algorithm belongs to the Konclude authors. This package is an independent WebAssembly port.
