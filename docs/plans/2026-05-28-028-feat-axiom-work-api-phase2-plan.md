---
title: "feat: Add isSatisfiable, getUnsatisfiableClasses, and validate (axiom-work API Phase 2)"
type: feat
status: active
date: 2026-05-28
origin: docs/plans/2026-05-22-024-feat-axiom-work-api-plan.md
---

# feat: Add isSatisfiable, getUnsatisfiableClasses, and validate (axiom-work API Phase 2)

## Overview

Phase 1 of the axiom-work API (fingerprint cache, `isEntailed`, `whatIf`, `explain`,
`explainInconsistency`) is merged to main. Phase 2 completes the remaining units from
plan-024 that were blocked on a WASM rebuild:

- **Unit 5** — `buildUnsatisfiableClassBuffer()` C++ method + TypeScript wrappers
  `isSatisfiable(store, classIRI)` and `getUnsatisfiableClasses(store)`
- **Unit 7** — `validate(store, opts?)` high-level combined diagnostic API
- **Docs** — README API reference + Common workflows section updated to cover all
  Phase 1 and Phase 2 public methods

**Note:** Plan-024 Unit 4 (`owl:sameAs` extraction) was implemented separately via
plan-027 and is already present in `buildInferredTripleBuffer()` at lines 1089–1130.
It is not part of this plan.

The WASM rebuild required for Unit 5 must complete before the TypeScript wrappers for
Unit 5 (and by extension Unit 7) can be written and tested.

## Problem Frame

After Phase 1 merge, two diagnostic capabilities described in the origin plan remain
unimplemented: unsatisfiable-class detection and high-level validation. These close
the loop on ontology-engineering workflows where users need to know not just whether an
ontology is inconsistent, but also whether individual classes are reachable, and to get
a structured single-call diagnostic summary.

## Requirements Trace

From plan-024:
- R-F: `isSatisfiable(store, classIRI)` — open-world: class absent from taxonomy → `true`
- R-F: `getUnsatisfiableClasses(store)` — returns full unsatisfiable IRI set
- R-G: `validate(store, opts?)` — returns `{ consistent, errors, warnings }` where
  `errors` = inconsistency justifications, `warnings` = unsatisfiable-class justifications

New requirement (user request):
- R-Doc: README API reference and Common workflows section must cover all public
  methods after Phase 2, including Phase 1 additions not yet documented

## Scope Boundaries

- No true incremental Konclude reasoning (`OPSPREPROCESSDELTA`) — deferred
- No data property value entailments (covered by plan-027)
- No `owl:differentFrom` extraction (not planned)
- `isSatisfiable` accepts named class IRIs only — no anonymous class expressions
- `validate` explanations always computed (no lazy mode in this plan)

### Deferred to Separate Tasks

- Data property and `owl:sameAs` integration tests: covered by plan-027's integration
  test suite after that plan's WASM rebuild
- `validate` integration tests for issue #13 examples: can run only after Unit 5 WASM
  rebuild; gate on `wasmExists`

## Context & Research

### Relevant Code and Patterns

**C++ — taxonomy bottom-node walk:**
- `src/KoncludeReasoner.cpp` — `buildPropertyTripleBuffer()` (lines 1241–1368) is the
  structural template for `buildUnsatisfiableClassBuffer()`: BFS from top node,
  sentinel guard on `bottomNode`, `nodeToIris` index, lex-min IRI representative
- `vendor/konclude/Source/Reasoner/Taxonomy/CTaxonomy.h` — `getBottomHierarchyNode()`,
  `getTopHierarchyNode()`, `getConceptHierarchyNodeHash()`
- `vendor/konclude/Source/Reasoner/Taxonomy/CHierarchyNode.h` — `getEquivalentConceptList()`,
  `isActive()`
- `CTaxonomy` access: `mImpl->mOntology->getConceptTaxonomy()`

**C++ — method plumbing chain:**
- `src/KoncludeReasoner.h` — add `std::string buildUnsatisfiableClassBuffer()` declaration
- `src/bindings.cpp` — add `.function("buildUnsatisfiableClassBuffer", &KoncludeReasoner::buildUnsatisfiableClassBuffer)`
- `ts/konclude.d.mts` — add `buildUnsatisfiableClassBuffer(): string` to the interface

