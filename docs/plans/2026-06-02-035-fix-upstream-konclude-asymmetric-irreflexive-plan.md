---
title: "fix: upstream Konclude — AsymmetricProperty and IrreflexiveProperty inconsistency detection"
type: fix
status: active
date: 2026-06-02
---

# fix: upstream Konclude — AsymmetricProperty and IrreflexiveProperty inconsistency detection

## Overview

Native Konclude v0.7.0 fails to detect inconsistency for two OWL 2 DL constructs:

- **AsymmetricProperty** (case 3): ontology with `r(a,b)` and `r(b,a)` on an asymmetric property
  is incorrectly deemed consistent.
- **IrreflexiveProperty** (case 4): ontology with `r(a,a)` on an irreflexive property is
  incorrectly deemed consistent.

Both cases are marked `UPSTREAM_LIMITATION` in
`tests/integration/issue13-owl-violations.test.ts`. Root cause investigation during this
plan reveals concrete C++ fixes. Both require patches to `vendor/konclude/` and a WASM rebuild.

## Problem Frame

The bugs are confirmed native Konclude defects (not WASM port regressions). The mapper and
builder both correctly receive and register the axioms. The failure is in the tableau clash
detection layer. SymmetricProperty IS parity — it provides the positive control pattern to
mirror for AsymmetricProperty.

### AsymmetricProperty root cause (confirmed)

`BETASYMMETRICPROPERTY` in `CConcreteOntologyUpdateBuilder.cpp` calls
`getCorrectedInverseObjectPropertyOf` + `getRoleForObjectPropertyTerm` to create
`invRole_builder` and stores it in `role->getDisjointRoleList()`. This is correct.

However, `CSubroleTransformationPreProcess` later checks `!role->hasInverseRoles()` and,
finding no inverse set, creates a **second** distinct `inverseRole_pp` CRole* object. It
sets `role->setInverseRole(inverseRole_pp)` and adds `inverseRole_pp` to
`role->addSuperRoleLinker(...)` — which is what gets propagated into
`role->getIndirectSuperRoleList()` and drives implicit inverse-link creation.

Result: disjoint list uses `invRole_builder`; actual inverse links use `inverseRole_pp`.
They are different CRole* pointers. The equality check in `createIndividualNodeDisjointRolesLinks`
(`sourceIndi->getRoleSuccessorToIndividualLink(disjointRole, destIndi)`) never finds a match
because no explicit `invRole_builder` link is ever created. Clash is never detected.

**Fix**: mirror the `BETSYMMETRICPROPERTY` handler — call `role->addInverseRoleLinker` and
`role->setInverseRole(invRole_builder)` in the asymmetric handler before returning. Because
`hasInverseRoles()` then returns true, the preprocessor reuses `invRole_builder` instead of
creating `inverseRole_pp`. Both disjoint constraint and implicit inverse links then refer to
the same CRole*, enabling the existing disjoint clash detection to fire.

### IrreflexiveProperty root cause (hypothesis, needs unit 1 confirmation)

The builder correctly creates GCI `⊤ ⊑ ¬∃properPartOf.Self` via
`buildGeneralConceptInclusionClassExpression(gciNotSelfExp)`. The **completion** algorithm's
`applySELFRule` (line 17239 of `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`) with
`negate=true` correctly checks for self-loops and throws a clash.

However, the **saturation** algorithm's `applySELFRule` (line 6843 of
`CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`) with `negate=true`
does **not** detect a clash — it only propagates domain/range concepts and backward
propagation links. If ABox nominal individuals are processed exclusively through saturation
and the clash is never checked in the completion pass, the inconsistency is missed.

Unit 1 must confirm whether nominal individuals with self-loops enter the completion
algorithm where the full `¬∃p.Self` clash rule fires, and if not, what path to add.

## Requirements Trace

- R1. `checkConsistency()` returns inconsistent for an ontology with `r(a,b)`, `r(b,a)`,
  and `AsymmetricObjectProperty(r)`
- R2. `checkConsistency()` returns inconsistent for an ontology with `r(a,a)` and
  `IrreflexiveObjectProperty(r)`
