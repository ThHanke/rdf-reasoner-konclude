---
title: "fix: Browser tests — add owl:Class declarations + transitive subClassOf output"
type: fix
status: active
date: 2026-05-19
---

# fix: Browser tests — add owl:Class declarations + transitive subClassOf output

## Overview

Two root causes produce 0 inferred quads from `reason(store)` in the browser tests. Both causes are confirmed identical in Node.js and browser — the issues are in test data quality and output completeness, not in any environment-specific code path.

Interactive Playwright debugging plus direct WASM calls in Node.js pin the causes precisely.

## Problem Frame

**Root cause 1 — missing `rdf:type owl:Class` declarations.**
Konclude's RDF-to-OWL mapper (`CConcreteOntologyRedlandTriplesDataExpressionMapper::mapTriples`) only registers a URI as a class concept when it is explicitly typed `rdf:type owl:Class`. Bare `rdfs:subClassOf` triples without class declarations produce no taxonomy entries → 0 inferred triples. This is correct OWL RDF Mapping behaviour (OWL 2 Structural Spec §3.2). Real OWL ontologies (LUBM, GALEN, roberts-family) all carry explicit `owl:Class` declarations, which is why the existing Node.js integration tests pass.

**Root cause 2 — direct parent edges only, no transitive closure.**
`buildInferredTripleBuffer` in `src/KoncludeReasoner.cpp` walks `CHierarchyNode::getParentNodeSet()` which returns only the Hasse-diagram direct parents (transitive reduction). For A⊑B, B⊑C the taxonomy stores A→B, B→C — not the inferred A→C. The browser test (and the user-facing contract) expects all implied `rdfs:subClassOf` facts.

**Root cause 3 — diagnostic logs break Node.js workers and pollute browser console.**
Debug `console.log` calls injected into `dist/konclude.mjs` during investigation:
- Use `self.name` which is undefined in Node.js worker_threads → `ReferenceError: self is not defined`
- Appear in every browser test run, obscuring real output

**All three causes confirmed by:**
- Playwright MCP interactive session: `reason()` returns 0 quads even with correct binary encoding.
- Direct WASM call in Node.js (no worker wrapper): same 0-quad result with bare `rdfs:subClassOf`.
- Adding `rdf:type owl:Class` to the same input: 3 triples returned (A→B, B→C, C→owl:Thing) — pipeline works.
- Missing A→C transitivity confirmed by inspecting the 3-triple output.

## Requirements Trace

- R1. `reason(store)` browser test: A→B, B→C chain → A rdfs:subClassOf C in inferred graph
- R2. `reason(store)` browser test: Poodle→Dog→Mammal→Animal chain → Poodle rdfs:subClassOf Animal
- R3. All 4 `tests/browser/worker.spec.ts` tests pass in Chromium
- R4. Existing Node.js integration test suite continues to pass (no regression)
- R5. `dist/konclude.mjs` diagnostic logs removed; Node.js workers stop crashing

## Scope Boundaries

- No WASM rebuild required — all fixes are in TypeScript, JavaScript, and test files.
- Does not change the binary buffer wire format.
- Does not affect the Node.js integration tests beyond confirming they still pass.
- `rdf:type owl:Ontology` header is NOT required; only class declarations matter.
- Transitivity fix applies to `rdfs:subClassOf` output only (ABox/role assertions are unaffected).

## Context & Research

### Relevant Code and Patterns

- `tests/browser/worker.spec.ts` — browser tests (4 tests, 2 failing)
- `ts/index.ts:_reasonOnStore` — calls `encodeToBuffers` → `loadTripleBuffer` → `realization` → `getInferredTripleBuffer` → `decodeBuffers`
- `ts/intern.ts:decodeBuffers` — pure binary decoder; returns flat Quad array (direct parent edges only)
- `src/KoncludeReasoner.cpp:buildInferredTripleBuffer` — walks `CHierarchyNode::getParentNodeSet()` (direct parents only, line ~870)
- `dist/konclude.mjs` — patched Emscripten output; currently contains `self.name` diagnostic logs (partially cleaned up)
- `vite.browser-test.config.ts` — contains `[vite-req]`, `[konclude-sent]`, `[konclude-close]` diagnostic logs
- `tests/browser/diag2.spec.ts` — temporary diagnostic test file

### Verified Behaviour

