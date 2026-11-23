---
module: swrl
tags: [swrl, dl-safe-rules, materialize, performance, semi-naive]
problem_type: performance
date: 2026-11-23
---

# SWRL fixpoint: close rule chains in TypeScript, call the kernel only for new facts

## Problem

Konclude has no SWRL support. `materialize()` applies DL-safe rules (`swrl:Imp`, variables bind to named individuals only) on top of the kernel: derive head statements from the realized ABox, add them to the reasoning input, realize again, repeat until no rule adds a statement.

The first version did one full kernel cycle (sync of the whole store, consistency, realization, decode) per rule application round. A rule whose head feeds another rule's body (part-of propagation: `hasQuality(e,d) ∧ partOf(e,m) → hasQuality(m,d)`) needs one round per tree level. Kernel cost per round is large because the sync contract invalidates everything on any change and the ontology is rebuilt (`self-invalidating-reasoner-api-2026-10-10.md`); there is no incremental retract or incremental realization in upstream Konclude.

Measured (300 materials, 900 qualities, 2 rules, 4,863 derived triples, `tests/bench/swrl-bench.mjs`): 7 kernel rounds, `materialize` 4755 ms against 613 ms without rules (7.8x).

## Solution

1. **Close the chains in TypeScript.** Rule application runs over base facts + kernel output + derived facts until nothing new appears, without a kernel call. The kernel is called only when the closure produced facts it has not seen, and its output is added to the facts for the next closure. Kernel rounds now count alternations between rule and OWL inference, not rule steps. Same least fixpoint (rules are monotone).
2. **Semi-naive matching.** `applyRules(rules, facts, delta)` enumerates only matches that use at least one fact new since the previous pass: for each body atom position, that atom is matched against the delta and the others against all facts. First pass is naive. Result equality with the naive iteration is pinned by a unit test (`tests/unit/swrl.test.ts`) and by the integration oracle (`tests/integration/swrl-fixpoint.test.ts`).

Result: 2 kernel rounds, 1417 ms (2.5x). The remaining overhead is one kernel round: sync 49 ms, consistency 154 ms, realization 307 ms, decode 30 ms, because the ABox grew by the derived edges. A kernel-native rule engine would still realize the larger ABox; it would save only the sync and decode (about 80 ms) and needs deadlock-prone changes in the threading layer, so it was not pursued.

## Cost summary

| Store | Cost against no rules |
|---|---|
| No `swrl:Imp` triples | none (detected before any work) |
| Rules whose bodies never match | 1.0x (`--nofire`) |
| Rules deriving 4,863 triples | 2.5x |

## Options and reporting

`materialize(store, { swrl: false })` skips rule processing (default on). `reasoner.lastSwrl` = `{ rules, unsupported, rounds, derived, applied }`; with the option off it still lists the rules found with `applied: false`. The materialize result cache records the option, so a call with the other setting on an unchanged store recomputes. Explanations stay those of the first realization; a rule consequence that makes the ontology inconsistent rejects with `InconsistentOntologyError`.

## When to revisit

If a real ontology with many derived triples shows the final kernel round dominating, the options are incremental realization (paused project topic) or a kernel-native rule step. Neither is a TypeScript-side change.
