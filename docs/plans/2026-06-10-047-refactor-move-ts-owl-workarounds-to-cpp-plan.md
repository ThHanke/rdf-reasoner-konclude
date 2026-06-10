---
title: "refactor: Move TypeScript OWL 2 DL workarounds into Konclude C++ source"
type: refactor
status: active
date: 2026-06-10
---

# refactor: Move TypeScript OWL 2 DL workarounds into Konclude C++ source

## Overview

The TypeScript wrapper (`ts/index.ts`) contains 6 OWL 2 DL workarounds that compensate
for gaps in the WASM reasoning kernel. These live in TypeScript for historical reasons —
they were added one by one as gaps were discovered — but they belong in the C++ layer
(`src/KoncludeReasoner.cpp`) so every API path (materialize, isEntailed, whatIf,
checkConsistency) benefits transparently.

This plan migrates all 6 workarounds into C++ and removes the corresponding TypeScript
preprocessing/postprocessing blocks.

## Problem Frame

Each workaround currently requires the TypeScript caller to:
1. Pre-process input quads before sending to WASM, OR
2. Post-process WASM output before returning to the caller

After migration each workaround lives entirely in:
- `loadTripleBuffer()` — for input pre-processing (flag detection, triple mutation)
- `buildInferredTripleBuffer()` — for output post-processing (synthesis of missing triples)
- `buildPropertyTripleBuffer()` — for property output post-processing
- A new helper in `Impl` — for storing intermediate results across the load→build pipeline

## Workaround Inventory

| # | Workaround | Current location | C++ target |
|---|---|---|---|
| 1 | FP/IFP sameAs pre-computation | `computeFpIfpPreprocessing()` + `mergeSameAsQuads()` | `loadTripleBuffer()` + `buildInferredTripleBuffer()` |
| 2 | someValuesFrom fixpoint | `buildSomeValuesFromIndex()` + `propagateSomeValuesFromFillers()` | `buildInferredTripleBuffer()` |
| 3 | disjointUnionOf expansion | `_classifyInline()` / `_classifyOnStore()` inline blocks | `buildInferredTripleBuffer()` |
| 4 | equivalentProperty bidirectional | `expandEquivPropInStore()` / `expandEquivPropInQuads()` | `buildPropertyTripleBuffer()` |
| 5 | differentFrom self-clash | `_materializeOnStore()` / `_materializeOnQuads()` | `loadTripleBuffer()` |
| 6 | complementOf named-class clash | `_materializeOnStore()` / `_materializeOnQuads()` | `loadTripleBuffer()` |

**Note on workarounds #5 and #6:** Grep for `differentFrom` and `complementOf` in
`ts/index.ts` — if they appear as active post-processing blocks, document their exact
logic before migrating. If they are already absent from the TypeScript (i.e., the issue
was fixed upstream), skip those units.

## Scope Boundaries

- Each unit produces working code + removes the corresponding TypeScript block.
- All units require a WASM rebuild (`make build-wasm`). Plan accordingly — group units
  before rebuilding where possible to amortize rebuild cost.
- Do not refactor `KoncludeReasoner.cpp` beyond what is needed for each unit.
- Do not change the binary wire protocol between TS and WASM.
- Known limitation not addressed here: single-filler FP+ABox still hangs (upstream C++
  threading bug). Unit 1 of this plan only migrates the multi-filler JS workaround.

## Key Context

- `loadTripleBuffer()` — `src/KoncludeReasoner.cpp:440`. Decodes binary buffer into a
  librdf model. Runs once per materialize/classify call. Good place for input scanning
  and flag setting.
- `buildInferredTripleBuffer()` — `src/KoncludeReasoner.cpp:845`. Walks the CTaxonomy
  and realization results and writes the output binary buffer. Good place for
  post-processing of inferred triples.
- `buildPropertyTripleBuffer()` — `src/KoncludeReasoner.cpp:1245`. Same format,
  property-specific. Handles rdfs:subPropertyOf output.