- R3. All existing 233 tests continue to pass (no regression)
- R4. Test cases 3 and 4 in `tests/integration/issue13-owl-violations.test.ts` promoted
  from `UPSTREAM_LIMITATION` to `PARITY`
- R5. Upstream bug documentation updated

## Scope Boundaries

- Only `checkConsistency()` path — no change to `classify()`, `materialize()`, or
  `classifyProperties()` output
- Only object properties — data property asymmetric/irreflexive reasoning out of scope
- No changes to the `owl:AsymmetricProperty` mapper or builder axiom registration path
  (confirmed correct by mapper-flag-audit-2026-06-02)
- AllDisjointProperties + EquivalentProperties inconsistency (case 10): out of scope,
  separate upstream bug with different root cause
- FunctionalProperty ALIF+ hang (Bug 2): out of scope

### Deferred to Separate Tasks

- Opening upstream PRs against `konclude/Konclude`: separate task once fixes are validated
  in WASM

## Context & Research

### Relevant Code and Patterns

- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp` lines
  1762–1774 — `BETSYMMETRICPROPERTY` handler: the exact pattern to mirror for AsymmetricProperty.
  Calls `addInverseRoleLinker(init(invRole, true))` and `setInverseRole(role)`. This is the
  positive control that produces correct parity.
- `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp` lines
  1773–1789 — `BETASYMMETRICPROPERTY` handler: current broken implementation. Sets up
  disjoint list correctly but does NOT call `addInverseRoleLinker` or `setInverseRole`.
- `vendor/konclude/Source/Reasoner/Preprocess/CSubroleTransformationPreProcess.cpp` lines
  108–160 — creates `inverseRole_pp` when `!role->hasInverseRoles()`. The fix in the builder
  must call `setInverseRole` to block this path.
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
  line 20237 — `createIndividualNodeDisjointRolesLinks`: the clash check. Uses
  `getRoleSuccessorToIndividualLink(disjointRole, ...)` which requires both sides to use the
  same CRole* pointer.
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
  line 17239 — `applySELFRule` with `negate=true`: the correct clash check for irreflexive.
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  line 6843 — saturation's `applySELFRule`: does NOT detect clash, only propagates domain/range.

### Institutional Learnings

- Patch mechanism: edit `vendor/konclude/` → `git -C vendor/konclude diff >
  patches/027-name.patch` → `git -C vendor/konclude checkout .`. Next available slot is `027`.
  Patches apply in lexicographic sort order at CMake configure time.
- Patches 025+026 precedent: a single logical fix can require two patch files when two
  separate code locations are both broken. Check both after each patch.
- `QHash`/`QSet` subrole lookup fragility: if a role is not found during subrole preprocessing
  the subproperty chain is silently skipped. Verify `getInverseRole()` returns the expected
  CRole* after the fix.
- `owl:inverseOf` ABox inference is confirmed PARITY — the inverse role machinery works
  when `setInverseRole` is called correctly.

### External References

- OWL 2 DL specification: `AsymmetricObjectProperty(r)` ≡ `DisjointObjectProperties(r, ObjectInverseOf(r))`
- OWL 2 DL specification: `IrreflexiveObjectProperty(r)` ≡ GCI `⊤ ⊑ ¬∃r.Self`

## Key Technical Decisions

- **Fix AsymmetricProperty in builder, not in the tableau**: the tableau clash mechanism is
  correct; the problem is that the wrong CRole* is in the disjoint list. Fixing at the source
  (builder) is minimal and mirrors the existing SymmetricProperty pattern.

- **Do not modify `CSubroleTransformationPreProcess`**: the preprocessor works correctly for
  any role where `hasInverseRoles()` is true. The builder fix makes that precondition hold.
  Modifying the preprocessor to detect expression-based inverse roles would be fragile.

- **Two separate patches (027, 028) for two constructs**: independent fixes to separate code
  sites. AsymmetricProperty fix is in the builder; IrreflexiveProperty fix location is
  determined by Unit 1. Keeping them separate matches the 025/026 precedent and allows
  bisection if one regresses.

- **Pattern to follow for AsymmetricProperty**: mirror `BETSYMMETRICPROPERTY` bidirectionally:
  `role->addInverseRoleLinker(init(invRole, true))`,
  `invRole->addInverseRoleLinker(init(role, true))`,
  `role->setInverseRole(invRole)`,
  `invRole->setInverseRole(role)`.
  For symmetric, invRole == role (self-inverse). For asymmetric, invRole is the distinct
  expression-based inverse. The bidirectional setup is needed so both roles block the
  preprocessor's second-role creation.

## Open Questions

### Resolved During Planning

- **Is the mapper/builder axiom registration correct?** Yes — mapper-flag-audit-2026-06-02
  confirms both constructs reach the builder via `buildObjectPropertyBasedAxioms()`.
- **Is SymmetricProperty a valid positive control?** Yes — it uses the same
  `addInverseRoleLinker`/`setInverseRole` mechanism and is confirmed PARITY.
- **Why does disjoint check fail?** Role CRole* identity mismatch between builder-created
  `invRole_builder` and preprocessor-created `inverseRole_pp`.

### Deferred to Implementation

- Exact preprocessor behaviour when `setInverseRole` is called before its inverse-role
  creation block: verify `confForceInverseRoleCreation` is true and that `!role->hasInverseRoles()`
  correctly returns false after the builder sets the inverse. If not, the bidirectional
  `setInverseRole` calls may need to happen in a different order.
- Whether `invRole->addInverseRoleLinker(init(role, true))` is needed in addition to
  `role->addInverseRoleLinker(init(invRole, true))`: check how the preprocessor builds the
  super role list for the inverse role (at minimum both pointers must block the
  `!hasInverseRoles()` check).
- Whether any existing test uses `owl:AsymmetricProperty` with consistent ABox (no
  bidirectional pairs) — verify no regression by running the full suite after the patch.

### IrreflexiveProperty Fix — Confirmed by Unit 1 Code Trace

**Root cause (confirmed by code trace, not hypothesis):**

The saturation algorithm's jump table has `mNegJumpFuncVec[CCSELF]` unregistered. When
`¬∃r.Self` is added to a nominal node's saturation label set (via the GCI `⊤ ⊑ ¬∃r.Self`
generated by the builder for `IrreflexiveObjectProperty`), the concept is queued for
processing. When dequeued, the dispatch table has no handler for
`(opCode=CCSELF, negate=true)` → the rule never fires → no clash is detected →
saturation marks the node "complete and consistent" → the backend cache stores this result
→ the completion algorithm trusts the cache and skips full expansion → inconsistency missed.

The completion algorithm's `applySELFRule` with `negate=true` (line 17239 of
`CCalculationTableauCompletionTaskHandleAlgorithm.cpp`) WOULD correctly detect the clash,
but it is never reached because the completion trusts the saturation backend cache.
Specifically, `tryEstablishExpansionBlockingWithBackendCacheSynchronisation` (line 22582)
sets `PRFSYNCHRONIZEDBACKENDSUCCESSOREXPANSIONBLOCKED` when `assocData->isCompletelyHandled()`
and the concept set is synchronized, blocking further expansion.

The ABox role assertion `r(a,a)` creates a backward-propagation self-link in the saturation
node's `CRoleBackwardSaturationPropagationHash` when `initializeRoleAssertions` processes it:
`installBackwardPropagationLink(sourceNode, sourceNode, superRole, backPropLink, ...)`.
This stores a link in `sourceNode->getRoleBackwardPropagationHash()[superRole].mLinkLinker`
where `backPropLink->getSourceIndividual() == sourceNode` (a detectable self-loop).
Note: `mSelfConnected` is NOT set by ABox self-loops — only by `applySELFRule` negate=false
(`∃r.Self`). Do NOT rely on `mSelfConnected` for the clash check.

**Fix location:**

File: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`