**Worker dispatch:**
- `ts/worker.ts` — `handleMessage` switch; `"getUnsatisfiableClassBuffer"` case posts
  plain JS string (not `ArrayBuffer`) — no `HEAPU8.slice` needed; Emscripten marshals
  `std::string` return directly to JS string

**TypeScript — Phase 1 infrastructure to reuse:**
- `ts/index.ts` — `_callDirect(method, args)`, `_checkInconsistencyDirect(candidates)`,
  `_classifyInline(store, fingerprint)`, `_consistencyCache` slot
- `ts/index.ts` — `_opForPredicate` / `_opForAxiom` helpers (for `isSatisfiable` routing)
- `ts/index.ts` — `explain()` BlackBox loop (for `validate` warning justifications)
- `ts/index.ts` — `explainInconsistency()` (for `validate` error justifications)

**Types to add:**
- `ts/types.ts` — `ClassWarning`, `ValidationResult`, `ValidateOptions`

**Tests:**
- `tests/unit/RdfReasoner.store.test.ts` — existing unit test scaffolding
  (`makeReadyReasoner`, `simulateWorkerMessage`, `mockWorkerSequence`)
- `tests/integration/owl-dl-capabilities.test.ts` — integration test pattern
  (gate on `wasmExists`, 360 s timeout, shared `beforeAll` / `afterAll`)
- `tests/integration/consistency.test.ts` — `explainInconsistency` integration tests

### Institutional Learnings

- **Taxonomy walk stale-pointer guard** — key on `CHierarchyNode*` not `CConcept*`;
  guard every pointer lookup against `nodeToIris.count(ptr) == 0`; use lex-min IRI as
  representative. Source:
  `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- **`std::string` return format** — `buildUnsatisfiableClassBuffer` returns a
  newline-delimited IRI string; Emscripten marshals `std::string` directly to JS with
  no pointer plumbing required. Worker posts it as a plain string result.
- **WASM rebuild is mandatory** — after `make build-wasm`: `sudo chown -R $USER dist/`
  then `npm run patch-wasm` (strips `createRequire`, fixes pthread onerror) then
  `npm run build`. Patch step is never optional.
- **Sequential call safety** — `waitSynchronization()` barrier in
  `classification()`/`realization()` prevents inter-call races; do not remove or bypass.
  Source: `project_sequential_call_fix.md`
- **`_callDirect` vs `_call`** — only `_callDirect` is safe inside a `_queue.then()`
  body; calling public methods from inside the slot deadlocks.
- **`_consistencyCache` cross-invalidation** — `whatIf` and `explain` already
  invalidate all four caches. `_getUnsatisfiableClassesInternal` must update
  `_classifyCache` if it runs a fresh classification.

## Key Technical Decisions

- **`buildUnsatisfiableClassBuffer` returns `std::string`** (newline-delimited IRIs,
  not binary buffer): the IRI list is short (typically < 50), Emscripten marshals
  `std::string` directly to JS, and no binary protocol overhead is justified. Worker
  case posts the string directly without `HEAPU8.slice` or pointer indirection.
- **`_getUnsatisfiableClassesInternal` is a private non-queue-gated helper** — same
  pattern as `_classifyInline` / `_materializeInline`. Called from `validate()`'s
  queue slot and from the queue-gated `getUnsatisfiableClasses()` wrapper. Checks
  `_classifyCache` before issuing Worker calls.
- **`isSatisfiable` checks membership in the set returned by
  `_getUnsatisfiableClassesInternal`** — not a dedicated C++ path. If the class IRI
  is absent from the taxonomy entirely, returns `true` (open-world assumption).
- **`validate` errors vs warnings rationale** — *error* = ontology is globally
  inconsistent (no model exists); *warning* = a class is unsatisfiable in an otherwise
  consistent ontology. Inconsistent ontologies trivially make all classes unsatisfiable;
  callers should check `consistent` first.
- **`validate` with `maxJustificationsPerWarning: 0`** — skips `explain()` calls for
  warnings entirely; `warnings[i].justifications = []`. Avoids O(classes × BlackBox)
  cost for callers who only need the IRI list.
- **`owl:Nothing` IRI excluded from `getUnsatisfiableClasses` output** — `owl:Nothing`
  is always equivalent to itself in the taxonomy bottom node; it is not a useful signal.
  Skip it the same way `buildInferredTripleBuffer` already skips it for `subClassOf`.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Unit 5 — C++ layer
  buildUnsatisfiableClassBuffer()
    guard: !mClassified → return ""
    taxonomy = mOntology->getConceptTaxonomy()
    bottomNode = taxonomy->getBottomHierarchyNode()
    topNode    = taxonomy->getTopHierarchyNode()
    nodeHash   = taxonomy->getConceptHierarchyNodeHash()
    eqList     = bottomNode->getEquivalentConceptList()
    result = []
    for each CConcept* c in eqList:
      guard: nodeHash->contains(c) (stale-pointer guard)
      iri = CIRIName::getRecentIRIName(c->getClassNameLinker())
      skip if empty or == owl:Nothing
      result.push(iri)
    return join(result, '\n')

Unit 5 — Worker case
  "getUnsatisfiableClassBuffer":
    result = reasoner.buildUnsatisfiableClassBuffer()  // JS string
    postMessage({ id, result })

Unit 5 — TypeScript (private helper)
  _getUnsatisfiableClassesInternal(store):
    fingerprint = computeStoreFingerprint(store quads)
    if _classifyCache.hash != fingerprint:
      _callDirect("loadTripleBuffer", ...)
      _callDirect("classification", ...)
      _classifyCache = { hash, result }
    raw = await _callDirect("getUnsatisfiableClassBuffer", [])
    return (raw as string).split('\n').filter(Boolean)

Unit 5 — TypeScript (public wrappers, queue-gated)
  getUnsatisfiableClasses(store):
    _queue.then(async () => _getUnsatisfiableClassesInternal(store))
  isSatisfiable(store, classIRI):
    _queue.then(async () => {
      set = await _getUnsatisfiableClassesInternal(store)
      return !set.includes(classIRI)
    })

Unit 7 — validate (queue-gated, single slot)
  _queue.then(async () => {
    // Step 1: consistency
    fingerprint = computeStoreFingerprint(...)
    consistent  = _checkInconsistencyDirect or cache
    // Step 2: error justifications (if !consistent)
    errors = []
    if (!consistent):
      errors = BlackBox(owl:Thing subClassOf owl:Nothing, maxJustificationsPerError)
    // Step 3: unsatisfiable classes + warnings
    unsatIRIs = _getUnsatisfiableClassesInternal(store)
    warnings = []
    for iri of unsatIRIs:
      justs = maxJustificationsPerWarning > 0
        ? BlackBox(iri subClassOf owl:Nothing, maxJustificationsPerWarning)
        : []
      warnings.push({ classIRI: iri, justifications: justs })
    return { consistent, errors, warnings }
  })
```