- `Impl` struct — `src/KoncludeReasoner.cpp:~line 320`. Add per-call state fields here
  (e.g., `std::vector<std::pair<std::string,std::string>> mFpIfpSameAsPairs`). Reset them
  in `reset()` (`src/KoncludeReasoner.cpp:412`).
- String intern table — `loadTripleBuffer()` decodes an intern table that maps integer
  IDs to IRI strings. This table (`mStrTable` or local var) is available during
  `loadTripleBuffer()` for scanning and is NOT available in `buildInferredTripleBuffer()`.
  Store any IRI strings you need in post-processing as `std::string` in `Impl` during load.
- After all units are complete and WASM is rebuilt: remove the corresponding TS helpers
  from `ts/index.ts` (`computeFpIfpPreprocessing`, `mergeSameAsQuads`,
  `buildSomeValuesFromIndex`, `propagateSomeValuesFromFillers`, `expandEquivPropInStore`,
  `expandEquivPropInQuads`).

## Implementation Units

Units are ordered by risk: pre-check flags first (#5/#6), trivial synthesis second (#4),
complex post-processing last (#1/#2/#3). Units 1–4 are C++ + TS cleanup; units 5–6 are
C++ only (no output synthesis needed). All require a single WASM rebuild.

---

- [ ] **Unit 1: FP/IFP — migrate computeFpIfpPreprocessing to C++**

**Goal:** `loadTripleBuffer()` detects multi-filler FP/IFP cases, computes sameAs pairs
in C++, strips the triggering declarations from the librdf model, and stores the computed
pairs in `Impl`. `buildInferredTripleBuffer()` appends the stored pairs to the output
buffer (deduplicated vs WASM-inferred triples).

**Dependencies:** None.

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove `computeFpIfpPreprocessing`, `mergeSameAsQuads` calls
  from `_materializeOnStore`, `_materializeOnQuads`, `_materializeInline`, `whatIf`)
- Test: `tests/integration/owl2dl-parity.test.ts` (existing FP/IFP tests must pass)

**Approach:**
During `loadTripleBuffer()`, after decoding all triples into the librdf model:
1. Scan for `owl:FunctionalProperty` and `owl:InverseFunctionalProperty` declarations.
2. For each FP prop: build `bySubject` map (prop IRI → subject → [objects]).
   For each IFP prop: build `byObject` map (prop IRI → object → [subjects]).
3. For FP: any subject with 2+ objects → add all-pairs sameAs to `mFpIfpSameAsPairs`,
   remove the FP declaration triple from the librdf model.
4. Same for IFP with symmetry reversed.
5. In `buildInferredTripleBuffer()`: after walking CTaxonomy/realization, append
   `mFpIfpSameAsPairs` triples to the output (dedup against already-emitted triples via
   a `std::set<tuple<int,int,int>>` of intern IDs, or a string-keyed set if IDs are
   not available at build time).

**Note:** The intern string table is decoded local to `loadTripleBuffer()`. To make
IRI strings available in `buildInferredTripleBuffer()`, store them in
`Impl::mFpIfpSameAsPairs` as `std::pair<std::string,std::string>` (subject/object IRI
pairs; predicate is always `owl:sameAs`).

**TS cleanup:** Remove `computeFpIfpPreprocessing()` and `mergeSameAsQuads()` functions
and their 4 call sites once the rebuilt WASM passes tests.

**Verification:** `npm test` — existing FP/IFP materialize tests + new isEntailed/whatIf
tests all pass. `npm run build` clean.

---

- [ ] **Unit 2: someValuesFrom fixpoint — migrate to buildInferredTripleBuffer()**

**Goal:** Native Konclude v0.7.0 does not propagate `rdf:type` to named individual
fillers of `owl:someValuesFrom` restrictions. `buildInferredTripleBuffer()` performs the
fixpoint propagation that currently lives in `propagateSomeValuesFromFillers()` in TS.

**Dependencies:** Unit 1 (establishes the Impl pattern for per-call state).

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove `buildSomeValuesFromIndex`, `propagateSomeValuesFromFillers`
  calls from `_materializeOnStore`, `_materializeOnQuads`, `_materializeInline`)