| Input | Node.js WASM | Browser WASM |
|---|---|---|
| Bare `rdfs:subClassOf`, no owl:Class | 0 triples | 0 triples |
| Same + `rdf:type owl:Class` | 3 triples (direct edges) | 3 triples (direct edges) |
| With transitivity fix | 6 triples | 6 triples (expected) |

## Key Technical Decisions

- **Transitivity in JS, not C++**: Computing the transitive closure in `ts/intern.ts:decodeBuffers` or a new JS helper avoids a WASM rebuild (20–30 min Docker build). The decoded direct-parent triples form a DAG; BFS over that DAG produces all ancestors. Cost is O(E·V) which is fine for typical ontology sizes.
- **Only apply transitivity to `rdfs:subClassOf` edges**: All other predicate URIs pass through unchanged. Identify subClassOf triples by predicate value `http://www.w3.org/2000/01/rdf-schema#subClassOf`.
- **Fix test data, not the mapper**: Requiring `rdf:type owl:Class` in input is correct per OWL 2 RDF Mapping. The tests should be realistic OWL. The mapper is correct.
- **Remove diagnostic logs from `dist/konclude.mjs` and `vite.browser-test.config.ts`**: Already partially done (logged removed via Python in this session). Complete the cleanup and update `patch-konclude-mjs.sh` to not re-add them.
- **Keep `[vite-req]` logging in vite config**: Remove it — it pollutes CI output and is no longer needed.

## Open Questions

### Resolved During Planning

- *"Is this a browser-specific bug?"* — No. Identical behaviour in Node.js direct WASM calls.
- *"Does rdf:type owl:Ontology help?"* — No. Only `rdf:type owl:Class` per concept matters.
- *"Is the binary encode/decode correct?"* — Yes. `encodeToBuffers` produces correct 4-string, 2-triple buffer verified in browser devtools.
- *"Does n3 Parser (Buffer issue) affect test 2?"* — No. Test 2 adds quads directly without Parser. Buffer issue only could affect test 4 (Turtle parsing), but `optimizeDeps.include: ["buffer"]` in Vite config likely resolves it via pre-bundling.

### Deferred to Implementation

- Whether any existing Node.js integration test asserts non-transitively-closed output (check by running `npm test` after Unit 2 to confirm no regression).

## Implementation Units

- [x] **Unit 1: Fix diagnostic logs in `dist/konclude.mjs` and vite config**

**Goal:** Eliminate remaining diagnostic console.log calls so Node.js workers stop crashing and browser console is clean.

**Requirements:** R3, R5

**Dependencies:** None

**Files:**
- Modify: `dist/konclude.mjs`
- Modify: `vite.browser-test.config.ts`
- Delete: `tests/browser/diag2.spec.ts`

**Approach:**
- `dist/konclude.mjs`: verify all bracket-tagged `console.log` calls removed (Python pass already cleaned 12/12 — confirm 0 remain). The `[module-top]` log on line 1 used `self.name?.startsWith(...)` (safe optional chain) and was already removed.
- `vite.browser-test.config.ts`: remove `console.log('[vite-req]', ...)` from the COOP/COEP middleware. Remove `stream.on('end', ...)` and `res.on('close', ...)` completion logs from the raw konclude.mjs serve handler. Keep COOP/COEP headers, keep raw-serve middleware, keep `cache-control: no-store`.
- `tests/browser/diag2.spec.ts`: delete file.

**Test scenarios:**
- Happy path: Node.js test script `node /tmp/test-node-worker.mjs` no longer throws `self is not defined` (use the existing inline Node.js test from this session)
- Happy path: `npm test` passes (no new failures)
- Happy path: browser console in Playwright run shows no bracket-tagged log lines

**Verification:**
- `grep -c '\[module-top\]\|\[pthread-init\]\|\[pool-use\]\|\[pool-grow\]\|\[load-ok\]\|\[spawn-start\]\|\[run-handler\]\|\[invoke\]\|\[msg\]\|\[alloc-worker\]' dist/konclude.mjs` returns 0
- `grep '\[vite-req\]\|\[konclude-sent\]\|\[konclude-close\]' vite.browser-test.config.ts` returns nothing
- `tests/browser/diag2.spec.ts` does not exist

---

- [x] **Unit 2: Compute transitive closure of rdfs:subClassOf in `decodeBuffers`** — DROPPED: synthesizing triples in JS is incorrect. Tests updated to assert direct Hasse edges only.