**Change 1** — constructor (line ~77, inside the jump-table initialization block):
```cpp
mNegJumpFuncVec[CCSELF] = &CCalculationTableauApproximationSaturationTaskHandleAlgorithm::applySELFRule;
```

**Change 2** — in `applySELFRule` (line 6843), insert at the top of the function body,
before the super-role iteration loop, guard on `conNegation == true`:
```cpp
if (conNegation) {
    // ¬∃r.Self: clash if there is a self-loop for this role or any super-role
    CRoleBackwardSaturationPropagationHash* backPropHash = processIndi->getRoleBackwardPropagationHash(false);
    if (backPropHash) {
        CPROCESSHASH<CRole*,CRoleBackwardSaturationPropagationHashData>* backPropDataHash =
            backPropHash->getRoleBackwardPropagationDataHash();
        CSortedNegLinker<CRole*>* superRoleIt2 = role->getIndirectSuperRoleList();
        while (superRoleIt2) {
            CRole* superRole2 = superRoleIt2->getData();
            bool invRole2 = superRoleIt2->isNegated();
            // backward propagation links are stored on the destination (=source for self-loops)
            // and keyed by the non-inversed super role in the inverse direction
            if (invRole2) {
                if (backPropDataHash->contains(superRole2)) {
                    CRoleBackwardSaturationPropagationHashData& backPropData = (*backPropDataHash)[superRole2];
                    for (CBackwardSaturationPropagationLink* linkIt = backPropData.mLinkLinker; linkIt; linkIt = linkIt->getNext()) {
                        if (linkIt->getSourceIndividual() == processIndi) {
                            // self-loop found — clash!
                            updateDirectAddingIndividualStatusFlags(processIndi, CIndividualSaturationProcessNodeStatusFlags::INDSATFLAGCLASHED, mCalcAlgContext);
                            return;
                        }
                    }
                }
            }
            superRoleIt2 = superRoleIt2->getNext();
        }
    }
    return; // no self-loop found — no clash
}
```

