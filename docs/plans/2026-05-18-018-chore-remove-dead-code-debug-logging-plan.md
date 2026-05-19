---
title: "chore: Remove dead code and debug logging overhead from WASM port"
type: refactor
status: active
date: 2026-05-18
---

# chore: Remove dead code and debug logging overhead from WASM port

## Overview

Three worker message handlers in `ts/worker.ts` survive from the original string-based
protocol but are never invoked by `ts/index.ts` (which uses the binary protocol exclusively).
Twenty-six `fprintf(stderr, ...)` calls in three C++ files fire unconditionally in
production, generating tens of thousands of log lines per `classify()` call. Both issues
accumulate technical debt and runtime overhead with no production benefit.

## Problem Frame

`ts/index.ts` sends exactly four worker messages: `loadTripleBuffer`, `classify`,
`isConsistent`, `getInferredTripleBuffer`. Three others remain from the original
design: `loadNTriples`, `getInferredNTriples`, and `reset`. Their unit tests,
type declarations, and C++ implementations are still present. Smoke and bench scripts
bypass the worker and call the dead C++ methods directly.

The `{thread}` logging in `src/compat/overrides/CThread.cpp` fires on every single
thread event — wait, wake, postEvent, event-done — producing thousands of `fprintf`
syscalls per classification run. `{stpu}` logging in `CSingleThreadTaskProcessorUnit.cpp`
adds more. Both were scaffolding from the sequential classify() hang fix (plan-015) and
have no production value. The `{info}/{dbg}` calls in `KoncludeReasoner.cpp` are useful
for performance triage but should be opt-in.

## Requirements Trace

- R1. Worker handles only the four live message types; dead cases and their unit tests removed.
- R2. Smoke and bench scripts use the binary protocol, not the dead string API.
- R3. `loadNTriples` and `getInferredNTriples` removed from C++ and bindings after all callers migrated.
- R4. `{thread}` and `{stpu}` `fprintf` calls removed from C++ overrides entirely.
- R5. `{info}/{dbg}` calls in `KoncludeReasoner.cpp` guarded behind `WASM_VERBOSE_LOGGING` compile flag.
- R6. `npm test` passes throughout; no behaviour change for `ts/index.ts` or integration tests.

## Scope Boundaries

- No changes to `ts/index.ts` or its callers.
- No worker architecture redesign (that is a separate future plan).
- `{warn}` null-pointer guard in `KoncludeReasoner.cpp` (line 373) is NOT guarded — it signals invalid usage.
- LUBM and Roberts bench/fixture regeneration: out of scope.

### Deferred to Separate Tasks

- Broader worker reinvention (message protocol versioning, error model, teardown) — future plan.

## Context & Research

### Relevant Code and Patterns

- Live binary input path: `ts/worker.ts` `loadTripleBuffer` case (lines 118–139) — reference for `_malloc`, `HEAPU8.set`, pointer passing.
- Live binary output path: `ts/worker.ts` `getInferredTripleBuffer` case (lines 153–169) — reference for `buildInferredTripleBuffer` + `getInferredTripleBufferPtr` + slice copy.
- Serialization helpers already in `ts/index.ts` (private `_serializeQuads` / `_deserializeBuffer`) — do not duplicate; bench scripts should instead use a shared thin helper or the `RdfReasoner` high-level class.
- Dead worker input case: `ts/worker.ts` `loadNTriples` (line 110) and `getInferredNTriples` (line 149).
- Dead unit tests: `tests/unit/worker.test.ts` mocks `loadNTriples` and `getInferredNTriples`; several `it` blocks exercise those paths.
- Type declaration: `ts/konclude.d.mts` — exposes both dead methods as typed surface.
- Bench scripts call WASM methods directly (no worker), so they need the binary helpers at the WASM level, not the `RdfReasoner` level.
- `tests/bench/wasm-runner.mjs` — existing pattern for constructing a WASM module in Node.

### Institutional Learnings

- `docs/solutions/`: CThread.cpp `{thread}` logging was added as a timing/correctness aid during the sequential classify hang fix; it is no longer required now that the fix is verified.
- WASM rebuild is ~25 min; ccache is effective for incremental rebuilds but cannot skip the linker step.
- `KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED` is already defined in `src/CMakeLists.txt` — the pattern for compile-time suppression is established.