## Implementation Units

- [ ] **Unit 1: `buildUnsatisfiableClassBuffer()` — C++ + bindings + worker case**

**Goal:** Add C++ method that walks the concept taxonomy's bottom node and returns all
unsatisfiable class IRIs as a newline-delimited string. Wire it through `bindings.cpp`,
`ts/konclude.d.mts`, and `ts/worker.ts`. Trigger the single WASM rebuild for this plan.

**Requirements:** R-F

**Dependencies:** None (C++ only; WASM rebuild required before Unit 2 can be written)

**Files:**
- Modify: `src/KoncludeReasoner.h` — declare `std::string buildUnsatisfiableClassBuffer()`
- Modify: `src/KoncludeReasoner.cpp` — implement `buildUnsatisfiableClassBuffer()`
- Modify: `src/bindings.cpp` — add `.function("buildUnsatisfiableClassBuffer", ...)`
- Modify: `ts/konclude.d.mts` — add `buildUnsatisfiableClassBuffer(): string`
- Modify: `ts/worker.ts` — add `"getUnsatisfiableClassBuffer"` case

**Approach:**

*`buildUnsatisfiableClassBuffer()` implementation:*
- Guard: `!mImpl->mClassified` → return `""`
- Fetch `CTaxonomy*` via `mImpl->mOntology->getConceptTaxonomy()`
- Fetch `CHierarchyNode* bottomNode = taxonomy->getBottomHierarchyNode()`
- Fetch `QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash()`
- Walk `bottomNode->getEquivalentConceptList()`: for each `CConcept* c`, apply stale-pointer
  guard (`!nodeHash->contains(c)` → skip); resolve IRI via `CIRIName::getRecentIRIName(c->getClassNameLinker())`; skip blank and `owl:Nothing` IRI
- Return newline-joined string of surviving IRIs

