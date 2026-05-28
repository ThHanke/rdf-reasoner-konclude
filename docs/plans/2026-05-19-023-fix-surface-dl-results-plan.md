---
title: "fix: Surface full OWL-DL results — classify, materialize, classifyProperties"
type: fix
status: completed
date: 2026-05-19
origin: docs/brainstorms/2026-05-19-008-owl-dl-api-operations-requirements.md
---

# fix: Surface full OWL-DL results — classify, materialize, classifyProperties

## Overview

The `RdfReasoner` public API silently discards the ABox and property hierarchy results that
Konclude computes internally. `classify()` calls the full `realization()` C++ pipeline (wasteful)
and `buildInferredTripleBuffer()` already extracts rdf:type triples when `mRealized=true` but
the JS caller never receives them. Property hierarchy extraction does not exist.

This plan fixes the routing bug, adds `materialize()` and `classifyProperties()` as named
methods, and adds the one missing C++ extraction path (property hierarchy). All other
extraction work (rdf:type from ABox realization) is already implemented in
`buildInferredTripleBuffer()` and just needs correct JS wiring.

## Problem Frame

Three distinct defects, in priority order:

1. **Routing bug**: `classify()` calls worker `"realization"` → `runPipeline(true)` instead of
   `"classification"` → `runPipeline(false)`. Runs unnecessary ABox work for TBox-only callers.
2. **Silent drop**: `realization()` computes rdf:type entailments; `buildInferredTripleBuffer()`
   encodes them; `_reasonOnStore()` never asks for them because it calls `"realization"` then
   `"getInferredTripleBuffer"` — the same path that currently also loses them via the classify
   routing bug.
3. **Missing extraction**: No C++ path for property hierarchy (`rdfs:subPropertyOf`).

## Requirements Trace

- R1. Fix `classify()` routing → `classification()` C++
- R2. Add `materialize()` — TBox+ABox, configurable output
- R3. Add `classifyProperties()` — `rdfs:subPropertyOf` triples
- R5. ABox extraction (rdf:type) via `CConceptRealization::visitTypes()` — already done in C++; needs JS wiring
- R6. Property hierarchy C++ extraction — new `buildPropertyTripleBuffer()`
- R7/R8. Deprecate `reason()` and legacy `classify(quads)` overload
- R9. Worker dispatch routes each operation to the correct C++ method

## Scope Boundaries

- Role assertions (`owl:ObjectPropertyAssertion`) are NOT in scope — `buildInferredTripleBuffer()` already extracts them via `CRoleRealization`; scope question is a TS API decision for a future iteration.
- `owl:sameAs` / `owl:differentFrom` out of scope.
- `reason()` deprecated, not deleted.

### Deferred to Separate Tasks

- Removing deprecated `reason()` and `classify(quads)` overloads: future semver-major
- Role assertion / data property assertion TS API surface: separate iteration

## Context & Research

### Relevant Code and Patterns

- `ts/index.ts:190` — `_reasonOnStore()`: calls `"realization"` worker msg (the bug)
- `ts/index.ts:218` — `_reasonOnQuads()`: same bug; `mode` check at line 220 never routes to `"classification"`
- `ts/worker.ts:123-135` — switch cases for `classification`, `realization`, `consistency`, `getInferredTripleBuffer` — all exist; no new wiring needed except for property buffer
- `src/KoncludeReasoner.cpp:793` — `buildInferredTripleBuffer()`: already emits TBox (line 811) and ABox rdf:type (line 886 gated on `mRealized`); wire format `[strTableLen:u32][strTable][s:u32,p:u32,o:u32,...]`
- `src/KoncludeReasoner.cpp:665/671` — `mClassified`/`mRealized` flags set by `runPipeline()`
- `ts/intern.ts` — `decodeBuffers()`: predicate-agnostic; works unchanged for all triple types
- `vendor/konclude/.../CWritePropertySubsumptionsHierarchyQuery.cpp` — BFS traversal pattern over `CRolePropertiesHierarchy` to mirror
- `tests/unit/RdfReasoner.test.ts:349` — asserts worker call sequence `["realization", ...]` for `classify()` — must be updated

