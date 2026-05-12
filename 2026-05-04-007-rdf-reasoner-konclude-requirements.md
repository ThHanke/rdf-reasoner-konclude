---
date: 2026-05-04
topic: rdf-reasoner-konclude
---

# rdf-reasoner-konclude — WebAssembly Browser Port of Konclude

## Problem Frame

Ontosphere needs a full OWL-DL reasoner in the browser. The current N3.js / eyereasoner stack covers OWL-RL but not OWL-DL (no nominals, no inverse roles, no complex cardinality). Konclude is a high-performance OWL-DL tableau reasoner written in C++. A WASM port published as an npm package (`rdf-reasoner-konclude`) would make Konclude available to any JavaScript/TypeScript project without a backend.

## Requirements

**Package Identity**
- R1. GitHub repo name: `rdf-reasoner-konclude`
- R2. npm package name: `rdf-reasoner-konclude`
- R3. Implementation language: TypeScript wrapper over a WASM core compiled from Konclude's C++ kernel via Emscripten
- R4. Package is standalone — no dependency on Ontosphere internals

**RDF.js Integration**
- R5. Public API exposes an RDF.js-compatible interface (accepts RDF.js `Quad` / `DatasetCore` as input)
- R6. Reasoning results returned as RDF.js `Quad` iterables
- R7. TypeScript type definitions shipped with the package

**Browser Compatibility**
- R8. Runs in a Web Worker (no Node.js-only APIs in the WASM layer)
- R9. No Qt dependency in the compiled output — only the Konclude reasoning kernel is ported

**Build**
- R10. WASM binary produced by Emscripten from Konclude C++ source
- R11. Triple ingestion enters via `CConcreteOntologyRedlandTriplesDataExpressionMapper::mapTriples()` (identified seam from prior research; Redland C layer, not Qt)

## Success Criteria

- Package installs and runs in a browser Worker with zero server-side components
- A standard OWL-DL ontology (e.g., LUBM or Pizza) can be loaded and classified
- Inference results match Konclude's desktop output for the same ontology
- Ontosphere can swap eyereasoner for rdf-reasoner-konclude without changing its reasoning API

## Scope Boundaries

- No GUI or Protégé plugin
- No SPARQL endpoint — reasoning only (classify, check consistency, get inferences)
- No Node.js-specific optimisations in v1 (browser-first)
- No streaming incremental reasoning in v1

## Licensing

Konclude: LGPLv3. Redland C: LGPL 2.1+ / GPL 2 / Apache 2.

WASM port is permissible under LGPLv3 §4 provided:
- WASM binary carries LGPL notice
- C++ source and Emscripten build scripts are published (GitHub repo satisfies this)
- Users can recompile WASM from modified source

TypeScript wrapper may be licensed MIT or Apache 2.

## Key Decisions

- **Name `rdf-reasoner-konclude`**: Fits RDF.js ecosystem `rdf-*` prefix convention; Konclude brand retained; searchable
- **Emscripten over native WASM**: Konclude uses C++ standard library heavily; Emscripten provides the most complete libc++ shim for browser targets
- **RDF.js interface**: Aligns with Comunica, rdf-ext, and Ontosphere's existing quad-based data model — no custom format needed

## Dependencies / Assumptions

- Konclude C++ source is available (GitHub: stardog-union/Konclude or original SHK repo)
- Prior session research identified `mapTriples()` as the triple-ingestion seam; this must be verified against current source before planning
- Emscripten build of Redland C (`librdf`) is feasible; may need a stripped / stub version

## Outstanding Questions

### Resolve Before Planning

*(none — all blocking questions resolved)*

### Deferred to Planning

- **[Affects R9][Needs research]** Which Konclude source modules require Qt and which are pure kernel C++? How much of Qt can be stubbed vs. must be removed?
- **[Affects R10][Needs research]** Does Redland C compile cleanly under Emscripten, or does it need a stub/shim?
- **[Affects R5–R6][Technical]** Which RDF.js interface to implement first — `DatasetCore`, `Store`, or a custom `Reasoner` interface with `reason(dataset)` → `Dataset`?
- **[Affects R11][Needs research]** Verify `mapTriples()` seam against current Konclude source (last checked against an older snapshot)

## Next Steps

-> `/ce-plan` for structured implementation planning