*Stale-pointer guard:* Same pattern as `buildInferredTripleBuffer()` TBox block (line ~848):
check concept presence in `nodeHash` before dereferencing. Concept-pointer may be from a
defunct merged-away node whose reverse edges were not updated.

*Worker case `"getUnsatisfiableClassBuffer"`:* Call `reasoner.buildUnsatisfiableClassBuffer()`;
post `{ id, result }` where `result` is the plain JS string. No `HEAPU8.slice` or buffer
transfer needed.

*After writing C++ and worker:* Run `make build-wasm` + `sudo chown -R $USER dist/` +
`npm run patch-wasm` + `npm run build`. Verify smoke test passes: `make smoke`.

**Patterns to follow:**
- `buildPropertyTripleBuffer()` in `src/KoncludeReasoner.cpp` — BFS/walk structure,
  sentinel guard on bottom/top nodes, `nodeToIris`-style hash guard
- `getPropertyTripleBuffer` Worker case — for the dispatch shape (minus buffer transfer)

**Test scenarios:**
- Happy path: smoke test after WASM rebuild passes (`make smoke`)
- Happy path: Worker `"getUnsatisfiableClassBuffer"` case receives the string and
  posts it as `result` (manual smoke or integration test)
- Edge case: called when `mClassified = false` → returns empty string; Worker posts `""`

**Verification:**
- `make smoke` passes after WASM rebuild
- `npm run build` compiles without TypeScript errors in `ts/worker.ts`

---

- [ ] **Unit 2: `getUnsatisfiableClasses(store)` and `isSatisfiable(store, classIRI)` TypeScript wrappers**

**Goal:** Add the private `_getUnsatisfiableClassesInternal(store)` helper and the two
public queue-gated wrappers. Export `getUnsatisfiableClasses` and `isSatisfiable` as
`RdfReasoner` methods.

**Requirements:** R-F

**Dependencies:** Unit 1 (WASM rebuild must be complete; `"getUnsatisfiableClassBuffer"` Worker case must exist)

**Files:**
- Modify: `ts/index.ts` — add `_getUnsatisfiableClassesInternal`, `getUnsatisfiableClasses`,
  `isSatisfiable`
- Test: `tests/unit/RdfReasoner.store.test.ts` — unit tests for both public methods
- Test: `tests/integration/owl-dl-capabilities.test.ts` — integration tests

**Approach:**

*`_getUnsatisfiableClassesInternal(store: Store): Promise<string[]>`* (private, not queue-gated):
- Compute fingerprint via `computeStoreFingerprint(store.getQuads(...))`
- If `_classifyCache?.hash !== fingerprint`: issue `_callDirect("loadTripleBuffer", ...)` +
  `_callDirect("classification", [])`; update `_classifyCache`
- Issue `_callDirect("getUnsatisfiableClassBuffer", [])`, cast result to `string`
- Return `result.split('\n').filter(Boolean)` — empty string yields `[]`

*`getUnsatisfiableClasses(store: Store): Promise<string[]>`* (public, queue-gated):
- Standard `_queue.then(async () => _getUnsatisfiableClassesInternal(store))` pattern

*`isSatisfiable(store: Store, classIRI: string): Promise<boolean>`* (public, queue-gated):
- Standard `_queue.then(async () => { const set = await _getUnsatisfiableClassesInternal(store); return !set.includes(classIRI); })`
- Class absent from taxonomy → `true` (open-world; not in the unsat set = satisfiable)

*Cache invalidation:* `_getUnsatisfiableClassesInternal` updates `_classifyCache` if it
runs a fresh classification. Cache cross-invalidation for `_materializeCache` and
`_classifyPropertiesCache` follows the same pattern as `_classifyInline`.

**Patterns to follow:**
- `_classifyInline` in `ts/index.ts` — same cache-check + `_callDirect` pattern
- `getUnsatisfiableClasses(store)` queue-gating mirrors `classifyProperties(store, opts)`

**Test scenarios:**
- Happy path (unit): `getUnsatisfiableClasses(store)` → Worker receives
  `"getUnsatisfiableClassBuffer"` after a fresh `"classification"` call; mock response
  `"http://ex.org/EmptyClass\nhttp://ex.org/Dead"` → method returns
  `["http://ex.org/EmptyClass", "http://ex.org/Dead"]`
- Happy path (unit): `getUnsatisfiableClasses(store)` called twice with same store →
  second call does not re-issue `"loadTripleBuffer"` (cache hit)