### Property hierarchy access chain (verified)

```
mOntology->getClassification()
  ->getObjectPropertyRoleClassification()->getRolePropertiesHierarchy()
  ->getTopHierarchyNode() / ->getBottomHierarchyNode()
    ->getChildNodeSet() / node->getEquivalentRoleStringList(false)  // full IRIs
```

`CClassification.h` is already included (line 41 of `KoncludeReasoner.cpp`).
`CRolePropertiesHierarchyNode.h` is NOT currently included — must be added.
Top/bottom IRI strings to skip:
- Object: `owl#topObjectProperty`, `owl#bottomObjectProperty`
- Data: `owl#topDataProperty`, `owl#bottomDataProperty`

### Institutional Learnings

- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`:
  key pattern — build `nodeToIris` map keyed on node pointer in a first pass; validate every
  parent pointer against the live map before dereferencing. Apply same discipline to
  `CRolePropertiesHierarchyNode` traversal.
- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md`:
  any config flag touched in this work should be grepped across classifier AND realizer source
  for hidden dual-use before committing.
- `docs/solutions/architecture-patterns/emscripten-pthread-exit-browser-fix-2026-05-13.md`:
  every new worker `case` must wrap its C++ call in the same `try/catch isEmscriptenExitException`
  pattern that existing cases use.

## Key Technical Decisions

- **JS-side filtering for `materialize({ includeClassHierarchy: false })`**: `buildInferredTripleBuffer()` always returns TBox+ABox together when `mRealized=true`. Filtering `rdfs:subClassOf` and `owl:equivalentClass` predicates out in JS is simpler than adding a C++ parameter — the TBox computation runs anyway as a prerequisite to realization, so no work is wasted.
- **Reuse `mResultBuffer` / `getInferredTripleBufferPtr` for property triples**: `buildPropertyTripleBuffer()` writes to the same `mResultBuffer`; the existing `getInferredTripleBufferPtr()` Embind binding is reused. Operations are serialized via the JS promise queue so no concurrency risk.
- **No new `classifyProperties()` C++ pipeline**: `classification()` already requests `OPSOBJECTROPERTYCLASSIFY` and `OPSDATAROPERTYCLASSIFY` via `buildBaseRequirements()`. Only the extraction walk is new.
- **`materialize()` routes to `"realization"`; `classify()` routes to `"classification"`**: matches OWL-DL semantics and matches what native Konclude's batch loaders do.

## High-Level Technical Design

> *Directional guidance for review, not implementation specification.*

```
classify(input)
  → worker: loadTripleBuffer → classification → getInferredTripleBuffer
  → C++: runPipeline(false) → buildInferredTripleBuffer() [TBox only, mRealized=false]
  → output: rdfs:subClassOf + owl:equivalentClass

materialize(input, { includeClassHierarchy? })
  → worker: loadTripleBuffer → realization → getInferredTripleBuffer
  → C++: runPipeline(true) → buildInferredTripleBuffer() [TBox+ABox]
  → JS filter: includeClassHierarchy=false → drop subClassOf/equivalentClass quads
  → output: rdf:type (+ optionally subClassOf/equivalentClass)

classifyProperties(input)
  → worker: loadTripleBuffer → classification → getPropertyTripleBuffer
  → C++: runPipeline(false) → buildPropertyTripleBuffer() [walks property hierarchy]
  → output: rdfs:subPropertyOf

checkConsistency(input)  [unchanged]
  → worker: loadTripleBuffer → classification → consistency
```

## Implementation Units

- [x] **Unit 1: Fix classify() routing to classification() C++**

**Goal:** `classify()` stops calling `"realization"` and calls `"classification"` instead.

**Requirements:** R1, R9

**Dependencies:** None