## Key Technical Decisions

- **Binary helper module for bench/smoke**: Extract a small `tests/bench/wasm-binary.mjs` helper that wraps the `_malloc`/`HEAPU8` encode and `buildInferredTripleBuffer`/`getInferredTripleBufferPtr` decode. Bench and smoke scripts import it rather than duplicating the logic. Keeps the bench scripts readable without pulling in the full `RdfReasoner` class.
- **Guard, not remove, KoncludeReasoner.cpp `{info}` calls**: These are valuable for performance triage. `WASM_VERBOSE_LOGGING` is the opt-in flag; not defined in CMakeLists by default.
- **Remove, not guard, CThread + STPU logging**: No diagnostic value once the hang fix is confirmed. Removal is cleaner than a flag nobody will ever set.
- **Batch all C++ changes into one rebuild** (Unit 3): Dead method removal + `{thread}` removal + `{stpu}` removal + KoncludeReasoner guard are all low-risk and independent. One rebuild is cheaper than three.
- **Unit ordering**: TS/JS first (Units 1–2), C++ rebuild last (Unit 3). TS changes are instantly verifiable; the rebuild is the expensive gate.

## Open Questions

### Resolved During Planning

- **Should `reset` worker case be removed?** Yes — `ts/index.ts` never sends `"reset"`. The `r.reset()` call *inside* `loadTripleBuffer` stays; only the external message handler is removed.
- **Can bench scripts use `RdfReasoner` directly instead of raw WASM?** Possible but changes the bench semantics — they currently measure raw WASM overhead without worker/serialization overhead. Keep raw WASM access; use the shared binary helper.

### Deferred to Implementation

- Whether timing.mjs and wasm-runner.mjs should split serialization overhead into a separate timing phase — low priority, leave as implementer judgement.

---

## Implementation Units

- [ ] **Unit 1: Remove dead TS worker paths, unit tests, and stale types**

**Goal:** Delete the three dead worker message cases, their unit tests, and the stale type declarations and comments that reference the old string protocol.

**Requirements:** R1, R6

**Dependencies:** None.

**Files:**
- Modify: `ts/worker.ts` — remove `loadNTriples`, `getInferredNTriples`, and `reset` cases; remove stale JSDoc/comments that reference those flows
- Modify: `tests/unit/worker.test.ts` — remove `loadNTriples` and `getInferredNTriples` mock definitions, `mockClear` calls, and `it` blocks that test those paths
- Modify: `ts/konclude.d.mts` — remove `loadNTriples()` and `getInferredNTriples()` method declarations
- Modify: `ts/index.ts` — remove stale comments referencing `loadNTriples → classify → getInferredNTriples` flow

**Approach:**
- The `reset` message handler (`destroyReasoner()`) is removed; the `r.reset()` call inside the `loadTripleBuffer` handler body is retained.
- After removal, the `default` case will catch any stale `"loadNTriples"` or `"getInferredNTriples"` messages and return `Unknown method` — correct behaviour.
- Run `npm run build` after edits to catch type errors early; run `npm test` to confirm no regressions.

**Patterns to follow:** Existing live handlers (`loadTripleBuffer`, `getInferredTripleBuffer`) as the reference shape.

**Test scenarios:**
- Happy path: `loadTripleBuffer → classify → getInferredTripleBuffer` round-trip unit test still passes unmodified.
- Happy path: `classify → isConsistent` unit test still passes unmodified.
- Edge case: Sending `"loadNTriples"` to the worker now returns `{ error: "Unknown method: loadNTriples" }` (hits the `default` case).
- Regression: All integration tests pass after `npm run build && npm test`.

**Verification:** `npm test` exits 0. `ts/worker.ts` has no `case "loadNTriples"`, `case "getInferredNTriples"`, or `case "reset"` blocks. `ts/konclude.d.mts` no longer declares `loadNTriples` or `getInferredNTriples`.

---

- [ ] **Unit 2: Migrate smoke test and bench scripts to binary protocol**