- Happy path (unit): `isSatisfiable(store, "http://ex.org/Bird")` where `"Bird"` is not
  in the unsat set → returns `true`
- Happy path (unit): `isSatisfiable(store, "http://ex.org/EmptyClass")` where it is in
  the unsat set → returns `false`
- Edge case (unit): `isSatisfiable(store, "urn:unknown:class")` → returns `true`
  (absent from taxonomy = satisfiable under open-world)
- Edge case (unit): `getUnsatisfiableClasses(store)` when mock returns `""` → returns `[]`
- Edge case (unit): `getUnsatisfiableClasses` and `classify` called with same store →
  separate queue slots; correct serialization
- Integration (wasmExists): `isSatisfiable(store, ":EmptyClass")` where `EmptyClass ⊑ owl:Nothing`
  declared → returns `false`
- Integration (wasmExists): `isSatisfiable(store, ":Bird")` for a satisfiable class → `true`
- Integration (wasmExists): `isSatisfiable(store, "urn:unknown")` for an IRI not in ontology → `true`
- Integration (wasmExists): `getUnsatisfiableClasses(store)` returns `[]` for an ontology
  with no unsatisfiable classes
- Integration (wasmExists): `getUnsatisfiableClasses(store)` returns the IRI of
  `EmptyClass ⊑ owl:Nothing` — does not include `owl:Nothing` itself
- Integration (wasmExists): `isSatisfiable` called before any prior classification →
  triggers classification internally; correct result returned

**Verification:**
- `npm test` passes, including new unit and integration tests
- Integration tests confirm `isSatisfiable(store, 'http://www.w3.org/2002/07/owl#Nothing')` returns `false`

---

- [ ] **Unit 3: `validate(store, opts?)` — high-level combined diagnostic API**

**Goal:** Add `validate(store, opts?)` returning `{ consistent, errors, warnings }`.
Combines consistency check + unsatisfiable-class detection + optional justifications in
a single queue slot.

**Requirements:** R-G

**Dependencies:** Unit 2 (`_getUnsatisfiableClassesInternal`), Phase 1 (`_checkInconsistencyDirect`, `explain` BlackBox helpers)

**Files:**
- Modify: `ts/types.ts` — add `ClassWarning`, `ValidationResult`, `ValidateOptions`
- Modify: `ts/index.ts` — add `validate` public method; re-export new types
- Test: `tests/unit/RdfReasoner.validate.test.ts` — new unit test file
- Test: `tests/integration/consistency.test.ts` — `validate` integration scenarios

**Approach:**

*Types to add to `ts/types.ts`:*
```
ClassWarning: { classIRI: string; justifications: Quad[][] }
ValidationResult: { consistent: boolean; errors: Quad[][]; warnings: ClassWarning[] }
ValidateOptions: { maxJustificationsPerError?: number; maxJustificationsPerWarning?: number; axiomFilter?: (q: Quad) => boolean }
```

*`validate(store: Store, opts?: ValidateOptions): Promise<ValidationResult>`* — queue-gated:
1. Compute fingerprint; check/run consistency via `_checkInconsistencyDirect` (same
   candidates as `explainInconsistency` — excludes inferred and hypothetical graphs);
   update `_consistencyCache`
2. If `!consistent`: run BlackBox loop for `owl:Thing rdfs:subClassOf owl:Nothing`
   (reusing `_checkEntailmentDirect` infrastructure from `explain`);
   `maxJustifications = opts.maxJustificationsPerError ?? 1`; collect into `errors`
3. Run `_getUnsatisfiableClassesInternal(store)` for the unsat IRI list
4. For each unsat IRI: if `opts.maxJustificationsPerWarning === 0`, push
   `{ classIRI, justifications: [] }` without BlackBox; otherwise run BlackBox for
   `<classIRI> rdfs:subClassOf owl:Nothing` with `maxJustifications = opts.maxJustificationsPerWarning ?? 1`;
   push result into `warnings`
5. Return `{ consistent, errors, warnings }`

*Queue ownership:* Entire method holds one `_queue` slot. All Worker calls use `_callDirect`.
Calling public methods (`explain`, `checkConsistency`, `getUnsatisfiableClasses`) from inside
is prohibited — use the private helpers only.

*Cache invalidation:* Invalidate all four caches before BlackBox iterations (same pattern as
`explainInconsistency`), because the BlackBox sub-calls modify WASM state.

