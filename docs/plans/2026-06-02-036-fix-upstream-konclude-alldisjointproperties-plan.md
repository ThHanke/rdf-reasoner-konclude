---
title: "fix: upstream Konclude — AllDisjointProperties + EquivalentObjectProperties inconsistency detection"
type: fix
status: complete
date: 2026-06-02
---

# fix: upstream Konclude — AllDisjointProperties + EquivalentObjectProperties inconsistency detection

## Overview

Native Konclude v0.7.0 fails to detect inconsistency for an ontology that declares
`DisjointObjectProperties(p, q)` + `EquivalentObjectProperties(p, q)` + any ABox assertion
`p(a, b)`. The correct OWL 2 DL answer is inconsistent. Both native and WASM return consistent.
This is the last remaining `checkConsistency()` parity gap (case 10 in
`tests/integration/issue13-owl-violations.test.ts`).

## Problem Frame

`EquivalentObjectProperties(p, q)` ≡ `SubObjectPropertyOf(p, q) ∧ SubObjectPropertyOf(q, p)`.
`DisjointObjectProperties(p, q)` says no pair `(x, y)` can be related by both `p` and `q`.
Together: any assertion `p(a, b)` implies `q(a, b)` (via equivalence), and having both
`p(a, b)` and `q(a, b)` contradicts disjointness. The inconsistency is straightforward.

The root cause follows the same structural pattern as the AsymmetricProperty / IrreflexiveProperty
bugs fixed in plan-035: the saturation algorithm either does not detect the clash directly, or sets
`INDSATFLAGINSUFFICIENT` (not `INDSATFLAGCLASHED`) on the nominal individual's saturation node.
The backend cache then writes `CompletelyHandled=true`, causing the completion algorithm's full
clash detection to be bypassed.

### What research has confirmed

- `BETEQUIVALENTOBJECTPROPERTIES` handler in `CConcreteOntologyUpdateBuilder.cpp` (lines 1695–1707)
  stores equiv roles in `CRole::mInverseEquivalentRoles` via `addEquivalentRoleLinker()`. It does
  NOT create `SubObjectPropertyOf` links directly.
- `BETDISJOINTOBJECTPROPERTIES` handler (lines 1708–1720) stores disjoint roles in
  `CRole::mDisjointRoles` via `addDisjointRoleLinker()`. These two lists are separate.
- **Hypothesis A confirmed by code analysis**: `addEquivalentRoleLinker()` (builder line 1704) does
  NOT call `addSuperRoleLinker()`. `addIndirectSuperRoles` (preprocessor line 226) uses
  `getSuperRoleList()` — not the equivalent role list. Therefore `q` is definitively NOT in
  `p->getIndirectSuperRoleList()` after `EquivalentObjectProperties(p, q)` is processed. Hypothesis B
  is ruled out. Unit 1 need only verify the BackendAssCache write path.
- **`mInverseEquivalentRoles` stores both equivalent and inverse roles**: entries with `isNegated=false`
  are equivalent roles; entries with `isNegated=true` are inverse roles. Any iteration over
  `getEquivalentRoleList()` must filter `!isNegated()` to avoid false positives on inverse roles.
- In the saturation's `createRoleAssertionLink` (line 5020–5026), the code already iterates
  `role->getIndirectSuperRoleList()` — but since `q` is not in that list, it never finds `q`'s
  disjoint constraint. The fix must add an explicit equivalent-role check.
- The completion algorithm's `createIndividualNodeDisjointRolesLinks` and
  `installIndividualNodeRoleLinkReapplied` appear theoretically correct — they would detect the
  clash IF the full tableau is reached. The bug is upstream: the backend cache marks alice as
  `CompletelyHandled=true` because no `INDSATFLAGCLASHED` was set.

### Root cause (confirmed)