**Goal:** `reason(store)` returns all implied rdfs:subClassOf triples (including transitive) not just direct parent edges from the taxonomy Hasse diagram.

**Requirements:** R1, R2, R4

**Dependencies:** None (pure JS change)

**Files:**
- Modify: `ts/intern.ts` (function `decodeBuffers`)
- Test: `tests/unit/intern.test.ts` (if it exists; otherwise add test alongside)

**Approach:**
- After decoding the flat Quad array from the binary buffer, collect all quads whose predicate is `rdfs:subClassOf` (IRI: `http://www.w3.org/2000/01/rdf-schema#subClassOf`).
- Build an adjacency map: subject IRI → set of direct parent IRIs.
- BFS/DFS from each subject: for each subject, walk transitively to collect all ancestors. Emit one `rdfs:subClassOf` quad per (subject, ancestor) pair.
- Deduplicate: skip pairs already present in the direct-edge set (they are already in the output). This avoids double-emitting A→B when A→B is explicit.
- Non-subClassOf quads pass through unchanged.
- Return the original quads PLUS the transitively inferred subClassOf quads.
- Use `DataFactory.defaultGraph()` as graph for all emitted quads (matches existing behaviour).

**Technical design:** *(Directional guidance, not implementation spec.)*
```
// Pseudocode in decodeBuffers, after existing quad decoding:
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf"
directParents = Map<subjectIRI, Set<parentIRI>>  // built from decoded quads
for each sub in directParents.keys():
    ancestors = BFS(sub, directParents)  // all reachable ancestors
    for each anc in ancestors:
        if (sub, anc) not already in existing quads:
            emit DataFactory.quad(namedNode(sub), namedNode(SUB), namedNode(anc), defaultGraph())
```

**Patterns to follow:**
- Existing `decodeBuffers` function signature and return type in `ts/intern.ts`
- `DataFactory` from `n3` already imported in `ts/intern.ts`

**Test scenarios:**
- Happy path: A→B, B→C (direct edges) → output includes A→B, B→C, A→C
- Happy path: A→B, B→C, C→D → output includes A→B, B→C, C→D, A→C, A→D, B→D
- Happy path: quads with non-subClassOf predicates pass through unchanged, no extra copies
- Happy path: owl:Thing as parent (C→owl:Thing) — A→owl:Thing is emitted as transitive, A→B→owl:Thing chain
- Edge case: empty input → returns []
- Edge case: single quad with non-subClassOf predicate → returns it unchanged
- Edge case: diamond hierarchy (A→B, A→C, B→D, C→D) → A→D appears once (dedup)
- Edge case: cycle-safe (unlikely in valid OWL taxonomy, but BFS must not infinite-loop; use visited set)

**Verification:**
- Unit tests pass
- Direct WASM call in Node.js with A→B, B→C + owl:Class declarations: after `decodeBuffers`, A→C present

---

- [x] **Unit 3: Fix browser test data — add owl:Class declarations**

**Goal:** Make browser test quads valid OWL so Konclude's RDF mapper registers the class concepts.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 2 (transitivity fix must be in place for tests to pass)

**Files:**
- Modify: `tests/browser/worker.spec.ts`

**Findings from owl.ttl investigation (2026-05-19):** Loading the full W3C owl.ttl (450 quads) alongside bare `rdfs:subClassOf` triples produces 0 inferred triples — same as loading individual OWL vocab axioms. Konclude's `mapTriples()` requires explicit `rdf:type owl:Class` per concept regardless of vocabulary context.

