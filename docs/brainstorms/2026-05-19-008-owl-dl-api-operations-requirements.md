---
date: 2026-05-19
topic: owl-dl-api-operations
---

# OWL-DL API Operations — classify, materialize, classifyProperties

## Problem Frame

The current `RdfReasoner` public API conflates TBox classification and ABox realization into a
single `realization()` C++ call, then only extracts `rdfs:subClassOf` triples from the result.
This means:

- `mode:'classify'` silently runs expensive ABox work it doesn't need
- Individual type entailments (`rdf:type`) are computed internally but never surfaced
- Property hierarchy is not exposed at all
- The API shape (`reason(mode)`) obscures OWL-DL semantics

Users get RDFS-style subclass output from a full OWL-DL reasoner — the ABox and property
results are silently dropped.

## Requirements

**Named methods — new canonical surface**

- R1. Fix `classify(input, opts?)` (already exists) to route to `classification()` C++ (`runPipeline(false)`) instead of the current incorrect `realization()`. Output: `rdfs:subClassOf` triples (Hasse diagram).
- R2. Add `materialize(input, opts?)` as the new TBox+ABox method. Routes to `realization()` C++ (`runPipeline(true)`). By default returns `rdf:type` triples for individuals. Accepts `{ includeClassHierarchy?: boolean }` option to also include `rdfs:subClassOf` output.
- R3. Add `classifyProperties(input, opts?)` to extract the property hierarchy. Returns `rdfs:subPropertyOf` triples for object and data properties.
- R4. `checkConsistency(input)` remains unchanged (already routes to `consistency()` C++).

**Output extraction (C++ side)**

- R5. `getInferredTripleBuffer` must be extended (or a parallel extraction path added) to walk `CConceptRealization::visitTypes()` per individual and emit `rdf:type` triples, mirroring `CWriteIndividualFlattenedTypesQuery` in native Konclude.
- R6. A property hierarchy extraction path must walk the object-property and data-property taxonomies and emit `rdfs:subPropertyOf` triples, mirroring `CWritePropertySubsumptionsHierarchyQuery` in native Konclude.

**Deprecations**

- R7. `reason(quads, opts?)` is deprecated. JSDoc points callers to `classify()`, `materialize()`, or `checkConsistency()`.
- R8. The legacy `classify(quads): Promise<Quad[]>` overload (already exists, currently `@deprecated`) is formally deprecated with JSDoc pointing to the Store-based pattern.

**Worker protocol**

- R9. Worker dispatch must route to the correct C++ method: `classify` → `classification()`, `materialize` → `realization()`, `checkConsistency` → `consistency()`, `classifyProperties` → `classification()` (property hierarchy is a TBox result).

## Success Criteria

- `classify(quads)` runs only `classification()` C++ (no ABox work).
- `materialize(quads)` returns `rdf:type` triples for all named individuals with inferred types.
- `materialize(quads, { includeClassHierarchy: true })` returns both `rdfs:subClassOf` and `rdf:type` triples.
- `classifyProperties(quads)` returns `rdfs:subPropertyOf` triples.
- Existing `checkConsistency()` tests continue to pass unchanged.

## Scope Boundaries

- Role assertions (`owl:ObjectPropertyAssertion`, `owl:DataPropertyAssertion`) are not in scope for this iteration — only individual types (`rdf:type`).
- `owl:sameAs` / `owl:differentFrom` output is out of scope.
- Incremental / streaming reasoning is out of scope.
- `reason()` is deprecated but not removed in this iteration (deletion is a future breaking change).

## Key Decisions

- **Separate named methods over `reason(mode)`**: clearer OWL-DL semantics, easier to document and type individually.
- **materialize() output is configurable**: default is `rdf:type` only; `includeClassHierarchy` avoids a redundant classify() call when callers want both.
- **classifyProperties() in scope now**: explicitly chosen by the user as part of this iteration alongside classify() and materialize().
- **Deprecate reason() + legacy classify() overload**: named methods are the new canonical surface; the umbrella `reason()` adds no value once named methods exist.

## Dependencies / Assumptions

- `CConceptRealization::visitTypes()` is accessible after `realization()` completes — verified by `CWriteIndividualFlattenedTypesQuery` in native Konclude using the same post-`prepareOntology` data.
- Property taxonomy is populated after `classification()` completes — verified by `CWritePropertySubsumptionsHierarchyQuery` in native Konclude.

## Outstanding Questions

### Resolve Before Planning

_(none — all product decisions resolved)_

### Deferred to Planning

- [Affects R5][Technical] How is `CConceptRealization` accessed from `KoncludeReasoner` after `realization()` returns? Is it on `mOntology` or on the manager thread?
- [Affects R6][Technical] Which class holds the property taxonomy — `CPropertyHierarchy` or similar? Grep for `CWritePropertySubsumptionsHierarchyQuery::constructResult` to find the access pattern.
- [Affects R2, R5][Technical] Does `getInferredTripleBuffer` get extended in-place or split into `getClassTripleBuffer` + `getABoxTripleBuffer`? Depends on buffer format investigation.
- [Affects R3, R6][Needs research] Does `classifyProperties()` need a dedicated `classifyProperties()` C++ entry point, or can it reuse `classification()` and add a separate property-walk extraction step?

## Next Steps

-> `/ce-plan` for structured implementation planning