**Goal:** Replace all `loadNTriples` / `getInferredNTriples` calls in smoke and bench scripts with the binary protocol, using a shared helper module.

**Requirements:** R2, R6

**Dependencies:** Unit 1 (dead methods removed from type declarations, so type errors surface immediately if missed).

**Files:**
- Create: `tests/bench/wasm-binary.mjs` — thin binary encode/decode helpers for direct WASM use
- Modify: `tests/smoke/smoke.mjs`
- Modify: `tests/bench/dump-outputs.mjs`
- Modify: `tests/bench/debug-galen.mjs`
- Modify: `tests/bench/timing.mjs`
- Modify: `tests/bench/wasm-runner.mjs`

**Approach:**
- `wasm-binary.mjs` exposes two functions:
  - `encodeTriplesForWasm(mod, ntriples)` → `{ triplePtr, tripleCount, strTablePtr, strBytes }`: parses NTriples string, builds intern table, `_malloc`s two buffers, copies into `HEAPU8`, returns pointers. Caller must `_free` both pointers.
  - `decodeWasmTripleBuffer(mod, reasoner)` → NTriples string: calls `reasoner.buildInferredTripleBuffer()`, reads from `HEAPU8` at `reasoner.getInferredTripleBufferPtr()`, decodes the string table + triple IDs, returns NTriples.
- Each bench/smoke script: replace `r.loadNTriples(str)` with `encode → r.loadTripleBuffer(...ptrs) → free`, and replace `r.getInferredNTriples()` with `decodeWasmTripleBuffer(mod, r)`.
- Reference implementation: `ts/worker.ts` lines 118–169 shows the exact `_malloc`/`HEAPU8`/`_free` pattern.

**Technical design:** *(Directional — not implementation specification)*
```
// wasm-binary.mjs sketch:
encodeTriplesForWasm(mod, ntriplesString):
  parse ntriplesString → [{s, p, o}, ...]
  build internTable: string → uint32
  tripleBuffer = Uint32Array([s0,p0,o0, s1,p1,o1, ...])
  strTableBuffer = encodeStringTable(internTable)
  triplePtr = mod._malloc(tripleBuffer.byteLength)
  strTablePtr = mod._malloc(strTableBuffer.byteLength)
  mod.HEAPU8.set(new Uint8Array(tripleBuffer.buffer), triplePtr)
  mod.HEAPU8.set(strTableBuffer, strTablePtr)
  return { triplePtr, tripleCount, strTablePtr, strBytes }

decodeWasmTripleBuffer(mod, reasoner):
  len = reasoner.buildInferredTripleBuffer()
  if len == 0: return ""
  ptr = reasoner.getInferredTripleBufferPtr()
  buf = mod.HEAPU8.slice(ptr, ptr + len)
  decode string table + triples → NTriples string
```

**Patterns to follow:** `ts/worker.ts` `loadTripleBuffer` case (lines 118–139) for encode; `getInferredTripleBuffer` case (lines 153–169) for decode.

**Test scenarios:**
- Happy path: `tests/smoke/smoke.mjs` runs to completion and prints the expected triple count (same as before migration).
- Happy path: `tests/bench/dump-outputs.mjs` produces output files with the same triple counts as before.
- Edge case: Empty ontology (0 triples input) — `decodeWasmTripleBuffer` returns empty string without crash.
- Regression: Smoke test output validates the same substrings it checked before.

**Verification:** `node tests/smoke/smoke.mjs` exits 0 and prints expected output. All bench scripts run without error. No `loadNTriples` or `getInferredNTriples` calls remain in `tests/`.

---

- [ ] **Unit 3: Batch C++ cleanup + WASM rebuild**

**Goal:** Remove `loadNTriples` and `getInferredNTriples` from C++; remove all `{thread}` and `{stpu}` `fprintf` calls; guard `{info}/{dbg}` calls in `KoncludeReasoner.cpp` behind `WASM_VERBOSE_LOGGING`. One rebuild covers all changes.

**Requirements:** R3, R4, R5, R6

**Dependencies:** Unit 2 (all callers of `loadNTriples`/`getInferredNTriples` migrated).

