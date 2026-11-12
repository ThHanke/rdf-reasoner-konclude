# Release Notes — v0.9.5

## Summary

v0.9.5 fixes `explainEntailment()` returning wrong justifications on a reasoner that has already run `checkConsistency()` and `materialize()` (the usual application order). The public API is unchanged except for one new optional result field. No performance work in this release.

## Renamed

- `justificationMode` is now `"fast"` (default, was `"causal"`) or `"exact"` (was `"minimal"`). The old names still work as deprecated aliases.

## Fixed

- **Wrong justification after `materialize`.** After `checkConsistency` + `materialize({ includeClassHierarchy: true })`, `explainEntailment` on the Fe-Si case returned `[some_silicon type PMD_0020050, PMD_0020050 subClassOf PMD_0090000]` (`exact`) or an unrelated axiom (`fast`). `PMD_0020050 subClassOf PMD_0090000` exists only in the inferred graph: the native classification cache stores a hierarchy edge as its own "justification", and a shortcut returned it as if it were an axiom. A fresh reasoner was not affected, which is why it went unseen.
  - `exact` never takes a shortcut now. It returns exactly HermiT's two justifications on the Fe-Si case, the same as a fresh reasoner (about 18 s; no cached state is reused for the search).
  - `fast` keeps its fast path, but every candidate is verified before it is returned: all triples must be asserted (never inferred-only) and the candidate alone must entail the target (one small reasoner check). A failing candidate is dropped. If none survives and the ontology is small (up to 2,000 quads), `fast` runs one bounded exact search (5 s) before giving up; larger ontologies answer `justificationUnavailable` immediately.
- **Empty list no longer means "asserted".** When `fast` cannot produce a sound justification, the result is `{ isEntailed: true, justifications: [], justificationUnavailable: true, reason }`. An asserted triple is returned as its own one-triple justification. Use `justificationMode: "exact"` to get the axioms.
- **`fast` after another explanation.** An `exact` search (or a shortcut check) leaves a probe ontology in the worker; a following `fast` call read native caches of that ontology and could report an entailed subsumption as not entailed. `fast` now classifies the base again only when no cached result exists for the synced content generation; otherwise it reads the native caches as they are.
- **`inferredGraph` is honoured everywhere in the explain path** (restriction synthesis used the hard-coded default graph).

## Changed

- **The reasoner instance remembers its inferred graph.** Any `inferredGraph` passed to a call (e.g. `materialize`) is remembered; later calls without the option use the last one, and all remembered graphs are excluded from the content digest and from explanation candidates. Passing `inferredGraph` on every call still works and is still recommended.
- New optional field `EntailmentResult.justificationUnavailable`.

## Application notes

- For "why is this entailed" on a store that holds inferred triples, use `justificationMode: "exact"` (may take seconds) or treat `justificationUnavailable` in `fast` as "ask again with `exact`".
- Put the inferred graph in `excludeGraphs` or pass `inferredGraph`; either keeps inferred triples out of the axiom set.

## Tests

Tests that expected a justification from the old unsound path (Roberts `Father ⊑ Parent`, justification matrix, track A) now accept a justification or an explicit `justificationUnavailable`.

- `tests/integration/explain-entailment-after-materialize.test.ts` (Fe-Si, Ontosphere procedure: exact mode, no inferred-only triple, fast mode sound, second call and no-option call).
- `tests/integration/explain-after-materialize-small.test.ts` (hierarchy chain, restriction-defined class).