**Patterns to follow:**
- `explainInconsistency` in `ts/index.ts` — outer queue slot + BlackBox pattern
- `_getUnsatisfiableClassesInternal` — for step 3
- `_checkInconsistencyDirect` — for step 1 consistency oracle

**Test scenarios:**
- Happy path (unit): `validate(store)` on consistent ontology with no unsat classes →
  `{ consistent: true, errors: [], warnings: [] }`
- Happy path (unit): `validate(store)` on inconsistent ontology → `consistent: false`,
  `errors` non-empty, Worker call sequence starts with `"loadTripleBuffer"` then
  `"classification"`
- Happy path (unit): `{ maxJustificationsPerError: 2 }` → `errors.length <= 2`
- Happy path (unit): `{ maxJustificationsPerWarning: 0 }` → `warnings[i].justifications = []`
  for each warning entry; no `explain`-related Worker calls for warnings
- Happy path (unit): `validate` on store with one unsat class → `warnings` contains one
  `ClassWarning` entry with matching `classIRI`
- Integration (wasmExists): `validate(store)` on `alice a Person, Organization;
  Person disjointWith Organization` → `consistent: false`, `errors.length >= 1`
- Integration (wasmExists): `validate(store)` on `EmptyClass ⊑ owl:Nothing` (consistent
  ontology) → `consistent: true`, `warnings` contains `EmptyClass` entry
- Integration (wasmExists): `validate(store)` followed immediately by `classify(store)` →
  `classify` completes without queue stall (regression check for slot release)
- Integration (wasmExists): `validate(store)` on each of the issue #13 inconsistency examples
  → `consistent: false` for all six; `errors` non-empty

**Verification:**
- `npm test` passes
- Integration: `validate` + `classify` sequential run completes without hang
- `ValidationResult`, `ClassWarning`, `ValidateOptions` re-exported from package entry point

---

- [ ] **Unit 4: README and API documentation updates**

**Goal:** Update the README to document all Phase 1 methods now on main (`isEntailed`,
`whatIf`, `explain`, `explainInconsistency`) and all Phase 2 additions (`isSatisfiable`,
`getUnsatisfiableClasses`, `validate`). Extend the "Common workflows" section with
recipes for each new capability.

**Requirements:** R-Doc

**Dependencies:** Unit 3 (all public methods must exist before documenting them)

**Files:**
- Modify: `README.md` — API reference, Common workflows section

**Approach:**

*API reference section — add to the `RdfReasoner` code block:*
```
// Entailment queries (post-reasoning)
const entailed = await reasoner.isEntailed(store, quad);
const results  = await reasoner.isEntailed(store, [quad1, quad2]);

// Hypothetical reasoning
const { added, removed } = await reasoner.whatIf(store, [newAxiom]);

// Explanation / justification
const justs = await reasoner.explain(store, quad, { maxJustifications: 3 });
const inconsJusts = await reasoner.explainInconsistency(store);

// Satisfiability
const classes = await reasoner.getUnsatisfiableClasses(store);
const ok      = await reasoner.isSatisfiable(store, "http://example.org/MyClass");

// Combined diagnostic
const report = await reasoner.validate(store);
// report.consistent, report.errors (Quad[][]), report.warnings (ClassWarning[])
```

*Options interfaces to add to the API reference:*
```
// isEntailed: no options
// whatIf
interface WhatIfOptions { removals?: Quad[]; outputGraph?: string; }
// explain / explainInconsistency
interface ExplainOptions { maxJustifications?: number; axiomFilter?: (q: Quad) => boolean; }
// validate
interface ValidateOptions {
  maxJustificationsPerError?: number;   // default: 1
  maxJustificationsPerWarning?: number; // default: 1
  axiomFilter?: (q: Quad) => boolean;
}
```

*Common workflows — new subsections to add after "Incremental ontology evolution":*

**Checking if a specific entailment holds (`isEntailed`)** — covers `rdfs:subClassOf`,
`rdf:type`, `rdfs:subPropertyOf`, object property assertions; returns `null` for
unsupported predicates. Show example with `rdf:type` after `materialize`.

**Hypothetical reasoning (`whatIf`)** — show store mutation guard (store unchanged),
`added`/`removed` delta, optional `outputGraph`. Note delta is relative to current
`INFERRED_GRAPH_IRI`.