**Files:**
- Modify: `src/KoncludeReasoner.cpp` — remove `loadNTriples` implementation; wrap all `{info}/{dbg}` `fprintf` calls (except the `{warn}` null-pointer guard at line 373) with `#ifdef WASM_VERBOSE_LOGGING … #endif`
- Modify: `src/KoncludeReasoner.h` — remove `loadNTriples()` and `getInferredNTriples()` declarations
- Modify: `src/bindings.cpp` — remove `.function("loadNTriples", ...)` and `.function("getInferredNTriples", ...)` bindings
- Modify: `src/compat/overrides/CThread.cpp` — delete all 10 `fprintf(stderr, "{thread} ...")` calls
- Modify: `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` — delete all 7 `fprintf(stderr, "{stpu} ...")` calls
- (No change to `src/CMakeLists.txt` — `WASM_VERBOSE_LOGGING` is off by default, pass via `-DWASM_VERBOSE_LOGGING` at configure time when needed)

**Approach:**
- Remove `{thread}` and `{stpu}` calls entirely — no flag, just delete. They served a specific debugging purpose that is now resolved.
- `{warn}` null-pointer fprintf at line 373 is retained as-is (error condition, always relevant).
- After all edits: `docker compose run --rm build` → `npm run patch-wasm` → `npm test`.

**Patterns to follow:** `KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED` in `src/CMakeLists.txt` as the precedent for compile-time suppression flags.

**Test scenarios:**
- Happy path: `npm test` exits 0 after rebuild — all integration and unit tests pass.
- Regression: GALEN TBox strict `assertExactMatch` still passes (representative-IRI fix from plan-017 intact).
- Regression: Roberts ABox `assertExactMatch` still passes.
- Regression: Sequential stability test passes (no hang regression from removing {stpu} logging).
- Edge case: Build with `-DWASM_VERBOSE_LOGGING` compiles without warning and emits `{info}` lines to stderr at runtime.
- Execution note: `{thread}` and `{stpu}` lines must be absent from test stderr output after rebuild.

**Verification:** `npm test` exits 0. `grep -r "fprintf.*{thread}" src/compat/overrides/CThread.cpp` returns empty. `grep -r "fprintf.*{stpu}" src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` returns empty. `grep "loadNTriples\|getInferredNTriples" src/bindings.cpp` returns empty.

---

## System-Wide Impact

- **Unchanged invariants:** `ts/index.ts` and all integration tests are untouched — the binary protocol path is unchanged throughout.
- **API surface parity:** `loadNTriples` and `getInferredNTriples` are removed from `ts/konclude.d.mts` — any downstream consumer importing that type file will get a compile error. This is intentional; those methods are not part of the public `RdfReasoner` API.
- **Performance:** Removing tens of thousands of `fprintf` syscalls per classify run is expected to reduce wall-clock time, most visibly for large ontologies like GALEN. The `timing.mjs` bench can confirm.
- **Unchanged invariants (logging):** The `{warn}` null-pointer guard survives. The `LOG(ERROR, ...)` calls in `CThread.cpp` (lines 228, 232) routed through Konclude's CLogger survive — only the `fprintf` scaffolding is removed.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bench script binary encode has subtle differences from the worker path (e.g. string table format) | Compare output triple counts between old and new bench runs before removing old code |
| Removing {stpu} fprintf causes a hidden timing side-effect on semaphore behaviour | Sequential stability test and consistency tests cover this; 5 consistency tests must still pass |
| One WASM rebuild (Unit 3) is the rate-limiting step | All C++ changes batched into one commit; no incremental rebuilds |
| `getInferredNTriples` still referenced in a file we missed | `grep -rn "getInferredNTriples\|loadNTriples" ts/ tests/ scripts/` clean after Unit 2 confirms readiness for Unit 3 |

## Sources & References

- Dead code inventory: [[project-worker-cleanup-debt]] memory entry
- Binary encode pattern: `ts/worker.ts` lines 118–169
- Logging scaffolding origin: plan-015 (sequential classify hang fix)
- Existing compile suppression precedent: `src/CMakeLists.txt` line 248 (`KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED`)
</content>