**Hypothesis A** is correct. `q` is NOT in `p->getIndirectSuperRoleList()`. The saturation's
`createRoleAssertionLink` loop never encounters `q` as a super-role, never checks `q`'s disjoint
list. The saturation marks alice as `CompletelyHandled=true` unchecked. The fix adds an explicit
check in `initializeRoleAssertions`: iterate `role->getEquivalentRoleList()` with `!isNegated()`
filter, check each equivalent role's disjoint list, and if a clash is found call
`updateDirectAddingIndividualStatusFlags(indiProcSatNode, INDSATFLAGCLASHED, calcAlgContext)`.

## Requirements Trace

- R1. `checkConsistency()` returns inconsistent for an ontology with `DisjointObjectProperties(p, q)`,
  `EquivalentObjectProperties(p, q)`, and any ABox assertion `p(a, b)`. Also covers the n-ary case:
  `AllDisjointProperties(p, q, r)` + `EquivalentObjectProperties(p, q)` + `alice p bob` →
  inconsistent (the pairwise builder mapping means the 2-property fix naturally covers this).
- R2. All existing 233 tests continue to pass (no regression)
- R3. Test case 10 in `tests/integration/issue13-owl-violations.test.ts` promoted from
  `UPSTREAM_LIMITATION` to PARITY
- R4. Upstream bug documentation updated

## Scope Boundaries

- Only `checkConsistency()` path — no change to `classify()`, `materialize()`, or
  `classifyProperties()` output
- Only object properties — data property disjoint/equivalent reasoning out of scope
- `AllDisjointProperties` (n-ary, n>2): in scope only if the 2-property case fix naturally
  covers it; do not add a separate n-ary path unless unit testing reveals a gap
- FunctionalProperty ALIF+ hang (Bug 2): out of scope
- materialize() hangs: out of scope

### Deferred to Separate Tasks

- Opening upstream PRs against `konclude/Konclude`: separate task once fix is validated in WASM

## Context & Research

### Relevant Code and Patterns

- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp` lines 1695–1720 —
  `BETEQUIVALENTOBJECTPROPERTIES` and `BETDISJOINTOBJECTPROPERTIES` handlers; the two lists are
  stored separately (`mInverseEquivalentRoles` vs `mDisjointRoles`).
- `vendor/konclude/Source/Reasoner/Preprocess/CSubroleTransformationPreProcess.cpp` —
  `collectInverseEquivalentRoles()` (unconfirmed: may add equiv roles as super-roles) and
  `addIndirectSuperRoles()` (confirmed: builds `getIndirectSuperRoleList()` from super-role list only).
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  lines 5020–5026 in `createRoleAssertionLink` — iterates `getIndirectSuperRoleList()` and checks
  for disjoint super-roles; calls `setInsufficientNodeOccured()` if found.
- Same file, `initializeRoleAssertions` (line 5068–5157) — where plan-035 patches landed; confirms
  this is the right insertion point for saturation-level ABox clash detection.
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
  `createNewIndividualsLinks` (lines 22207–22243) and `createIndividualNodeDisjointRolesLinks`
  (lines 20237–20266) — completion algorithm clash detection; theoretically correct if reached.
- `tests/fixtures/issue13/case10-all-disjoint-properties.owl` — the test fixture:
  `DisjointObjectProperties(p, q)` + `EquivalentObjectProperties(p, q)` + `alice p bob`.

### Institutional Learnings

- **plan-035 pattern**: The fix for AsymmetricProperty and IrreflexiveProperty (plan-035 patch 028)
  used `INDSATFLAGCLASHED` in `initializeRoleAssertions` to prevent the backend cache from writing
  `CompletelyHandled=true`. The same pattern likely applies here.
- **BackendAssCache 2-phase**: Saturation backend cache writes `CompletelyHandled=true` when the
  nominal individual's saturation node has no INDSATFLAGINSUFFICIENT or INDSATFLAGCLASHED in its
  indirect flags. Only `INDSATFLAGCLASHED` reliably blocks this write.
- **Patch workflow**: edit `vendor/konclude/` → `git -C vendor/konclude diff > patches/NNN-name.patch`
  → `git -C vendor/konclude checkout .`. Next available slot: **029**.
- **Sentinel must be deleted before rebuild**: `rm vendor/konclude/.patches-applied` required before
  `docker compose run --rm build` when new patches are added.
- **`AllDisjointProperties` mapper**: maps to same builder code as `DisjointObjectProperties`; no
  mapper-level gap expected.

### External References

- OWL 2 DL specification: `EquivalentObjectProperties(p, q)` ≡ `SubObjectPropertyOf(p, q)` ∧
  `SubObjectPropertyOf(q, p)`
- OWL 2 DL specification: `DisjointObjectProperties(p, q)` requires `(p)^OP ∩ (q)^OP = ∅`
- OWL 2 RL rules: `prp-eqp1` (`EquivalentProperty(p,q) ∧ p(x,y) → q(x,y)`) +
  `prp-pdw` (`DisjointProperty(p,q) ∧ p(x,y) ∧ q(x,y) → false`)

## Key Technical Decisions

- **Fix in `initializeRoleAssertions` (confirmed)**: Hypothesis A is confirmed by code analysis.
  The fix is in `initializeRoleAssertions` (same file and function as plan-035 patch 028), not in
  `createRoleAssertionLink`. After the forward `assRoleLinkerIt` role assertion link creation (~line
  5100), add a loop over `role->getEquivalentRoleList()` with `!isNegated()` filter, checking each
  equivalent role's disjoint list. On match, set `INDSATFLAGCLASHED` on `indiProcSatNode`.

- **`initializeRoleAssertions` forward loop is the insertion point**: Two loops exist (forward
  `assRoleLinkerIt` and reverse `reverseAssRoleLinkerIt`). The check must go inside the forward
  loop where `role` is bound. Match the insertion location of plan-035 patch 028 (~line 5101).

- **`!isNegated()` filter is required**: `getEquivalentRoleList()` returns `mInverseEquivalentRoles`
  which stores both equivalent roles (`isNegated=false`) and inverse roles (`isNegated=true`). Without
  the filter, the check would fire for `InverseObjectProperties(p, q)` + `DisjointObjectProperties(p, q)`,
  producing a false inconsistency.

- **Fix in saturation, not preprocessor or completion**: The preprocessor fix is more invasive.
  The saturation fix is localized and mirrors the plan-035 pattern.

- **Single patch 029**: One patch file for one fix location. If Unit 1 reveals two separate
  code sites need changing, two patch files are used (following the 025/026 precedent).

## Open Questions

### Resolved During Planning

- **Is the mapper/builder axiom registration correct?** Yes — `AllDisjointProperties` maps to
  `getDisjointObjectProperties()` in the mapper (line 406 of the mapper file), which calls
  `addDisjointRoleLinker()` for each pair in the builder. No mapper gap.
- **Is the test fixture correct?** Yes — `case10-all-disjoint-properties.owl` has the right
  structure (`DisjointObjectProperties(p,q)` + `EquivalentObjectProperties(p,q)` + `alice p bob`).
- **Is `AllDisjointProperties` (n-ary) handled separately?** No — it maps to pairwise
  `DisjointObjectProperties` in the builder.

### Deferred to Implementation — Resolved by Unit 1

- **Exact insertion point** (confirmed): `CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`,
  inside `initializeRoleAssertions`, **after line 5130** (end of the self-loop/irreflexive block), before
  line 5131 (`} else if (!othIndiNode)`). The context at that point:

  ```cpp
  5097:   createRoleAssertionLink(indiProcSatNode, othIndiNode, role, false, calcAlgContext);
  5098:   indiProcSatNode->addRoleAssertion(othIndiNode, role, false);
  5099:   createRoleAssertionLink(othIndiNode, indiProcSatNode, role, true, calcAlgContext);
  5100:   othIndiNode->addRoleAssertion(indiProcSatNode, role, true);
  5101:   if (othIndiNode != indiProcSatNode && role->isAsymmetric()) { ... }  // asymmetric check
  5115:   if (othIndiNode == indiProcSatNode) { ... }                         // irreflexive check (lines 5115–5130)
  5131:   } else if (!othIndiNode) {                                          // ← INSERT BEFORE THIS
  ```

  All required variables are in scope: `role` (CRole*), `indiProcSatNode` (CIndividualSaturationProcessNode*),
  `calcAlgContext`, and `othIndiNode` (for the `othIndiNode != indiProcSatNode` guard if needed).
  `resolveNode` is also in scope (set at lines 5080–5085 before the forward loop).

- **BackendAssCache path confirmed**: The CLASHED flag prevents `CompletelyHandled=true` via an
  **early-return guard at line 612**, not via the `hasInsufficientFlag()` check at line 1471 in the
  handler itself:

  ```cpp
  // CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp line 612:
  if (indStatFlags->hasClashedFlag()) {
      return;  // ← skips tryAssociateNodesWithBackendCache() at line 616 entirely
  }
  mBackendAssCaceHandler->tryAssociateNodesWithBackendCache(...);
  ```

  The BackendAssCache handler's own `insufficient` check at line 1471 only gates on
  `hasInsufficientFlag() || !hasCompletedFlag()` — it does NOT check CLASHED. The CLASHED gate
  is upstream: the entire cache-write call is skipped when any analysed individual node has the
  CLASHED indirect flag. This applies identically whether the flag was set by the plan-035 patch
  (AsymmetricProperty, IrreflexiveProperty) or the new equivalent-role disjoint check. The
  completion algorithm also directly uses CLASHED at lines 16450, 21676, 21758, 22082, 26911 to
  short-circuit into clash exception handling.

- **`resolveNode` in scope**: Yes — assigned at lines 5080–5085 before the forward loop begins.
  The null-guard (`if (resolveNode)`) pattern from plan-035 is available, but is not needed for
  the equivalent-role disjoint check (which does not use `resolveNode`).

- **`getEquivalentRoleList()` returns `mInverseEquivalentRoles`** (confirmed):
  `CRole.cpp` line 319–321. The same field is used by `addEquivalentRoleLinker()` (line 248–255,
  `isNegated=false`) and `addInverseRoleLinker()` (line 212–219, `isNegated=true`). The
  `!isNegated()` filter is confirmed correct and necessary. `CRole::hasEquivalentRole(CRole*)` and
  `CRole::hasInverseRole(CRole*)` both iterate `mInverseEquivalentRoles` with the negation flag as
  the discriminator.

- **`isNegated()` semantics confirmed**: equivalent role linkers → `isNegated=false` (added by
  `addEquivalentRoleLinker()` which does not set the negated bit); inverse role linkers →
  `isNegated=true` (added by `addInverseRoleLinker()` which uses a negated linker).

- **API for disjoint check**: `CRole::hasDisjointRole(CRole* role)` exists (declared `CRole.h`
  line 154). Use this instead of iterating `getDisjointRoleList()` manually. The fix in Unit 2
  can call `eqRole->hasDisjointRole(role)` directly.

- **No surprises for Unit 2**: The insertion point, flag mechanism, and API are all consistent with
  the plan-035 pattern. The only correction to the plan is the BackendAssCache gate mechanism:
  CLASHED blocks the cache write via the early-return at line 612, not via line 1471.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification.*

```
CURRENT (broken):
  EquivalentObjectProperties(p, q)  → p.equivalentRoles = [q]     (separate from disjointRoles)
  DisjointObjectProperties(p, q)    → p.disjointRoles = [q], q.disjointRoles = [p]

  Saturation: initializeRoleAssertions processes alice p bob
    createRoleAssertionLink(alice, bob, p):
      for superRole in p.getIndirectSuperRoleList():  ← may or may not include q
        if superRole.getDisjointRoleList() != null:
          setInsufficientNodeOccured()  ← INDSATFLAGINSUFFICIENT
          (OR: q is not in super-role list, loop finds nothing)
    BackendAssCache: alice.indirectFlags has no CLASHED → CompletelyHandled=true written
    Completion trusts cache → no full tableau expansion → clash never detected

PROPOSED (fixed, Hypothesis A path):
  initializeRoleAssertions processes alice p bob
    after existing role assertion link creation:
      for eqRole in role.getEquivalentRoleList():
        if eqRole.hasDisjointRole(role) or role in eqRole.disjointRoles:
          updateDirectAddingIndividualStatusFlags(indiProcSatNode, INDSATFLAGCLASHED)
          return
    BackendAssCache: indiProcSatNode.indirectFlags has CLASHED → CompletelyHandled=true NOT written
    Completion runs full expansion → clash detected

PROPOSED (fixed, Hypothesis B path):
  createRoleAssertionLink(alice, bob, p):
    for superRole in p.getIndirectSuperRoleList():  ← includes q
      if superRole.getDisjointRoleList() != null:
        updateDirectAddingIndividualStatusFlags(sourceNode, INDSATFLAGCLASHED)  ← was INSUFFICIENT
        return
    BackendAssCache: alice.indirectFlags has CLASHED → CompletelyHandled=true NOT written
```

## Implementation Units

---

- [ ] **Unit 1: Confirm root cause — super-role inclusion and saturation clash path**

**Goal:** Determine which hypothesis (A or B) is correct and identify the exact fix location.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Read: `vendor/konclude/Source/Reasoner/Preprocess/CSubroleTransformationPreProcess.cpp` —
  `collectInverseEquivalentRoles()` and `addIndirectSuperRoles()` to determine whether
  `getIndirectSuperRoleList()` includes equivalent roles
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  lines 5013–5065 (`createRoleAssertionLink`) — confirm what `setInsufficientNodeOccured()` sets
  and on what node

**Approach:**

Hypothesis A is confirmed by code analysis (see Problem Frame). Unit 1's scope is now:

1. Read `initializeRoleAssertions` lines 5090–5160 to identify exact insertion point for the
   equivalent-role disjoint check inside the forward `assRoleLinkerIt` loop. Confirm `role`,
   `indiProcSatNode`, and `resolveNode` are all in scope at the insertion point.
2. Verify the BackendAssCache write path: confirm that `CSaturationNodeBackendAssociationCacheHandler`
   (around line 1471) writes `CompletelyHandled=true` for a nominal individual whose saturation node
   has no `INDSATFLAGCLASHED` in its indirect flags — and that `updateDirectAddingIndividualStatusFlags`
   with `INDSATFLAGCLASHED` blocks this write. This is the same gate as plan-035; confirm it applies
   to the `initializeRoleAssertions` path too (not just the individual-node path from plan-035).
3. Confirm `getEquivalentRoleList()` on the role object returns the `mInverseEquivalentRoles` list,
   and that the `!isNegated()` filter correctly separates equivalent roles from inverse roles.
4. Document exact insertion line, the surrounding context (3–5 lines), and any API differences from
   plan-035 patch 028 in the plan's Deferred section.

**Test scenarios:**
- Test expectation: none — this unit is investigation only; no code changes

**Verification:**
- Plan's `## Open Questions → Deferred to Implementation` section updated with:
  - Exact file:line of insertion point
  - Confirmation that BackendAssCache path matches plan-035's gate
  - Any API surprises (e.g. null-safety of `resolveNode` in this specific call path)

---

- [ ] **Unit 2: Patch AllDisjointProperties + EquivalentObjectProperties clash detection**

**Goal:** Add a saturation-level clash check so that an ABox individual with a role assertion
`p(a, b)` where `p` is both disjoint-with and equivalent-to another role sets
`INDSATFLAGCLASHED`, preventing the backend cache from marking the individual as
`CompletelyHandled`.

**Requirements:** R1, R2

**Dependencies:** Unit 1 (fix location must be known)

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  — `initializeRoleAssertions`, inside the forward `assRoleLinkerIt` loop, after the
  `createRoleAssertionLink` calls (~line 5100), before the asymmetric check at ~line 5101
- Create: `patches/029-alldisjointproperties-equivalentproperties-clash.patch`
- Read/verify: `tests/integration/issue13-owl-violations.test.ts` (do NOT modify case 10 —
  Unit 3 handles that)

**Approach:**

In `initializeRoleAssertions`, inside the forward `assRoleLinkerIt` loop, after the
`createRoleAssertionLink` calls (~line 5100) and before the asymmetric property check, add:

```cpp
for each eqRoleLinker in role->getEquivalentRoleList():
  if eqRoleLinker->isNegated(): skip  // REQUIRED: inverse roles share the same list
  eqRole = eqRoleLinker->getData()
  if eqRole->hasDisjointRole(role):
    updateDirectAddingIndividualStatusFlags(indiProcSatNode, INDSATFLAGCLASHED, calcAlgContext)
    return
```

**Critical: `!isNegated()` filter** — `getEquivalentRoleList()` returns `mInverseEquivalentRoles`
which stores both equivalent roles (`isNegated=false`) and inverse roles (`isNegated=true`). Without
the filter, the check would fire for `InverseObjectProperties(p, q)` + `DisjointObjectProperties(p, q)`,
producing a false inconsistency.

**Insertion point**: same location and structure as plan-035 patch 028 lines 5101–5113. `role`,
`indiProcSatNode`, and `calcAlgContext` are all in scope there.

Patch generation:
```
git -C vendor/konclude diff > patches/029-alldisjointproperties-equivalentproperties-clash.patch
git -C vendor/konclude checkout .
```

**Patterns to follow:**
- plan-035 patch 028 `initializeRoleAssertions` additions — identical pattern, different trigger
  condition (self-loop + isIrreflexive → equivalent-role disjoint check)
- `BETINVERSEOBJECTPROPERTIES` handler — bidirectional role setup, for reference on equivalent
  role structures

**Test scenarios:**
- Happy path: case 10 fixture (`DisjointObjectProperties(p,q)` + `EquivalentObjectProperties(p,q)` +
  `alice p bob`) → `checkConsistency()` returns inconsistent (tested after WASM rebuild in Unit 3)
- Happy path: only `DisjointObjectProperties(p,q)` without equivalence → consistent (no regression;
  existing ABox tests cover this)
- Happy path: only `EquivalentObjectProperties(p,q)` without disjoint → consistent
- Edge case: `DisjointObjectProperties(p,q)` + `EquivalentObjectProperties(p,q)` but no ABox
  assertion → consistent (empty extensions satisfy both constraints)
- Edge case: three-way — `AllDisjointProperties(p, q, r)` + `EquivalentObjectProperties(p, q)` +
  `alice p bob` → inconsistent (p ≡ q, p disjoint from q via AllDisjointProperties)
- Regression: all 233 existing tests pass; SymmetricProperty, AsymmetricProperty, IrreflexiveProperty,
  NegativePropertyAssertion PARITY tests unaffected

**Verification:**
- `npm test` passes with ≥233 tests (case 10 still skipped/UPSTREAM_LIMITATION until Unit 3 rebuild)
- Patch file `patches/029-alldisjointproperties-equivalentproperties-clash.patch` is non-empty and
  correct
- `git -C vendor/konclude status` is clean (no committed vendor changes)

---

- [ ] **Unit 3: WASM rebuild + test promotion + docs update**

**Goal:** Rebuild WASM with patch 029, validate full suite, promote case 10 from
`UPSTREAM_LIMITATION` to PARITY, update documentation.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 2

**Files:**
- Rebuild: `dist/konclude.wasm`, `dist/konclude.mjs`
- Modify: `tests/integration/issue13-owl-violations.test.ts` — promote case 10 to active PARITY test
- Modify: `tests/fixtures/issue13-native-verdicts.json` — update case 10 verdict to `inconsistent`
  (WASM now surpasses native, same pattern as cases 3+4)
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — update case
  10 from UPSTREAM_LIMITATION to PARITY
- Modify: `memory/project_upstream_konclude_bugs.md` — mark Bug 3 as resolved with patch 029
- Modify: `memory/project_owl2dl_parity_gaps.md` — move AllDisjointProperties + EquivalentProperties
  from "does not work" to "works"

**Approach:**
1. `rm vendor/konclude/.patches-applied` (REQUIRED — sentinel must be deleted to apply new patch)
2. `docker compose run --rm build` (20–30 min)
3. `sudo chown -R $USER dist/`
4. `npm run patch-wasm && npm run build`
5. `make smoke`
6. `npm test` — confirm case 10 now correctly detects inconsistency
7. Promote case 10: update test to active `it(...)`, expect `inconsistent: true` (or match native
   pattern); update `issue13-native-verdicts.json` to `inconsistent` (WASM surpasses native)
8. Update solutions doc: case 10 classification → `PARITY (fixed by patch 029)`
9. Update memory files
10. Update this plan's `status` to `complete`

**Test scenarios:**
- Full suite (`npm test`) green with ≥233 passing + case 10 now active (not skipped)
- Smoke test (Roberts Family) passes
- Case 10 asserts `inconsistent`
- No regression in cases 1–9, 11–14 or any other test

**Verification:**
- `npm test` reports 0 failures; case 10 shows as passing, not skipped
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` no longer lists
  AllDisjointProperties + EquivalentProperties as UPSTREAM_LIMITATION

## System-Wide Impact

- **Affected surface:** `checkConsistency()` only — the saturation clash path for ABox nominal
  individuals. `classify()`, `materialize()`, and `classifyProperties()` are unaffected.
- **Output change:** Ontologies with `AllDisjointProperties(p, q)` + `EquivalentObjectProperties(p, q)` +
  any ABox p-assertion will switch from consistent to inconsistent. Correctness fix.
- **Unchanged invariants:** All other property characteristics (SymmetricProperty, AsymmetricProperty,
  IrreflexiveProperty, InverseFunctionalProperty, NegativePropertyAssertion), all TBox constructs,
  all ABox realization tests — unaffected.
- **WASM surpasses native**: Same as cases 3+4 — native Konclude v0.7.0 will still return
  consistent; WASM will correctly return inconsistent. The native verdicts JSON must be updated
  to reflect the correct OWL 2 DL answer rather than native behavior.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Hypothesis A vs B requires investigation before patching | Unit 1 is explicitly gated; Unit 2 depends on Unit 1 |
| Patch affects saturation path for all roles with equivalent roles, not just this case | Run full test suite; check SymmetricProperty and inverseOf tests (those use equivalent role machinery) |
| Sentinel file causes rebuild to skip patch 029 | Unit 3 explicitly requires `rm vendor/konclude/.patches-applied` as first step |
| n-ary `AllDisjointProperties(p, q, r)` may need a separate check | Unit 2 test scenarios include the 3-way case; if it fails, add to patch scope |
| `createRoleAssertionLink` fix (Hypothesis B) could affect ALL disjoint role detection, not just the equivalence case | Scope is limited to the same check that already fires for super-role disjoint detection — changing flag type, not adding new path |

## Sources & References

- Upstream bug: `memory/project_upstream_konclude_bugs.md` Bug 3
- OWL 2 DL parity gaps: `memory/project_owl2dl_parity_gaps.md`
- Capability gap doc: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` case 10
- Test fixture: `tests/fixtures/issue13/case10-all-disjoint-properties.owl`
- Plan-035 pattern (AsymmetricProperty / IrreflexiveProperty saturation clash fix): `docs/plans/2026-06-02-035-fix-upstream-konclude-asymmetric-irreflexive-plan.md`
- Patch 028 precedent: `patches/028-irreflexive-asymmetric-saturation-clash.patch`
- OWL 2 RL prp-eqp1/2 and prp-pdw rules: https://www.w3.org/TR/owl2-profiles/#OWL_2_RL