- Test: `tests/integration/owl2dl-parity.test.ts` (someValuesFrom parity tests)

**Approach:**
First, investigate whether native Konclude realization already emits filler types when
`someValuesFrom` is present (it may have been fixed in a later version). To test: comment
out the TS someValuesFrom post-processing and run the someValuesFrom tests. If they pass
natively, this unit becomes a TS cleanup only (no C++ needed). If they still fail:

1. During `loadTripleBuffer()`: scan for `owl:someValuesFrom` restriction triples
   (blank-node structure: `_:r owl:onProperty <P>; owl:someValuesFrom <C>`) and store
   a `mSomeValuesFromIndex: map<classIRI, vector<{property, fillerClass}>>` in `Impl`.
2. In `buildInferredTripleBuffer()`: after writing all WASM-inferred triples, run the
   same fixpoint loop as `propagateSomeValuesFromFillers()`, using the loaded librdf model
   for role assertions and the accumulated output buffer for type assertions.

**Caveat:** The blank-node scanning in C++ requires walking librdf triples, which is
available but verbose. Mirror the logic in `buildSomeValuesFromIndex()` in `ts/index.ts`
(lines ~119–165).

**TS cleanup:** Remove `buildSomeValuesFromIndex()`, `propagateSomeValuesFromFillers()`,
and their call sites once verified.

**Verification:** `npm test` — someValuesFrom parity tests pass. `npm run build` clean.

---

- [ ] **Unit 3: disjointUnionOf — migrate to buildInferredTripleBuffer()**

**Goal:** `C owl:disjointUnionOf (A B ...)` should yield `A rdfs:subClassOf C` and
`B rdfs:subClassOf C`. Currently synthesized in TypeScript classify paths. Move to
`buildInferredTripleBuffer()` (called after classification).

**Dependencies:** Unit 1 (Impl pattern).

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove disjointUnionOf synthesis blocks from `_classifyOnStore`,
  `_classifyOnQuads`, `_classifyInline`)
- Test: `tests/integration/owl2dl-parity.test.ts` (disjointUnionOf parity tests)

**Approach:**
1. During `loadTripleBuffer()`: scan for `<C> owl:disjointUnionOf <listHead>` triples.
   Walk each RDF list to collect member IRIs. Store in
   `Impl::mDisjointUnionMemberships: vector<pair<classIRI, memberIRI>>` in `Impl`.
2. In `buildInferredTripleBuffer()`: for each `(classIRI, memberIRI)` pair, emit
   `memberIRI rdfs:subClassOf classIRI` if not already in the output.

**Note:** `owl:disjointUnionOf` uses RDF list structure (blank nodes). The librdf model
has the blank nodes. Walk them with `librdf_model_get_target()` for `rdf:first` /
`rdf:rest` to collect list elements.

**TS cleanup:** Remove inline disjointUnionOf blocks from `_classifyOnStore`,
`_classifyOnQuads`, `_classifyInline` in `ts/index.ts`.

**Verification:** `npm test` — disjointUnionOf parity tests pass.

---

- [ ] **Unit 4: equivalentProperty — migrate to buildPropertyTripleBuffer()**

**Goal:** `p owl:equivalentProperty q` should yield `p rdfs:subPropertyOf q` and
`q rdfs:subPropertyOf p`. Currently in `expandEquivPropInStore()` and
`expandEquivPropInQuads()`. Move to `buildPropertyTripleBuffer()`.

**Dependencies:** None (independent of other units).

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove `expandEquivPropInStore`, `expandEquivPropInQuads` and
  their call sites from `_classifyPropertiesOnStore`, `_classifyPropertiesOnQuads`,
  `_classifyPropertiesInline`)
- Test: `tests/integration/owl2dl-parity.test.ts` (equivalentProperty parity tests)