**Explaining an entailment (`explain`)** — show `Quad[][]` result, `maxJustifications`,
note that `[]` means not entailed. Brief note on cost (BlackBox = multiple Worker calls).

**Diagnosing an inconsistency (`explainInconsistency`)** — show usage, note `[]` on
consistent ontology.

**Finding unsatisfiable classes (`getUnsatisfiableClasses`, `isSatisfiable`)** — show
both forms; note `owl:Nothing` excluded from output; note open-world on unknown classes.

**Full ontology validation (`validate`)** — show the return shape, mention
`maxJustificationsPerWarning: 0` for cheap IRI-only scan, note errors vs warnings
semantics.

**Test scenarios:**
- Test expectation: none — documentation change only

**Verification:**
- All code examples in added sections are syntactically correct TypeScript
- README renders correctly (no broken markdown)

## System-Wide Impact

- **Interaction graph:** `validate()` and `getUnsatisfiableClasses()` serialize on `_queue`
  alongside all existing public methods. `_getUnsatisfiableClassesInternal` runs only from
  within a held slot. No middleware or observers exist.
- **Error propagation:** Errors thrown within `validate`'s `_queue.then()` body propagate
  to the returned Promise; the error-swallowing tail preserves queue liveness for callers.
- **Cache invalidation:** `_getUnsatisfiableClassesInternal` updates `_classifyCache` when
  it runs a fresh classification. `validate`'s BlackBox iterations invalidate all four caches
  (same pattern as `explainInconsistency`).
- **API surface parity:** `ValidationResult`, `ClassWarning`, `ValidateOptions` must be added
  to the `export type {...}` barrel at the top of `ts/index.ts`.
- **Unchanged invariants:** `materialize()`, `classify()`, `classifyProperties()`, `explain()`,
  `explainInconsistency()` behavior is unchanged. `INFERRED_GRAPH_IRI` semantics unchanged.
- **WASM binary compatibility:** `buildUnsatisfiableClassBuffer` is additive; existing Embind
  bindings and Worker cases are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| WASM rebuild breaks `patch-wasm` patching | Run `npm run patch-wasm` immediately after `make build-wasm`; smoke-test with `make smoke` before full suite |
| Stale-pointer crash in bottom-node walk on production ontologies | Apply `nodeHash->contains(c)` guard exactly as in TBox walk; cover with integration test |
| `validate` on large inconsistent ontology with many unsat classes → O(classes × BlackBox) calls | Default `maxJustificationsPerWarning: 1` limits per-class cost; expose `maxJustificationsPerWarning: 0` for IRI-only mode |
| `_getUnsatisfiableClassesInternal` called from outside a queue slot | Private method convention; JSDoc note matching `_callDirect` prohibition |
| Issue #13 integration tests still failing for some cases (UAF in realizer) | Gate on `wasmExists`; document known-failing cases; do not block merge on them |
| Docker root-ownership of `dist/` after WASM rebuild | Always run `sudo chown -R $USER dist/` before `npm run build` |

## Documentation / Operational Notes

- Run `make build-wasm` once for this entire plan (Unit 1 is the only C++ change)
- Post-rebuild sequence: `sudo chown -R $USER dist/ && npm run patch-wasm && npm run build && npm test`
- Re-export `ValidationResult`, `ClassWarning`, `ValidateOptions` from `ts/index.ts` barrel
- README update (Unit 4) can be written any time but should be committed after Unit 3 is verified

## Sources & References

- **Origin document:** [docs/plans/2026-05-22-024-feat-axiom-work-api-plan.md](docs/plans/2026-05-22-024-feat-axiom-work-api-plan.md)
- Taxonomy walk pattern: `docs/solutions/logic-errors/getInferredNTriples-subclassof-over-materialization-2026-05-12.md`
- Threading architecture: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- Sequential-call fix: `project_sequential_call_fix.md`
- Emscripten pthread exit fix (patch-wasm): `docs/solutions/architecture-patterns/emscripten-pthread-exit-browser-fix-2026-05-13.md`
- Issue #13 test cases: [ontosphere #13](https://github.com/ThHanke/ontosphere/issues/13)
- Related plan (owl:sameAs, data properties — separate WASM rebuild): [docs/plans/2026-05-28-027-feat-abox-output-same-as-data-properties-plan.md](docs/plans/2026-05-28-027-feat-abox-output-same-as-data-properties-plan.md)