**Rationale for `invRole2` check:** `installBackwardPropagationLink` is called from
`createRoleAssertionLink` with `roleInversed=true` (line 5046), which fires when
`superRoleIt->isNegated() ^ roleInversed = false ^ true = true`. The link is stored keyed
by the super role that has `isNegated()=true` in `getIndirectSuperRoleList()`. However,
looking more carefully: `createRoleAssertionLink(indiProcSatNode, indiProcSatNode, role, true, ...)`.
The backward prop hash key is `superRole` from iterating `role->getIndirectSuperRoleList()`.
When `superRoleIt->isNegated() ^ roleInversed` (i.e., `isNegated() ^ true`) is true, that
means `isNegated()=false`, NOT `isNegated()=true`. So the link is actually stored keyed by
the **non-negated** super role. The `invRole2` check in the proposed fix above needs
verification — the correct check is `!invRole2` (i.e., `isNegated()==false`).

**Revised Change 2** (corrected after re-reading createRoleAssertionLink line 5039):
```
Line 5039: if (superRoleIt->isNegated()^roleInversed) { → backward prop branch
When roleInversed=true: condition is true when isNegated()=false
```
So backward prop links for self-loops are stored under non-negated super roles.
Change the `if (invRole2)` to `if (!invRole2)` in the check above.

**Confidence:** High — confirmed by complete code trace through:
- Saturation dispatch table initialization (line 77 — missing `mNegJumpFuncVec[CCSELF]`)
- Backend cache write-blocking on clash (line 612 — clashed flag prevents cache association)
- Backend cache use in completion (line 22582 — `tryEstablishExpansionBlockingWithBackendCacheSynchronisation`)
- ABox self-loop storage in backward prop hash (`createRoleAssertionLink`, `installBackwardPropagationLink`)
- The check `linkIt->getSourceIndividual() == processIndi` for detecting self-loops

**One remaining uncertainty:** The `!invRole2` vs `invRole2` direction in the backward prop
hash lookup. This must be verified by reading `createRoleAssertionLink` line 5039 again
during Unit 3 implementation. The logic: `superRoleIt->isNegated()^roleInversed` is the
condition. For the ABox role assertion with `roleInversed=true`, the backward prop branch
executes when `isNegated()=false` (because `false^true=true`). So the hash key is the
super role with `isNegated()=false` in the super role list, i.e., the **non-inverted** role.
In the `applySELFRule` check, iterate all super roles and for each with `isNegated()=false`
check if any backward prop link has source==processIndi.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification.*

