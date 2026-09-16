---
module: src/KoncludeReasoner.cpp
tags: [architecture, owl2dl, workarounds, refactor]
problem_type: pattern
date: 2026-06-10
plan: 2026-06-10-047
---

# OWL 2 DL Workaround Migration Pattern (TS → C++)

## Problem

OWL 2 DL parity gaps accumulate as TypeScript pre/post-processing blocks spread
across multiple API paths (`_materializeOnStore`, `_materializeOnQuads`,
`_materializeInline`, `whatIf`, `_classifyOnStore`, `_reasonOnQuads`,
`_classifyInline`). Each new workaround must be manually wired into every path,
and the TS wrapper grows in complexity.

## Solution

Move workarounds into `src/KoncludeReasoner.cpp`:
- **Input pre-processing**: `loadTripleBuffer()` — scan intern table + triples,
  set flags / strip declarations / store per-call state in `Impl` fields.
- **Output post-processing**: `buildInferredTripleBuffer()` — after WASM
  taxonomy walk, synthesize missing triples from stored `Impl` state.
- **Property output**: `buildPropertyTripleBuffer()` — same pattern for property hierarchy output.
- **Consistency short-circuit**: `consistency()` — check `Impl::mTriviallyInconsistent`
  before calling WASM pipeline.

## Pattern: Impl fields for per-call state

```cpp
struct Impl {
    // Per-call workaround state, cleared in reset()
    bool mTriviallyInconsistent = false;
    std::vector<std::pair<std::string,std::string>> mEquivPropPairs;
    std::vector<std::pair<std::string,std::string>> mFpIfpSameAsPairs;
    // ... etc
};
```

`reset()` must clear all per-call fields before each new ontology load.

## Pattern: loadTripleBuffer() scan

The intern table (term index → IRI string) is available as local `terms[]`
array during `loadTripleBuffer()`. After the insertion loop (triples already in
the librdf model), scan for:

```cpp
auto findTerm = [&](const char* iri, size_t len) -> uint32_t {
    for (uint32_t i = 0; i < count; ++i)
        if (terms[i].len == len && memcmp(terms[i].ptr, iri, len) == 0) return i;
    return UINT32_MAX;
};
uint32_t propId = findTerm("http://...", sizeof("http://...") - 1);
```

Predicates are always NamedNodes (typeTag=0), so encoded predicate ID == raw
term index. Subject/object type tags: 0=NamedNode, 1=BlankNode.

## Pattern: skipping triples during insertion (FP/IFP)

To prevent a triple from entering the WASM pipeline, skip it in the insertion loop.
`librdf_model_remove_statement` is NOT reliable — the mapper also walks the CXLinker, which is populated in the same loop. The only safe way is to skip insertion.

The FP/IFP skip uses a `forRealization` flag passed to `loadTripleBuffer()` so that
consistency/classify paths (which need the FP/IFP declaration for native semantics)
are unaffected:

```cpp
// Pre-scan (only when forRealization=true):
if (forRealization && ...) {
    // compute fpIfpDeclSkipSet: {(propTermIdx << 32) | typeTermIdx}
}

// Insertion loop:
for (int i = 0; i < tripleCount; ++i) {
    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
    if (!fpIfpDeclSkipSet.empty() && pId == fpPreRdfTypeIdx &&
            (sId >> 30) == 0 && (oId >> 30) == 0) {
        uint64_t key = (static_cast<uint64_t>(sId & 0x3FFFFFFFu) << 32) | (oId & 0x3FFFFFFFu);
        if (fpIfpDeclSkipSet.count(key)) continue;
    }
    // ... insert into model + linker ...
}
```

## Pattern: buildInferredTripleBuffer() synthesis

The intern table for the output buffer is built fresh each call. IRI strings
stored in Impl during load are re-interned:

```cpp
static const std::string owlSameAs = "http://www.w3.org/2002/07/owl#sameAs";
uint32_t pSameAs = intern.intern(owlSameAs);
for (const auto& [s, o] : mImpl->mFpIfpSameAsPairs)
    emitTriple(intern.intern(s), pSameAs, intern.intern(o));
```

`emitTriple` deduplicates via `emittedTriples` set so no duplicates in output.

## Workarounds migrated (plan-047, 2026-06-10)

| # | Workaround | C++ location |
|---|---|---|
| 1 | FP/IFP sameAs | `loadTripleBuffer()` scan → strip decls + `mFpIfpSameAsPairs`; `buildInferredTripleBuffer()` emits |
| 2 | someValuesFrom fixpoint | `loadTripleBuffer()` builds `mSvfIndex` + `mSvfRoleAssertions` + `mSvfABoxTypes`; `buildInferredTripleBuffer()` runs fixpoint |
| 3 | disjointUnionOf | `loadTripleBuffer()` walks RDF lists → `mDisjointUnionOf`; `buildInferredTripleBuffer()` emits subClassOf |
| 4 | equivalentProperty bidirectional | `loadTripleBuffer()` collects `mEquivPropPairs`; `buildPropertyTripleBuffer()` emits subPropertyOf |
| 5 | differentFrom self-clash | `loadTripleBuffer()` scan → `mTriviallyInconsistent`; `consistency()` short-circuits |
| 6 | complementOf ABox clash | `loadTripleBuffer()` scan → `mTriviallyInconsistent`; `consistency()` short-circuits |