**Files:**
- Modify: `ts/index.ts` — `_reasonOnStore()` and `_reasonOnQuads()`
- Test: `tests/unit/RdfReasoner.test.ts`

**Approach:**
- `classify()` (line 260) delegates to `reason()` → `_reasonOnStore/Quads()`. The routing fix must happen inside `_reasonOnStore()` and `_reasonOnQuads()`, not in `classify()` itself.
- The shared `_reasonOnStore()` / `_reasonOnQuads()` currently always call `"realization"`. After the fix they must be mode-aware:
  - `mode === "classify"` (default) → call `"classification"`
  - `mode === "full"` → call `"realization"` (preserves ABox output for deprecated `reason({mode:"full"})`)
  - `mode === "consistency"` → already handled before the worker call (early return)
- This means `reason({mode:"classify"})` and `classify()` both correctly route to `"classification"` after the fix.
- `reason({mode:"full"})` continues to call `"realization"` — callers of the deprecated `"full"` mode get the same (now correct) full output that `materialize()` will produce.
- The worker `case "classification"` already exists — no worker changes needed in this unit.
- `buildInferredTripleBuffer()` is gated on `mClassified` (not `mRealized`), so it returns TBox output correctly after `classification()`.

**Patterns to follow:**
- `ts/index.ts:291` — `checkConsistency()` already calls `"classification"` then `"consistency"`; `classify()` should call `"classification"` then `"getInferredTripleBuffer"`.

**Test scenarios:**
- Happy path: `classify(quads)` → worker receives `["loadTripleBuffer", "classification", "getInferredTripleBuffer"]` in that order (update existing assertion at line 349)
- Happy path: returned quads contain only `rdfs:subClassOf` / `owl:equivalentClass` predicates — no `rdf:type`
- Edge case: ontology with no named classes → empty result, no throw
- Integration: `classify()` on LUBM schema fixture produces same subClassOf triples as before fix (regression guard)

**Verification:**
- `tests/unit/RdfReasoner.test.ts` passes with updated worker-call assertion
- Existing LUBM/GALEN fixture tests produce identical subClassOf output

---

- [x] **Unit 2: Add materialize() TypeScript method**

**Goal:** New public `materialize(input, opts?)` method that surfaces rdf:type entailments. Accepts `{ includeClassHierarchy?: boolean }` option.

**Requirements:** R2, R5

**Dependencies:** None (independent of Unit 1; reuses existing `"realization"` worker path)

**Files:**
- Modify: `ts/index.ts` — add `materialize()` overloads and private `_materializeOnStore()` / `_materializeOnQuads()`
- Modify: `ts/types.ts` — add `MaterializeOptions` interface with `includeClassHierarchy?: boolean`

**Approach:**
- Route: `loadTripleBuffer → realization → getInferredTripleBuffer` (same sequence `reason()` currently uses, now with correct semantics)
- `buildInferredTripleBuffer()` already emits rdf:type triples at line 886 when `mRealized=true`. No C++ changes.
- After decoding with `decodeBuffers()`, apply JS filter when `opts?.includeClassHierarchy !== true`: exclude quads whose `predicate.value` is `http://www.w3.org/2000/01/rdf-schema#subClassOf` or `http://www.w3.org/2002/07/owl#equivalentClass`.
- Store-based overload writes filtered quads into the store (same pattern as `_reasonOnStore`).
- Quad-based overload returns filtered `Quad[]`.

**Patterns to follow:**
- `ts/index.ts:190` — `_reasonOnStore()` for store write pattern
- `ts/index.ts:218` — `_reasonOnQuads()` for queue chaining and return pattern