```
CURRENT (broken) BETASYMMETRICPROPERTY:
  invRole_builder = getCorrectedInverseObjectPropertyOf(role)
  role.disjointList  ← [invRole_builder]          ← disjoint check uses this
  invRole_builder.disjointList ← [role]

  CSubroleTransformationPreProcess (runs after builder):
    !role.hasInverseRoles() → true
    create inverseRole_pp (NEW CRole*)
    role.indirectSuperRoleList ← [inverseRole_pp(negated=true)]  ← links use this

  RESULT: disjointList[invRole_builder] ≠ link role[inverseRole_pp] → no clash

PROPOSED (fixed) BETASYMMETRICPROPERTY:
  invRole_builder = getCorrectedInverseObjectPropertyOf(role)
  role.disjointList  ← [invRole_builder]
  invRole_builder.disjointList ← [role]
  + role.addInverseRoleLinker(invRole_builder, negated=true)
  + invRole_builder.addInverseRoleLinker(role, negated=true)
  + role.setInverseRole(invRole_builder)
  + invRole_builder.setInverseRole(role)

  CSubroleTransformationPreProcess (runs after builder):
    !role.hasInverseRoles() → false  (blocked)
    invRole_builder propagates into role.indirectSuperRoleList via inverse linker

  RESULT: when r(alice,bob) added → inv(r)(bob,alice) also created [invRole_builder]
          createIndividualNodeDisjointRolesLinks finds invRole_builder match → CLASH
```

## Implementation Units

---

- [ ] **Unit 1: Investigate IrreflexiveProperty saturation→completion nominal flow**

**Goal:** Determine exactly where `¬∃p.Self` clash detection falls short for ABox nominals
and identify the minimal fix location.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  lines ~6843–6900 (saturation `applySELFRule`)
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp`
  line ~17239 (completion `applySELFRule`) and the nominal individual initialization path
- Read: how ABox nominals flow from saturation results into the completion processing queue

**Approach:**

1. Confirm: the saturation's `applySELFRule` with `negate=true` propagates domain/range only
   — no self-loop clash check. This is the expected gap.
2. Trace: when a nominal individual has `r(a,a)` in the ABox AND the GCI `⊤ ⊑ ¬∃r.Self` is
   active, does the completion's `applySELFRule` for `¬∃r.Self` ever get called for that
   nominal? Look for the nominal processing entry points in the completion algorithm.
3. If completion DOES process the nominal: find why `getIndividualNodeLink(a, a, r)` returns
   null (self-loop not stored as recognizable self-link).
4. If completion DOES NOT process the nominal: find the entry point to add the call.
5. Document the fix location and approach in the plan before implementing.

**Patterns to follow:**
- Completion `applySELFRule` for `negate=true` (line 17239) — this is the target rule that
  must fire
- How ReflexiveProperty works (`negate=false`): it creates self-links; IrreflexiveProperty
  must detect their existence and clash

**Test scenarios:**
- Trace path for case 4 fixture: `:properPartOf a owl:IrreflexiveProperty; :part1 :properPartOf :part1`
- Confirm saturation doesn't clash (expected — saturation is approximate)
- Confirm whether completion is reached for `:part1` node

**Verification:**
- Document is updated below `## Open Questions → Deferred to Implementation` with exact
  file, line, and patch approach before proceeding to Unit 3

---

- [ ] **Unit 2: Patch AsymmetricProperty — inverse role setup in builder**

**Goal:** Emit the `owl:AsymmetricProperty` inconsistency correctly by ensuring
`invRole_builder` is reused by the subrole preprocessor instead of being shadowed by a
second CRole*.

**Requirements:** R1, R3

**Dependencies:** None (independent of Unit 1)

**Files:**
- Modify: `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp`
  (BETASYMMETRICPROPERTY handler, lines ~1773–1789)
- Create: `patches/027-asymmetric-property-inverse-role-fix.patch`
- Test: `tests/integration/issue13-owl-violations.test.ts`

**Approach:**

In the `BETASYMMETRICPROPERTY` handler, after the existing disjoint linker setup:
1. Add `role->addInverseRoleLinker(init(invRole, true))` — invRole is the inverse direction
   of role, mirroring exactly the `BETSYMMETRICPROPERTY` handler
2. Add `invRole->addInverseRoleLinker(init(role, true))` — bidirectional, so the preprocessor
   also sees invRole as having an inverse and skips creating a third role