**Approach:**
1. During `loadTripleBuffer()`: scan for `<p> owl:equivalentProperty <q>` triples and
   store pairs in `Impl::mEquivPropPairs: vector<pair<string,string>>`.
2. In `buildPropertyTripleBuffer()`: for each `(p, q)` pair, emit
   `p rdfs:subPropertyOf q` and `q rdfs:subPropertyOf p` if not already in output.
   Dedup using the same string-keyed set pattern used elsewhere.

**TS cleanup:** Remove `expandEquivPropInStore()`, `expandEquivPropInQuads()`, and call
sites from the three classify-properties paths.

**Verification:** `npm test` — equivalentProperty (classifyProperties) parity tests pass.

---

- [ ] **Unit 5: differentFrom self-clash — migrate to loadTripleBuffer()**

**Goal:** `x owl:differentFrom x` (or AllDifferent with x listed twice) is a direct
contradiction. Currently detected in TypeScript and handled as a pre-check. Move flag
detection to `loadTripleBuffer()` so `checkConsistency()` returns `false` immediately.

**Dependencies:** None.

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove differentFrom pre-check if present)

**Approach:**
1. Confirm the TS block exists (grep for `differentFrom` in `ts/index.ts`). If absent,
   this unit is already done — skip.
2. Add `bool mTriviallyInconsistent = false` to `Impl`, reset in `reset()`.
3. In `loadTripleBuffer()`: scan for any `<x> owl:differentFrom <x>` triple (same
   subject and object). Also scan `owl:AllDifferent` lists for duplicate members.
   Set `mTriviallyInconsistent = true` if found.
4. In `consistency()`: check `mTriviallyInconsistent` before calling WASM pipeline;
   return `false` immediately if set.

**Verification:** `npm test` — differentFrom self-clash consistency tests pass.

---

- [ ] **Unit 6: complementOf clash — migrate to loadTripleBuffer()**

**Goal:** `C owl:complementOf C` is unsatisfiable. Detected in TS as a pre-check. Move
to C++ so all call paths benefit.

**Dependencies:** Unit 5 (reuses `mTriviallyInconsistent` flag).

**Files:**
- Modify: `src/KoncludeReasoner.cpp`
- Modify: `ts/index.ts` (remove complementOf pre-check if present)

**Approach:**
1. Confirm the TS block exists (grep for `complementOf` in `ts/index.ts`). If absent,
   this unit is already done — skip.
2. In `loadTripleBuffer()`: scan for `<C> owl:complementOf <C>` (subject == object).
   Set `mTriviallyInconsistent = true` if found.

**Verification:** `npm test` — complementOf clash tests pass.

---

## WASM Rebuild Strategy

All units require `make build-wasm` (20–30 min). Batch to minimize rebuilds:

| Batch | Units | When to rebuild |
|-------|-------|----------------|
| A | 4, 5, 6 | After completing all three |
| B | 1, 2, 3 | After completing all three |

Unit 4 is independent; units 5+6 share the `mTriviallyInconsistent` flag; units 1+2+3
all touch `loadTripleBuffer()` + the inferred buffer builder. Batching reduces rebuilds
from 6 to 2.

After each batch rebuild: run `npm run patch-wasm` (required after every WASM rebuild),
then `npm test`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Unit 1 C++ dedup in buildInferredTripleBuffer is expensive | Build a simple `std::set<std::string>` from intern IDs during buffer walk; amortized O(n log n) |
| Unit 2 someValuesFrom already fixed natively | Check natively first; if passes, unit becomes TS cleanup only |
| librdf list-walking in Unit 3 is verbose/fragile | Mirror the TS `expandRdfList()` logic exactly; it is well-tested |
| `mStrTable` not available in buildInferredTripleBuffer | Store needed IRIs as `std::string` in Impl fields during loadTripleBuffer |

## Verification

Full suite: `npm test` (328 passing baseline after this plan's prerequisite is merged).
`npm run build` clean after each TS cleanup.
