---
title: "fix: Add destructors for CombinedNeighbourRoleSetCacheLabelData and RoleInstancesItem hash leaks"
type: fix
status: active
date: 2026-10-01
---

# fix: Add destructors for CombinedNeighbourRoleSetCacheLabelData and RoleInstancesItem hash leaks

## Overview

Two Realizer classes accumulate heap allocations across sequential `classify()`/`realize()` calls that are never freed: `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData` (no destructor) and `COptimizedKPSetRoleInstancesItem` (destructor exists but omits three owned members). Fixing these closes the last known LEAK sites in the Realizer layer identified by the 2026-10-01 destructor audit.

## Problem Frame

Full destructor audit of all `COptimized*` classes in `vendor/konclude/Source/Reasoner/Realizer/` found 5 leak sites across 2 classes. All other classes are CLEAN or SHARED. RSS growth of ~41 MB per 3 sequential calls (mini-family fixture) is at least partly attributable to these leaks.

Prior patches 058–066 already fixed precomputation/classifier/realizer item containers and hash-data classes. This plan covers the two remaining classes.

## Requirements Trace

- R1. `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData` must free its `mKnownInstancesLabelItemsData` and `mPossibleInstancesLabelItemsData` hash values on destruction.
- R2. `COptimizedKPSetRoleInstancesItem` destructor must free `mCombinedNeighbourLabelDataHash` values, `mInverseCombinedNeighbourLabelDataHash` values, and `mComplexIndiCandidateIterator`.
- R3. 574/575 tests continue to pass after both patches.
- R4. No double-free: leaf class `COptimizedKPSetRoleInstancesSingleNeighbourRoleSetCacheLabelData` holds only an aliased cache pointer — safe to `delete` from parent destructor.

## Scope Boundaries

- Only add destructor bodies; no other behavioral changes.
- No WASM rebuild required — patches apply at CMake configure time.
- Does not address the deferred async-audit CThreads or any leak outside the Realizer layer.

## Context & Research

### Relevant Code and Patterns

- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData.h` L81–82 — the two leaking hash members
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData.cpp` — no destructor present
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp` L34–36 — existing destructor (only frees `mIndividualIdComplexRoleDataHash`)
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.h` L363–364, L381 — the three omitted members
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesSingleNeighbourRoleSetCacheLabelData.h` L74 — single aliased pointer; no heap members of its own
- Pattern to follow: patches 064–066 — hash-value iteration destructors in the same Realizer layer

### Institutional Learnings

- Konclude lifecycle paradigm: free stale items at START of next call or in destructor, never at finish (memory/project_ontology_lifetime_singleton_cache).
- `mComplexIndiCandidateIterator` is initialized to `nullptr` in `initInstancesItem` (line 63) — `delete nullptr` is safe per C++ standard.
- Graphify must be used to verify topology before writing any C++ patch (feedback/graphify_before_saturation_patches). Already done this session: both classes confirmed in graphify before audit findings were finalized.

### Patch Workflow

- Tool: `scripts/new-multi-file-patch.sh <NNN> <name> <mod-script.py>`
- Mod script receives `vendor/konclude` root, calls `modify(path, content) -> str` per file.
- Next patch numbers: **067** (Fix 1) and **068** (Fix 2).
- After generating both patches: `make reset-patches` to verify clean application.

## Key Technical Decisions

- **Fix 1 before Fix 2**: `COptimizedKPSetRoleInstancesItem` destructor will `delete` values from `mCombinedNeighbourLabelDataHash` and `mInverseCombinedNeighbourLabelDataHash`, which triggers the destructor of `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData`. That destructor must exist before Fix 2 patch is written and tested.
- **Separate patches**: two discrete patches keep the git history auditable and make `make reset-patches` bisection easier.
- **No header-only destructor**: declare in `.h`, define in `.cpp` — consistent with prior patches in this layer.

## Open Questions

### Resolved During Planning

- **Is `mComplexIndiCandidateIterator` always `nullptr`-inited?** Yes — `initInstancesItem` sets it to `nullptr` at line 63 of `.cpp`. Safe to unconditionally `delete`.
- **Are `mCombinedNeighbourLabelDataHash` values shared across multiple owners?** No — graphify and code review confirm each `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData*` is inserted once into one of the two hashes in `COptimizedRepresentativeKPSetOntologyRealizingThread.cpp` (line 281 pattern). No double-ownership.
- **Does `COptimizedKPSetRoleInstancesSingleNeighbourRoleSetCacheLabelData` have heap members of its own?** No — only `mSingleNeighbourRoleSetCacheLabelItem` (aliased cache pointer) and primitive fields. Safe to delete.

### Deferred to Implementation

- Exact RSS improvement measurement — requires a full run of the memory fixture after patching; not predictable from static analysis.

## Implementation Units

- [ ] **Unit 1: patch-067 — destructor for COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData**

  **Goal:** Add a destructor that frees `mKnownInstancesLabelItemsData` and `mPossibleInstancesLabelItemsData` hash values.

  **Requirements:** R1, R4

  **Dependencies:** Patches 001–066 applied (sentinel `vendor/konclude/.patches-applied` present)

  **Files:**
  - Modify (via patch): `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData.h`
  - Modify (via patch): `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData.cpp`
  - Create: `patches/067-combined-neighbour-label-data-destructor.patch`
  - Create: `scripts/mods/067-combined-neighbour-label-data-destructor.py`

  **Approach:**
  - Mod script modifies `.h`: add `~COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData();` declaration in public section.
  - Mod script modifies `.cpp`: add destructor definition that iterates both hashes and `delete`s each value pointer.
  - Run `scripts/new-multi-file-patch.sh 067 combined-neighbour-label-data-destructor scripts/mods/067-...py`.

  **Patterns to follow:**
  - `patches/064-realizing-item-cache-label-hash-destructors.patch` — same pattern (QHash pointer-value destructor iteration)
  - `patches/065-cache-label-item-data-destructors.patch`

  **Test scenarios:**
  - Happy path: 574/575 tests pass after applying patch 067 alone (no new failures).
  - Edge case: ontology with no role instances — both hashes empty at destruction, no crash.

  **Verification:**
  - `make reset-patches` completes without error.
  - `npm test` output saved to `/tmp/vitest-full-output.txt`; grep shows no new `FAIL` lines vs baseline.

---

- [ ] **Unit 2: patch-068 — extend COptimizedKPSetRoleInstancesItem destructor**

  **Goal:** Free the three owned members omitted from the existing destructor: `mCombinedNeighbourLabelDataHash` values, `mInverseCombinedNeighbourLabelDataHash` values, and `mComplexIndiCandidateIterator`.

  **Requirements:** R2, R3

  **Dependencies:** Unit 1 (patch-067 applied — `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData` destructor must exist before its values are deleted here)

  **Files:**
  - Modify (via patch): `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp`
  - Create: `patches/068-role-instances-item-destructor-extend.patch`
  - Create: `scripts/mods/068-role-instances-item-destructor-extend.py`

  **Approach:**
  - Mod script targets `.cpp` only (destructor declaration already exists in `.h` at line 74; no `.h` change needed).
  - Replace the existing destructor body (currently only the `mIndividualIdComplexRoleDataHash` loop) with the expanded body that also iterates both combined-neighbour hashes and deletes the iterator.
  - `delete mComplexIndiCandidateIterator` is last — safe because it is `nullptr`-init'd and the iterator has no dependency on the hash data.
  - Run `scripts/new-multi-file-patch.sh 068 role-instances-item-destructor-extend scripts/mods/068-...py`.

  **Patterns to follow:**
  - Existing destructor at `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp` L34–36 — extend, do not replace the existing loop.
  - `patches/061-realizer-instances-item-destructors.patch` — prior destructor extension for same class family.

  **Test scenarios:**
  - Happy path: 574/575 tests pass after applying patches 067+068.
  - Happy path: sequential `classify()` + `realize()` calls do not crash (no double-free).
  - Edge case: role item destroyed mid-traversal (iterator not at end) — iterator deleted without crash.
  - Edge case: role item with empty `mCombinedNeighbourLabelDataHash` and empty `mInverseCombinedNeighbourLabelDataHash` — `for` loops iterate zero times, no crash.

  **Verification:**
  - `make reset-patches` completes without error.
  - Full test suite: `npm test` → `/tmp/vitest-full-output.txt`; no new `FAIL` lines.
  - Optional: RSS growth measurement with mini-family fixture shows reduction from ~41 MB baseline.

## System-Wide Impact

- **Interaction graph:** `COptimizedRepresentativeKPSetOntologyRealizingThread` creates and inserts all instances of both types; the destructor path is only called when the owning `COptimizedKPSetRoleInstancesItem` is deleted (part of `mRoleInstancesItemContainer` teardown in `COptimizedRepresentativeKPSetOntologyRealizingItem` destructor).
- **Error propagation:** No error propagation path — these are destructors. Crash on double-free would surface as a test failure.
- **State lifecycle risks:** Shared-pointer invariant for `mInstanceItemData` (patch 066's successor-only pattern) is not affected — different hash type and different class hierarchy.
- **Unchanged invariants:** `mIndividualIdComplexRoleDataHash` cleanup in the existing `COptimizedKPSetRoleInstancesItem` destructor is preserved verbatim; the patch only appends new `delete` calls.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData*` pointer shared across two owners | Graphify + code review confirmed single-owner insertion; no shared-pointer pattern present |
| `mComplexIndiCandidateIterator` deleted while still in active use by a thread | Iterator lifecycle: set to `nullptr` in `initInstancesItem`, set non-null only during single-threaded post-classify traversal; item destruction only happens in reset path after traversal completes |
| Patch fails to apply cleanly after future upstream update | Patches are minimal (destructor body only); low context dependency; `make reset-patches` will error early if context shifts |

## Sources & References

- Audit session (2026-10-01): full verdict table in conversation context
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp` L34–36
- `vendor/konclude/Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData.h` L81–82
- Graphify node: `realizer_coptimizedkpsetroleinstancesitem_coptimizedkpsetroleinstancesitem` (degree 191, community: Role Instance Candidates)
- Graphify node: `realizer_coptimizedkpsetroleinstancescombinedneighbourrolesetcachelabeldata_...` (degree 19, community: Realized Individual Item Linker)
- Prior patches: `064`, `065`, `066` (same destructor pattern in adjacent classes)
