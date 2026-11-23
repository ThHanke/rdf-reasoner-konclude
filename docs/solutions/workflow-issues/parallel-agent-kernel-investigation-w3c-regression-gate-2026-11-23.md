---
title: "Parallel read-only investigation agents for kernel gaps, verified against the W3C suite"
date: 2026-11-23
category: workflow-issues
module: konclude-kernel
component: development_workflow
problem_type: workflow_issue
severity: medium
applies_when:
  - "several independent kernel bugs need root causes and candidate patches"
  - "a vendored C++ kernel is patched and a native test binary exists (konclude_repro)"
  - "a recorded per-test verdict table is available to use as a regression gate"
symptoms:
  - "agents skipped the mandatory graphify step"
  - "agent patches are untested until applied: gdb emulation is not a build"
resolution_type: workflow_improvement
tags: [agents, graphify, gdb, native-repro, w3c-tests, regression-gate, wasm-rebuild]
---

# Parallel read-only investigation agents for kernel gaps, verified by the orchestrator

## Context

After adopting PR #18, ten kernel and TypeScript gaps were open (wrong W3C verdicts, a wasm stall). Each needed a call-chain trace through Konclude's C++, which is slow to do one at a time and easy to get wrong. The work was split across agents that only investigate and propose; the orchestrator applies and verifies.

## Guidance

**Agent brief** (one agent per gap): the goal; the evidence so far (verdicts, fixtures in `tests/fixtures/`); the files to read; constraints (read-only, no edits to `vendor/`, `patches/`, `ts/`, `src/`, no rebuild, no `pkill -f`, scratch only under `/tmp/<agent>/`); mandatory graphify (`graphify explain` / `path` with the graph in `vendor/konclude/Source/Reasoner/graphify-out/`); deliverable: root cause with the call chain, a unified diff checkable with `git -C vendor/konclude apply --check`, the native inputs and verdicts, risks, tests to add.

**Native test binary:** `build-native-ordered/konclude_repro`, ops `k` (consistency), `c` (classification), `m` (realization): `REPRO_CONTINUE=1 konclude_repro --timeout 40 --seq "k:/abs/file.nt"`. "not ok" means inconsistent. gdb function breakpoints are reliable, line numbers may be off.

**Orchestrator loop:** apply the proposals one batch at a time in sequence (`git apply --ignore-whitespace`), rebuild the native binary and rerun the agents' inputs, rebuild the wasm, run the full vitest suite, run the W3C consistency harness (raw and normalized) and compare per test with the recorded verdicts, bisect any patch that regresses. Fold the working ones into the patch files with a tree-hash check (see [the fold doc](fold-vendor-patches-and-npm-release-2026-11-09.md)).

**This session:** round 1 four agents (data cardinality, float/double, XML literals, 035/105), round 2 six agents (float discrete, `Minus_Infinity`, 008/012/035, `one_two`, the stall, entailment design). About 14 kernel and TypeScript fixes; W3C consistency 247 to 265 of 266.

## Why This Matters

Tracing and proposing parallelises well and the orchestrator keeps one consistent tree. The W3C gate catches regressions the targeted tests miss (it found `miscellaneous-202`, a gap in the store fast path).

## When to Apply

Several independent wrong verdicts with a native repro; read-only reasoning dominates the cost.

## Examples

- `excludeValue` in `CDatatypeRealValueSpaceMap` compared the maximum with `isGreaterThan` instead of `isLessThan`, dropping a negated literal inside an OR branch (`Minus_Infinity_is_not_in_owl_real`). The agent emulated the fix with a gdb `jump` on the unpatched binary, which showed the effect before any rebuild.
- Float discrete: the first float patch (including relaxing the single-node check) left the empty interval consistent natively. A second agent's gdb trace found the real cause, an inverted test at the last map point of `CDatatypeCompareValueSpaceMap::getNextPossibleDataValue`.
- The wasm "stall": an agent compared native and wasm log sequences and a `ulimit -s` sweep and found the stack overflow ([the stall doc](../runtime-errors/wasm-pthread-stack-overflow-realization-stall-2026-11-23.md)).

**Pitfalls:** agents sometimes skipped graphify (the orchestrator checks); some conclusions were wrong (a lexical-form hypothesis for `Minus_Infinity` was refuted; the null guard did not fix the wasm stall); gdb emulation proves the effect, not the compiled patch. Always verify on the real binary and the wasm.

## Related

- [`docs/pr18-handover.md`](../../pr18-handover.md), [`docs/pr18-adoption-decisions.md`](../../pr18-adoption-decisions.md)
- [`pr18-known-conformance-gaps-2026-11-23.md`](../capability-gaps/pr18-known-conformance-gaps-2026-11-23.md)
- [`native-debug-pipeline-playbook.md`](../best-practices/native-debug-pipeline-playbook.md)