**Test scenarios:**
- Happy path: `materialize(quads)` with ABox individuals → returns `rdf:type` triples, no `rdfs:subClassOf`
- Happy path: `materialize(quads, { includeClassHierarchy: true })` → returns both `rdf:type` and `rdfs:subClassOf` triples
- Happy path: worker call sequence is `["loadTripleBuffer", "realization", "getInferredTripleBuffer"]`
- Edge case: ontology with no individuals (`mRealized=false`) → returns empty array (or only subClassOf when `includeClassHierarchy: true`)
- Edge case: `materialize(quads)` on TBox-only ontology → no rdf:type triples, no throw
- Integration: Roberts fixture — `materialize()` returns `rdf:type :Person` for `:Robert` (or equivalent fixture individual)

**Verification:**
- Unit tests pass
- Roberts/LUBM+data fixtures: `materialize()` returns non-empty rdf:type quads

---

- [x] **Unit 3: Add buildPropertyTripleBuffer() C++ + Embind + worker case**

**Goal:** New C++ method that walks the object-property and data-property hierarchies and emits `rdfs:subPropertyOf` triples into `mResultBuffer` using the same binary wire format.

**Requirements:** R6

**Dependencies:** None (C++ only; no TS dependency)

**Files:**
- Modify: `src/KoncludeReasoner.h` — add `buildPropertyTripleBuffer()` declaration
- Modify: `src/KoncludeReasoner.cpp` — implement `buildPropertyTripleBuffer()`; add `#include "Reasoner/Taxonomy/CRolePropertiesHierarchyNode.h"` near top with existing includes
- Modify: `src/bindings.cpp` — add `.function("buildPropertyTripleBuffer", ...)` Embind binding
- Modify: `ts/worker.ts` — add `case "getPropertyTripleBuffer"` that calls `buildPropertyTripleBuffer()` then `getInferredTripleBufferPtr()`

**Approach:**
- `buildPropertyTripleBuffer()` resets and rebuilds `mResultBuffer` with only property triples.
- Guard: return 0 if `!mImpl->mClassified`.
- For each of `{getObjectPropertyRoleClassification, getDataPropertyRoleClassification}`:
  - Get `CRolePropertiesHierarchy*` from the classification
  - BFS from top node; skip top and bottom nodes by IRI
  - For each non-top/non-bottom child node: emit `rdfs:subPropertyOf(childIri, parentIri)` for all IRIs in equivalence class (BFS mirrors `CWritePropertySubsumptionsHierarchyQuery`)
  - Per-node IRI extraction: `node->getEquivalentRoleStringList(false)` returns full IRI list
  - First-pass `nodeToIris` map (keyed on node ptr) before emission loop — same discipline as TBox in `buildInferredTripleBuffer()`; validate every parent pointer against the map before use
- `InternTable` + `emitTriple` lambda + `emittedTriples` dedup set — same pattern as existing `buildInferredTripleBuffer()`.
- Worker `case "getPropertyTripleBuffer"`: mirror the `case "getInferredTripleBuffer"` early-return-with-transfer pattern (lines 135–152 of `ts/worker.ts`): call `buildPropertyTripleBuffer()`, get `getInferredTripleBufferPtr()`, `HEAPU8.slice(ptr, ptr+len)`, postMessage with transfer, `return`. Any C++ exception before the postMessage is caught by the outer try/catch at line 165. There is no `isEmscriptenExitException` guard in `worker.ts` itself — that protection is in the patched `dist/konclude.mjs`.

**Patterns to follow:**
- `src/KoncludeReasoner.cpp:793` — `buildInferredTripleBuffer()` for buffer construction pattern
- `ts/worker.ts:135` — existing `case "getInferredTripleBuffer"` for the worker handler pattern
- `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md` — node-pointer-keyed first-pass map, parent validation

**Test scenarios:**
- Happy path: ontology with `owl:ObjectProperty` hierarchy → worker `getPropertyTripleBuffer` call returns buffer with `rdfs:subPropertyOf` triples
- Happy path: data property hierarchy also emitted
- Edge case: ontology with no properties → returns 0-triple buffer, no throw
- Edge case: equivalent properties → all IRIs emitted, no duplicates via dedup set
- Edge case: top/bottom object property IRIs excluded from output

