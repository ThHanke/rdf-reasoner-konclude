---
title: WASM suite status after patch 019 (failure triage)
date: 2026-10-09
module: tests/integration
tags: [wasm, sequential-calls, triage]
problem_type: test-failure-triage
---

# WASM suite status (573 pass / 10 fail / 3 skip)

All 10 failures share one root class: **the second or later reasoning call on the same WASM reasoner instance** (known sequential-call bug: reset+reload orchestration, see `project_sequential_call_hang`). No failure is a first-call defect; none is a timing-threshold issue.

| Failures | Evidence | Class | Owner |
| --- | --- | --- | --- |
| `hang-debug` (2), `hang-minimal` (3), `warmup-sequential` (2) | explicit multi-call tests, 120 s timeouts | sequential-call hang | U5-U7 (rewrite for new API) |
| `property-characteristics`: `disjointUnionOf`, `NegativePropertyAssertion` | Pass alone (`-t`, ~1 s each); native harness on extracted fixtures (`tests/fixtures/pc-*.nt`) completes in 0.2 s; CLI fresh process 1.3 s. They are calls 8 and 9 on the file's shared reasoner and both time out after 7 passing calls | sequential-call hang (NOT a small-ontology bug; the earlier "fails in isolation" note was wrong) | U5-U7 |
| `explanation-perf` "materialize" | Fresh process, first call with `explanations:true`: OK (31-34 s, 361 792 triples, 3/3). In the test (baseline materialize, then explanations materialize on the same reasoner): run 1 `RangeError: Invalid typed array length: -545` in `parseStringTable` (corrupt result buffer on call 2), run 2 hang (300 s timeout) | sequential-call corruption/hang; the "timing ratio" diagnosis was wrong. 500 % threshold is untouched | U5-U7 |

## Consequences

- U3 closes as "reclassified": nothing to fix in the kernel for these two ontologies. Fixtures `tests/fixtures/pc-disjoint-union.nt` / `pc-negative-property.nt` kept as native regression inputs.
- After the incremental API lands, rewrite `property-characteristics` and `explanation-perf` to create one reasoner per file section or to use the new idempotent calls; then re-measure the explanation overhead before touching any threshold.
- Decode of a corrupt result buffer should fail with a clear error rather than a RangeError (small hardening in `ts/intern.ts`, optional).
