# Release Notes — v0.9.1

## Summary

v0.9.1 is a bug-fix release on v0.9.0. The public API is unchanged; upgrade is drop-in. v0.9.0 is deprecated on npm. Besides the blank-node fix it removes the intermittent slow role realization named in the known limits of v0.9.0 (same output, up to 8x the CPU time).

## Added

### `repair(store, { justifications })`

`repair()` accepts justifications the caller already holds (for example from `explainInconsistencyAxioms`). When at least one still holds on the store, the first explanation round and the initial consistency check are skipped. Each supplied justification is re-checked: it is dropped when a quad or declaration is no longer in the store, or when its axioms plus context are not inconsistent on their own. If none survives, `repair` explains as before. Repair sets are still verified and refined, so an incomplete list costs extra rounds, never an unverified result.

## Fixed

### Inferred blank nodes returned with a stray colon

On v0.9.0, a blank node asserted as `_:b1` came back in inferred triples as `_::b1` (a `BlankNode` with value `:b1`). Konclude names blank individuals `_:` + ontology name + `:` + label; the ontology name is empty here, so the internal name `_::b1` leaked into the output. Inferred triples therefore landed on a different node than the asserted one, and consumers such as SHACL validation saw the original node as untyped.

The output encoder now emits such individuals as blank nodes carrying the original label, so inferred triples attach to the asserted node. Regression test: `tests/integration/inferred-blank-node-label.test.ts`.

### Intermittent slow role realization (up to 8x CPU on the same input)

On v0.9.0, role realization sometimes took several times longer than usual for the same ontology and the same output. On the Roberts family ontology a normal run takes about 40 s (about 300 s of CPU summed over the worker threads); about one run in a few took 60 to 240 s (up to about 2400 s of CPU). The slow runs did not use more memory.

Cause: the kernel confirms "possible" role instances with one satisfiability test each. A pair that is only possible on a super-role (for example `isRelationOf`) is often already known on a sub-role (`isBloodRelationOf`, `isInLawOf`), and a known sub-role pair implies the super-role pair, so such a test can never add anything. The fix for lost role instances (late candidates are queued for confirmation immediately) created these tests before the sub-role's initialization had recorded the pair. How many ran depended on the order in which the kernel handled role messages, which follows pointer-keyed hash order and therefore varies between runs: zero in a good run, about 50,000 in a bad one (about 25 ms of CPU each). Unmodified upstream Konclude never confirms late candidates, which is why it never showed the slow mode.

Fix (in `patches/002-realizer-kernel-correctness.patch`): a role's confirmation tests start only once the role and all its sub-roles have finished initialization with no initialization test still in flight for them; other roles keep initializing and confirming in parallel. Before a test is created the pair is looked up on the sub-roles (complex role data, the individual's direct known links, the backend neighbour-label cache); if a sub-role knows it, the pair is marked known and no test runs.

## Tests

`tests/integration/explanation-persistence.test.ts` now uses the single shared reasoner instead of spawning an extra Worker per test. The extra Worker triggered the second-worker slow run named in the v0.9.0 known limits and made the 120 s timeouts flaky.

The extra Worker in that test is no longer needed to avoid the slow run, but the shared reasoner stays: it is faster and keeps the pthread pool unexhausted.

## Verification of the slow-run fix

- Native oracle comparison on Roberts: 3 of 3 runs equal to the pristine-upstream fingerprint (353,279 triples), with the first version of the fix and with the final one.
- Native Roberts, 12 fresh processes with the final fix: 277 to 328 s of CPU (ratio 1.18); before the fix the same measurement showed runs up to 1900 s. A traced build created no confirmation tests in 15 of 15 runs, as unmodified upstream does.
- WASM, Roberts materialize in 6 fresh processes: 33 to 35 s wall time, 211 to 222 s CPU. GALEN and PMDco wall times are on par with unmodified upstream.
- Full vitest suite on the rebuilt WASM: 712 passed, 9 skipped, 0 failed.

## Known limits

- The slow-run fix is verified on Roberts (where the problem was measured), GALEN and PMDco; other ontologies with deep role hierarchies were not measured.
- Other job queues in the realizer and classifier (same-individual tests, concept instantiation, KPSet classification) were not audited for the same ordering dependence; this is tracked in the repository plans.
- The Worker stall watchdog, `KonStall` detection and heap recycling are unchanged; they address heap exhaustion and lost completions, not the slow mode.
