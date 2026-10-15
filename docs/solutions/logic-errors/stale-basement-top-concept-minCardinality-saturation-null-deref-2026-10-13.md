---
title: "Stale basement top concept as operand of unary minCardinality: native SEGV and WASM 033 hang"
module: generator / CConcreteOntologyUpdateBuilder, ontology / COntologyDataBoxes
tags: [null-deref, wasm, initial-build, top-concept, localisation, minCardinality, saturation, patch-034, patch-033, virtual-destructor]
problem_type: logic-error
root_cause: logic_error
resolution_type: code_fix
status: fixed 2026-10-13 (patch 034; patch 033 re-enabled; commits 4c5b654, 224b981)
---

# Stale basement top concept: native SEGV and the 033 WASM hang were one bug

## Problem

- Native: `konclude_repro --seq c:cardinality.nt` SEGV in
  `CTotallyOntologyPrecomputationItem::getSaturationConceptDataItem` (`conProcData == nullptr`),
  called from `createSaturationConstructionJob`. Minimal trigger: one
  `owl:equivalentClass [ owl:onProperty p ; owl:minCardinality 1 ]`.
- WASM: enabling patch 033 (virtual destructors) made the "Cardinality constructs" parity test hang
  (classify, materialize, consistency, then consistency of the inconsistent ontology), while WASM
  without 033 looked fine.

## Root cause

Unary `minCardinality 1` builds `SOME r. mTopClassExpression`. The operand concept is looked up with
`getConceptForClassTerm(top, false)`. Upstream builds the working ontology by *referencing* a separate
basement ontology: `referenceDataBoxes` copies the basic-build flag into `mPrevOntBasicBuild`, so
`setBuildContinuation()` makes the first update build an **initial** build, where
`getConceptForClassTerm` localises (re-creates) the top concept on first access. The WASM wrapper
(`Impl::buildFreshOntology`) applies the basement directly to the working ontology, so
`mPrevOntBasicBuild` stayed false: `mInitialBuild == false`. Top was localised only at the end of
`completeBuilding` (`mRebuildTopConcept`), after the SOME concept already took the old basement top.
The new top replaced it in the concept vector (same tag 1), but the old one has no `CConceptData`
-> null deref in saturation. (`mTopRebuildClassTermExpressionsSet`, meant to rebuild such
referrers, is never populated anywhere upstream.)

Why WASM looked fine: a null deref in wasm32 does not trap. Low memory is readable/writable, so
`getConceptReferenceLinking()` read garbage and `setConceptReferenceLinking()` wrote through a tiny
address: silent corruption, which 033 (which now frees more) turned into a hang.

## How it was found

gdb at the crash: `satConcept` (tag 1, name "Thing", `mConceptData == 0`) differed from
`onto->getDataBoxes()->getTopConcept()` (tag 1, has data). Breakpoints on
`getConceptForClassTerm` showed the operand lookup with `force=0 initial=0` before the later
`force=1` rebuild at `completeBuilding`.

## Solution

Patch 034 (`COntologyDataBoxes::setBasicBuild(true)` also sets `mPrevOntBasicBuild = true`). Nothing
else in the wrapper flow changes; upstream's referenced-basement flow overwrites the prev flags anyway.
Patch 033 re-enabled (five virtual destructors, fixes wrong-size deletes).

Verified: native card0/minCardinality no longer crash; Node repro (classify, materialize,
consistency x2) 1.1 s; vitest 573 passed / 1 skipped.

## Prevention

- When native crashes but WASM "works", suspect a null deref: wasm does not trap on it.
- Any wrapper shortcut that bypasses upstream's basement-reference flow must keep the build-phase
  flags (`mBasicBuild` / `mPrevOntBasicBuild` / `mInitialBuild`) equivalent.
- Compare `getTopConcept()` against operand concepts when a concept has no process data.
- Related family: derived destructors owned through base pointers (see patches 031, 032, 033).