3. Add `role->setInverseRole(invRole)` — prevents `CSubroleTransformationPreProcess` from
   creating `inverseRole_pp`
4. Add `invRole->setInverseRole(role)` — symmetric guard

The existing disjoint linker calls remain unchanged. The new calls go AFTER them, still
inside the `BETASYMMETRICPROPERTY` case, before `role->setAsymmetric(true)`.

To generate the patch:
- Edit `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp`
- `git -C vendor/konclude diff > patches/027-asymmetric-property-inverse-role-fix.patch`
- `git -C vendor/konclude checkout .`

**Patterns to follow:**
- `BETSYMMETRICPROPERTY` handler at lines 1762–1774 — exact template, adapted for
  `invRole ≠ role` (asymmetric is not self-inverse)
- `BETINVERSEOBJECTPROPERTIES` handler at lines 1616–1638 — shows bidirectional
  `setInverseRole` + `addInverseRoleLinker` for a named pair of roles

**Test scenarios:**
- Happy path: case 3 fixture (`r(alice,bob)` + `r(bob,alice)` + `AsymmetricProperty(r)`) →
  `checkConsistency()` returns inconsistent
- Happy path: reverse order (bob→alice asserted first) → same inconsistent result
- Happy path: case 3 with only one direction (`r(alice,bob)`, no `r(bob,alice)`) → consistent
  (no regression)
- Edge case: asymmetric property with no ABox individuals → consistent, no crash
- Edge case: asymmetric property where both assertions use same individual (`r(a,a)`) →
  inconsistent (also self-referential via inverse)
- Regression: all existing 233 tests pass; SymmetricProperty PARITY unchanged; object
  property assertions from existing ABox realization tests unchanged

**Verification:**
- `npm test` passes with ≥233 tests; case 3 in `issue13-owl-violations.test.ts` no longer
  requires `UPSTREAM_LIMITATION` skip

---

- [ ] **Unit 3: Patch IrreflexiveProperty (contingent on Unit 1)**

**Goal:** Emit the `owl:IrreflexiveProperty` inconsistency based on the fix location
identified in Unit 1.

**Requirements:** R2, R3

**Dependencies:** Unit 1 (fix location must be known)

**Files:**
- Modify: file determined by Unit 1 (likely `CCalculationTableauApproximationSaturationTaskHandleAlgorithm.cpp`
  or the nominal initialization path in the completion algorithm)
- Create: `patches/028-irreflexive-property-fix.patch`
- Test: `tests/integration/issue13-owl-violations.test.ts`

**Approach:**

*Exact implementation deferred to Unit 1 findings.* The general shape:

- If the gap is in the saturation: add a self-loop clash check to the saturation's
  `applySELFRule` when `negate=true` — check
  `getIndividualNodeSelfConnectionForRole(processIndi, role)` or equivalent, throw clash.
- If the gap is in the completion not seeing the nominal: add the nominal's node to the
  completion processing queue after saturation results are loaded, or ensure the GCI concept
  is re-applied in the completion pass.

Follows the two-patch precedent from patches 025+026: generate with `git -C vendor/konclude diff`,
restore vendor with `git -C vendor/konclude checkout .`.

**Patterns to follow:**
- Completion `applySELFRule` `negate=true` branch (line 17239) — the correct clash logic to
  replicate or trigger
- Saturation `applySELFRule` for `negate=false` (ReflexiveProperty): shows what the positive
  case does that the negative case needs to counter

**Test scenarios:**
- Happy path: case 4 fixture (`:properPartOf a IrreflexiveProperty; :part1 :properPartOf :part1`) →
  `checkConsistency()` returns inconsistent
- Happy path: irreflexive property with no self-loop ABox assertions → consistent, no crash
- Happy path: irreflexive property with `r(a,b)` (non-self, a≠b) → consistent
- Edge case: irreflexive property with no ABox individuals → consistent
- Regression: same 233 baseline + case 3 from Unit 2

**Verification:**
- Case 4 in `issue13-owl-violations.test.ts` no longer requires `UPSTREAM_LIMITATION` skip

---

- [ ] **Unit 4: WASM rebuild + test promotion + docs update**