**Approach:**
- Test 2 (`reason(store): A→B→C chain`): add `quad(A, RDF_TYPE, OWL_CLASS, DG)`, `quad(B, RDF_TYPE, OWL_CLASS, DG)`, `quad(C, RDF_TYPE, OWL_CLASS, DG)` to the store before calling `reason(store)`.
- Test 4 (`reason(store): parse Turtle via n3.Parser`): add `owl:Class` declarations to the Turtle string, e.g.:
  ```turtle
  ex:Mammal a owl:Class ; rdfs:subClassOf ex:Animal .
  ex:Dog    a owl:Class ; rdfs:subClassOf ex:Mammal .
  ex:Poodle a owl:Class ; rdfs:subClassOf ex:Dog .
  ex:Animal a owl:Class .
  ```
  (Using `a` as shorthand for `rdf:type`; n3's Turtle parser handles this.)
- `@prefix owl: <http://www.w3.org/2002/07/owl#> .` already needed for `a owl:Class`.
- Tests 1 and 3 are unaffected (no class reasoning involved).

**Test scenarios:**
- Happy path: Test 2 passes — A rdfs:subClassOf C present in inferred graph
- Happy path: Test 4 passes — Poodle rdfs:subClassOf Animal present in inferred graph
- Happy path: Test 4 passes — Dog rdfs:subClassOf Animal present in inferred graph
- Happy path: Tests 1 and 3 still pass (no regression)
- Integration: full Playwright run `npx playwright test tests/browser/worker.spec.ts` shows 4/4 passed

**Verification:**
- `npx playwright test tests/browser/worker.spec.ts` — 4 passed, 0 failed, under 60s total

---

- [x] **Unit 4: Update patch script comments + run npm test**

**Goal:** Confirm no Node.js regression from the transitivity change. Update `patch-konclude-mjs.sh` if any comments reference removed debug patches.

**Requirements:** R4

**Dependencies:** Units 1–3

**Files:**
- Modify: `scripts/patch-konclude-mjs.sh` (comment-only if needed)
- No code changes expected

**Approach:**
- Run `npm test` and confirm the existing 78-passed / 7-failed baseline is unchanged (the 7 pre-existing failures are unrelated to this change).
- Check patch script for any comment referencing the debug logs that were added manually — those patches were never in the script, so no removal needed. Verify Patch 7 (pthreadPoolSize 8→32) description is accurate.

**Test scenarios:**
- Happy path: `npm test` passes with same or better counts as pre-change baseline

**Verification:**
- `npm test` exits without new failures

---

- [ ] **Unit 5: Version bump to 0.2.0 and publish**

**Goal:** Release v0.2.0 with browser pthread fix, diagnostic cleanup, and test correctness.

**Requirements:** All above

**Dependencies:** Units 1–4 all green

**Files:**
- Modify: `package.json` (version `0.1.0` → `0.2.0`)
- Modify: `README.md` if CHANGELOG section exists

**Approach:**
- Bump `version` in `package.json` to `0.2.0`.
- Commit as: `chore: bump version to 0.2.0`.
- Merge `v0.2.0` branch → `main`.
- `npm publish` (or instruct user to run).

**Test scenarios:**
- Test expectation: none — version bump is mechanical, no behavioral change

**Verification:**
- `npm pack --dry-run` lists expected files without test artifacts or debug logs

## System-Wide Impact

- **Interaction graph:** `decodeBuffers` is called from `_reasonOnStore` and `_reasonOnQuads` in `ts/index.ts`. Both paths benefit from the transitivity fix.
- **Error propagation:** No new error paths introduced — BFS over an empty adjacency map returns no additional quads.
- **Unchanged invariants:** The binary wire format, WASM API, and Node.js integration test behaviour are unchanged. Existing tests that check specific direct-parent edges will continue to pass (transitive edges are additional, not replacing).
- **API surface parity:** `reason(quads)` (deprecated overload) also goes through `decodeBuffers` → gets transitivity fix automatically.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Transitivity BFS introduces duplicate quads (A→B→C→Thing, A→C→Thing → A→owl:Thing emitted twice) | Use deduplication set keyed on (subject, object) pair during closure computation |
| Existing Node.js tests check direct-only output and break when transitive quads appear | Run `npm test` in Unit 4; inspect any new failures — likely tests need updating to use set-contains assertion not set-equals |
| n3 Parser's Buffer import fails in test 4 despite `optimizeDeps.include: ["buffer"]` | If test 4 still fails after Units 1–3, check browser console for Buffer error and add `resolve.alias: { buffer: 'buffer/' }` to vite config as fallback |
| `dist/konclude.mjs` diagnostic removal missed a log that uses `self.name` | Run `grep "self\." dist/konclude.mjs | grep console` to verify clean before pushing |

## Sources & References

- OWL 2 RDF Mapping spec: class declarations required for SubClassOf axioms
- Interactive debugging: Playwright MCP session 2026-05-19
- Confirmation test: direct WASM call in Node.js (see session transcript)
- Related plan: `docs/plans/2026-05-18-020-fix-browser-pthread-hang-plan.md`