**Verification:**
- No WASM rebuild required (TypeScript/C++ changes only compile via `npm run build` — wait, this modifies C++ so it does need WASM rebuild via `make build-wasm`)
- Smoke test (`make smoke`) passes
- `npm run patch-wasm` run after rebuild

---

- [x] **Unit 4: Add classifyProperties() TypeScript method**

**Goal:** New public `classifyProperties(input, opts?)` method that returns `rdfs:subPropertyOf` triples.

**Requirements:** R3

**Dependencies:** Unit 3 (requires new `"getPropertyTripleBuffer"` worker case)

**Files:**
- Modify: `ts/index.ts` — add `classifyProperties()` overloads
- Modify: `ts/types.ts` — add `ClassifyPropertiesOptions` interface if needed (likely empty for now)

**Approach:**
- Route: `loadTripleBuffer → classification → getPropertyTripleBuffer`
- `classification()` already classifies both object and data properties — no extra C++ step.
- Decode with `decodeBuffers()` — unchanged, predicate-agnostic.
- Store-based overload writes quads into store; quad-based overload returns `Quad[]`.

**Patterns to follow:**
- `ts/index.ts:260` — `classify()` for the Store/Quad overload structure
- Worker call sequence: same three-step pattern as `classify()` but with `"getPropertyTripleBuffer"` as the third call

**Test scenarios:**
- Happy path: ontology with explicit property hierarchy → `rdfs:subPropertyOf` quads returned
- Happy path: worker call sequence is `["loadTripleBuffer", "classification", "getPropertyTripleBuffer"]`
- Edge case: ontology with no user-defined properties → empty result
- Integration: property hierarchy fixture (or synthetic ontology) — verify against expected triples

**Verification:**
- Unit tests pass
- Manual smoke with a property-hierarchy ontology (can use tests/fixtures/)

---

- [x] **Unit 5: Deprecate reason() and legacy classify(quads) overload**

**Goal:** JSDoc deprecations on `reason()` and the `classify(quads): Promise<Quad[]>` overload. Update `types.ts` mode comment.

**Requirements:** R7, R8

**Dependencies:** None (documentation only)

**Files:**
- Modify: `ts/index.ts` — add `@deprecated` JSDoc to `reason()` overloads; update `classify(quads)` JSDoc
- Modify: `ts/types.ts` — update `mode` union comment; note that `"classify"` and `"full"` in `reason()` are deprecated paths

**Approach:**
- `@deprecated` on `reason(quads, opts?)` pointing to `classify()`, `materialize()`, `checkConsistency()` by name.
- `@deprecated` tag already exists on `classify(quads): Promise<Quad[]>` — update the message to point to `classify(store)`.
- `types.ts`: mark `ReasoningOptions.mode` as part of the deprecated `reason()` API.
- Do NOT remove any code — deletion is a future semver-major.

**Test scenarios:**
- Test expectation: none — documentation-only change, no behavioral change

**Verification:**
- TypeScript compilation passes (`npm run build`)
- No test regressions

---

- [x] **Unit 6: Integration tests and fixture updates**

**Goal:** New test cases for `materialize()` and `classifyProperties()`; update any fixtures or assertions broken by Unit 1's routing fix.

**Requirements:** All (cross-cutting verification)

**Dependencies:** Units 1, 2, 4

**Files:**
- Modify: `tests/unit/RdfReasoner.test.ts` — update classify worker-call assertion; add materialize/classifyProperties test cases
- Modify or verify: `tests/integration/` (if applicable) — check any integration tests that assert on `reason()` behavior
- Fixture files: `tests/fixtures/` — if subClassOf output changes after routing fix, update `*-wasm-out.nt` accordingly

