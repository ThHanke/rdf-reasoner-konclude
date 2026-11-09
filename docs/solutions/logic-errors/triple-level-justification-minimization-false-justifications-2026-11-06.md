---
title: Justifications minimized over RDF triples are false (partial lists, missing declarations)
date: 2026-11-06
category: logic-errors
module: ts/index.ts explainInconsistency, ts/repair.ts, ts/axiomGrouping.ts
problem_type: logic_error
component: tooling
symptoms:
  - "repair() on a consistent base (Roberts family) plus one injected clash returned two extra 10-axiom justifications that contained no injected axiom"
  - "565-654 consistency checks and 167-240 s instead of 29 checks and 34 s; repairs of size 2 where size 1 sufficed"
  - "A 33-triple justification was reported inconsistent on its own while the full ontology (a superset) was consistent"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [explanation, justification, quickxplain, rdf-lists, declarations, monotonicity]
---

# Justifications minimized over RDF triples are false (partial lists, missing declarations)

## Problem

`explainInconsistency` (and `repair`, built on it) minimized the inconsistent set triple by triple. For the kernel a subset of an ontology's *triples* is not a weakening of the ontology, so the "minimal" sets it found were minimal for the triples but not inconsistent subsets of the ontology's axioms. On Roberts (a consistent base) this produced extra, false justifications and made `repair()` take about 5x longer.

## Symptoms

- Two extra 10-axiom justifications with only Roberts axioms (`Woman ≡ ...`, `hasMother range Woman`, a property chain, `Female disjointWith Male`, `hasGender` functional) next to the real 3-axiom one.
- The base was consistent (`checkConsistency` true for every fixture), yet a subset of it was reported inconsistent: impossible in OWL DL, which is monotone.
- The kernel log of such a check carries the same failure lines as a real clash (`'Consistency-Checking' processing step failed`), so the two cannot be told apart from outside.

## What Didn't Work

- "A failed load of a malformed fragment is reported as inconsistent": cutting a list cell was suspected to make the pipeline fail. Wrong: the cut list is read as a *different* axiom.
- "Only declarations are missing": adding all 546 declarations of the base to the flat subset left it inconsistent.
- A first experiment gave a false "consistent" because N3 prefixes blank-node labels per parse (`b0_`, `b1_`), so blank-node closures looked up in the base store silently came out empty. Parse with `blankNodePrefix: ''` and normalise labels before comparing structures.

## Solution

Minimize over **axiom units** and keep declarations as **fixed background**:

- `partitionIntoUnits` (`ts/axiomGrouping.ts`): an axiom is a connected component of triples through shared blank nodes (restriction, RDF list, `AllDisjointClasses` with its member list, nested expression); a triple without blank nodes is its own unit; all graph copies of a triple stay together. Declaration triples (`C a owl:Class`, `p a owl:ObjectProperty`, ...) are background in every check and never candidates.
- `_explainInconsistencyQuadsDirect` (QuickXplain and the hitting-set tree) works on unit indices; each returned justification carries the declarations of the entities it mentions.
- `groupJustification` uses the same component notion, so repair axioms equal the search units (two roots that share a blank node merge instead of falling back to singletons).
- A justification whose search was cut short by the deadline is dropped instead of returned non-minimal.

## Why This Works

Two effects change the meaning of a triple subset, each shown by a single-triple change on Roberts (complete axioms plus all declarations: consistent):

1. **A partial RDF list is a different, usually stronger axiom.** Cutting one `rdf:rest` out of the `hasGreatGrandfather propertyChainAxiom` list made the set inconsistent: a chain cut to fewer roles is a sub-property axiom.
2. **A missing declaration changes the reading of the axioms.** The same complete axioms with only 8 context declarations were inconsistent; adding the one triple `hasGrandfather a owl:ObjectProperty` made them consistent.

With whole axioms and all declarations present no check set contains a partial structure, so removing axioms really is a weakening and monotonicity holds: justifications are real, and "a verified minimal hitting set of the justifications is an inclusion-minimal repair" is sound.

## Prevention

- Never minimize or remove at triple granularity for reasoning over RDF; the unit is the axiom (blank-node component), declarations are background.
- Test with an ontology that has lists (Roberts: property chains, intersections), not only flat triples: `tests/unit/axiomGrouping.test.ts` (`partitionIntoUnits`), `tests/integration/repair.test.ts`, and the benchmark matrix (`docs/benchmark-repair.md`).
- When a subset is "inconsistent" but its superset is not, suspect the reading of the subset, not the reasoner. Check monotonicity directly: grow the set towards the full ontology and find the triple that flips the answer.
- Benchmark the *base* for consistency before injecting a clash (`baseConsistent` in `tests/bench/repair-case.mjs`).

## Related Issues

- `docs/benchmark-repair.md` (matrix before and after, former-issue section)
- `docs/solutions/best-practices/reasoner-repair-api-plan-review-checklist-2026-11-05.md`