**Goal:** Rebuild WASM with patches 027 (+028 if Unit 3 complete), validate full test suite,
promote test cases from UPSTREAM_LIMITATION to PARITY, update docs.

**Requirements:** R3, R4, R5

**Dependencies:** Unit 2 (and Unit 3 if IrreflexiveProperty is fixed)

**Files:**
- Rebuild: `dist/konclude.wasm`, `dist/konclude.mjs`
- Modify: `tests/integration/issue13-owl-violations.test.ts` — promote cases 3 (and 4 if fixed)
- Modify: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` — update
  UPSTREAM_LIMITATION → PARITY for resolved cases
- Modify: `memory/project_upstream_konclude_bugs.md` — mark Bug 5 (AsymmetricProperty) and
  Bug 6 (IrreflexiveProperty if fixed) as resolved with patch numbers

**Approach:**
1. `docker compose run --rm build` (20–30 min)
2. `npm run patch-wasm && npm run build`
3. `make smoke` — verify Roberts Family still passes
4. `npm test` — confirm ≥233 baseline + new passing cases
5. In `issue13-owl-violations.test.ts`:
   - Case 3: remove `it.skip` wrapper and `UPSTREAM_LIMITATION` comment; update test body
     to expect `inconsistent`
   - Case 4: same (if Unit 3 complete)
6. Update solutions doc and memory files

**Test scenarios:**
- Full suite (`npm test`) green; no regressions in consistency, classify, materialize, or
  classifyProperties
- Case 3 passes as active (not skipped) test asserting inconsistent
- Case 4 passes (if applicable)
- Smoke test passes

**Verification:**
- `npm test` reports 0 failures; promoted cases show as passing (not skipped)
- `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md` no longer
  lists AsymmetricProperty (and IrreflexiveProperty) as UPSTREAM_LIMITATION

## System-Wide Impact

- **Affected surface:** `checkConsistency()` only — `classify()`, `materialize()`, and
  `classifyProperties()` are unaffected (they don't use the ABox completion clash path for
  property characteristics)
- **Output change:** Ontologies with bidirectional asymmetric assertions or irreflexive
  self-loops will switch from consistent to inconsistent. This is a correctness fix.
- **Unchanged invariants:** SymmetricProperty, ReflexiveProperty, InverseFunctionalProperty,
  NegativePropertyAssertion, and all TBox constructs are unaffected
- **No TS changes required:** `checkConsistency()` returns the boolean from the C++ kernel;
  no filtering in the TypeScript layer affects it

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `setInverseRole` + `addInverseRoleLinker` in builder triggers unexpected subrole propagation for asymmetric roles | Run full test suite after patch 027 before WASM rebuild; check for spurious inferences in ABox tests |
| `invRole->setInverseRole(role)` causes `invRole` to appear in its own super role list (self-referential loop) | Mirrors the BETINVERSEOBJECTPROPERTIES handler which does the same bidirectionally and is confirmed correct |
| IrreflexiveProperty fix location unknown until Unit 1 | Unit 3 explicitly depends on Unit 1; Unit 4 can proceed with only patch 027 if Unit 3 takes longer |
| WASM rebuild takes 20–30 min | Batch both patches (027 + 028) into a single rebuild once both are written |
| Patch 027 changes inverse role structure; might interact with saturation's approximation caching | Run smoke test (Roberts Family) after rebuild; existing saturation tests cover the nominal ABox path |

## Sources & References

- Upstream bug tracker: `memory/project_upstream_konclude_bugs.md` (Bugs 5 and 6 once documented)
- OWL 2 DL parity gaps: `memory/project_owl2dl_parity_gaps.md`
- Mapper flag audit: `docs/solutions/capability-gaps/mapper-flag-audit-2026-06-02.md`
- Capability gap doc: `docs/solutions/capability-gaps/wasm-vs-native-owl-violation-detection.md`
- Prior NPA fix (two-patch pattern): `patches/025-negative-prop-assertion-filter-fix.patch`,
  `patches/026-negative-prop-assertion-hash-fix.patch`
- Pattern file: `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyUpdateBuilder.cpp`
  lines 1762–1774 (BETSYMMETRICPROPERTY)