**Approach:**
- Update existing classify worker-call test (currently asserts `"realization"`, now must assert `"classification"`).
- Add `materialize()` unit tests using synthetic quads with named individuals and class assertions. Verify rdf:type in result; verify subClassOf excluded by default; verify `includeClassHierarchy: true` includes both.
- Add `classifyProperties()` unit test with a synthetic property hierarchy ontology.
- Run `npm test` — if any fixture-based test fails due to routing change, compare diff; if output is identical (likely — classification produces same TBox as realization for TBox-only fixtures), no fixture update needed. If mismatch, update fixture.
- Sorted-triple diff approach: after classify routing fix, run against LUBM/GALEN fixtures and diff at triple level rather than count.

**Test scenarios:**
- Integration: `classify()` on lubm fixture → same set of subClassOf triples as before (regression)
- Integration: `materialize()` on a fixture with individuals (Roberts / LUBM+data) → non-empty rdf:type triples
- Integration: `classifyProperties()` on an ontology with a property hierarchy → correct rdfs:subPropertyOf triples
- Integration: `checkConsistency()` tests continue to pass unchanged (R4 regression guard)
- Edge case: sequential calls (`classify()` then `materialize()` on same reasoner instance) → no hang, correct results each time

**Verification:**
- `npm test` passes clean
- No fixture regeneration needed for TBox-only ontologies (LUBM schema, GALEN)
- Roberts / LUBM+data: `materialize()` returns expected rdf:type quads

## System-Wide Impact

- **Interaction graph**: `_reasonOnStore()` / `_reasonOnQuads()` routing change touches both the store-based and quad-based public surfaces; `reason()` (deprecated but still wired) must be updated too so it doesn't silently still call `"realization"` for `mode:"classify"` after the fix — verify its internal call path.
- **Error propagation**: New methods follow existing promise-queue rejection pattern; errors reject the caller's promise without stalling the queue.
- **State lifecycle**: `mResultBuffer` is shared between `buildInferredTripleBuffer()` and `buildPropertyTripleBuffer()`. Calls are serialized by the JS promise queue; no concurrent access risk. `reset()` already clears the buffer.
- **API surface parity**: `materialize(store)` and `materialize(quads)` both needed; same for `classifyProperties()`. Mirror the existing Store/Quad overload pattern exactly.
- **Unchanged invariants**: `checkConsistency()` routing and behavior unchanged. `classification()` and `realization()` C++ methods unchanged. Buffer wire format unchanged.
- **WASM rebuild required**: Unit 3 modifies C++ (`KoncludeReasoner.cpp/h`, `bindings.cpp`). After `make build-wasm`, `npm run patch-wasm` must run before tests.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 3 (property hierarchy BFS) may produce wrong parent IRIs if node ptr is stale | Apply `nodeToIris.count(parentNode) == 0` guard from institutional learning; validate with explicit property-hierarchy fixture |
| classify() routing fix changes output for ABox ontologies run through old `classify()` | Sorted-triple diff against fixtures before/after; existing tests catch regressions |
| `buildPropertyTripleBuffer()` share of `mResultBuffer` conflicts with `buildInferredTripleBuffer()` | Not concurrent — JS queue serializes all calls; confirmed by existing `reset()` clearing the buffer |
| `CRolePropertiesHierarchyNode.h` not yet included — compile error without it | Explicit include added in Unit 3; verify `make build-wasm` succeeds |
| Browser worker tests break after classify routing change | Run `make test` including Playwright browser suite after Unit 1 |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-19-008-owl-dl-api-operations-requirements.md](docs/brainstorms/2026-05-19-008-owl-dl-api-operations-requirements.md)
- Existing extraction: `src/KoncludeReasoner.cpp:793` (`buildInferredTripleBuffer`)
- Property hierarchy pattern: `vendor/konclude/Source/Reasoner/Query/CWritePropertySubsumptionsHierarchyQuery.cpp`
- ABox pattern: `vendor/konclude/Source/Reasoner/Query/CWriteIndividualFlattenedTypesQuery.cpp`
- Learning: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- Learning: `docs/solutions/architecture-patterns/emscripten-pthread-exit-browser-fix-2026-05-13.md`
