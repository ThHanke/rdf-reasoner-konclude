---
title: Checklist for planning reasoner-backed repair / weakening / assessment APIs
date: 2026-11-05
category: best-practices
module: docs/plans/2026-11-05-003 (repair, weaken, assessEdit)
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - Planning or reviewing an API that composes many kernel calls (consistency, classify, entailment, explain) into one verb
  - Defining result shapes that must map back to store quads
  - Adding public API with a single known consumer
tags: [plan-review, repair, weakening, justifications, named-graphs, deadlines, owl]
---

# Checklist for planning reasoner-backed repair / weakening / assessment APIs

## Context

`ce-doc-review` of `docs/plans/2026-11-05-003-feat-repair-weakening-assessment-in-reasoner-plan.md` (5 reviewers, 27 findings) found the same classes of gap that a first draft of this kind of plan tends to contain. 21 were fixed in the plan, 6 skipped. The checklist below is what to verify before the next plan of this shape.

## Guidance

1. **Reference state under inconsistency.** Any "before vs after" measure (lost disjointness, lost entailments) is vacuous on an inconsistent ontology: every pair is entailed. Define the reference as the store minus the culprit axioms, and exclude pairs with an unsatisfiable endpoint.
2. **Weakening search is over a DAG, not a chain.** Named superclasses have multiple inheritance (BFO, PMDco), so binary search is invalid. Walk upward and prune ancestors of working candidates; return minimal generalizations in topological order, ties unspecified.
3. **Verify a weakening against the target class, not only global consistency.** For an unsatisfiable class with no instances, global consistency passes for any replacement, including the culprit itself. Reject candidates equal to the culprit or already entailed without it.
4. **Quad identity vs union reasoning.** The kernel sees the union of graphs. A triple asserted in two graphs is unaffected by removing one copy, so an axiom's `quads` must include every graph copy.
5. **Laconic fragments are not store triples.** Return the source axiom plus a derived remainder; never a fragment as a removable quad.
6. **Composite verbs deadlock on the serial queue.** Extract slot-held `*Direct` variants (as `explain` does with `_callDirect`) before building repair/weaken/assess on top.
7. **A deadline cannot preempt a blocking WASM call.** Check between calls and cap each call by Worker termination; define recovery (recycle, reload) and the budget split across phases. The existing explain timeout did not fire before a ~112 s trap on PMDco.
8. **Compute the cost model against the defaults.** Rounds x 21-34 s plus about 1 s per verified candidate plus minimality checks exceeded the 180 s default. Return the first verified repair early.
9. **Define "minimal".** Inclusion-minimal is exact in |S| checks by monotonicity; cardinality-minimum needs a search. Pick inclusion-minimal.
10. **Gate the critical path.** A plan whose motivating case traps today needs a time-boxed go/no-go on the fix plus a fallback acceptance criterion, not a "must work at scale" line.
11. **Native query reachability.** Source containing `CAreClassesDisjointQuery` does not mean the wrapper can run it; spike before committing to a WASM rebuild.
12. **Do not let an acceptance oracle share the system under test.** Probe-class batching and the native query both use the same kernel; hand-check a sample independently.

## Why This Matters

Each item was a latent defect that would have surfaced only at implementation time, after a 20-30 min WASM rebuild cycle or a released API shape.

## When to Apply

- Reviewing any plan that adds a method composing kernel calls.
- Before fixing result types that callers map back onto their quads.

## Examples

Decisions taken in this review (project-specific, not generic):

- No exported `REPAIR_DEFAULTS` object and no `maxWeakenings`; defaults live in each option's JSDoc, `timeout` is the main bound.
- No experimental sub-path export for a single-consumer API: say "API may change" in the release notes instead.
- Piece order: C1 depends on A2 and the `*Direct` prep, not on A1; only C3 needs A1.

## Related

- Plan: `docs/plans/2026-11-05-003-feat-repair-weakening-assessment-in-reasoner-plan.md`
- `docs/solutions/architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md` (generation keying used for `baseline`)
