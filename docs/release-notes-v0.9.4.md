# Release Notes — v0.9.4

## Summary

v0.9.4 fixes the PMDco slowdown that started in v0.9.0 and is largest in the browser, without giving up the correct class hierarchies v0.9.0 introduced. On the Ontosphere PMDco fixture (`checkConsistency` then `materialize`, fresh reasoner, 8 cores) Chromium 158 goes from 17–19 s and about 113 CPU-seconds on v0.9.x to **2.0 s and about 13 CPU-seconds**; Node from 4.1 s to 1.9 s. Inferred triple sets are identical to v0.9.3 on every checked fixture. The public API is unchanged; the upgrade is drop-in apart from the runtime requirement below.

**One runtime requirement changes:** the WebAssembly module now uses native WebAssembly exception handling. It needs Chrome 95+, Firefox 100+, Safari 15.2+ or Node 17+ (`engines` stays `>=18`). Older runtimes cannot instantiate the module.

## Why v0.9.x was slow (and 0.8.0 was fast)

- Since v0.8.0 the KPSet classifier flushed its buffered possible-subsumption messages _after_ it had collected the items to test, so about 4,760 candidate subsumptions on PMDco (sibling pairs, almost all negative) were never tested. 0.8.0 was fast because it skipped that work, and its hierarchies could miss true subsumptions (PMDco repo fixture: 2 edges, Pizza: 70). Patch 009 (v0.9.0) fixed this; the cost is the tests unmodified native Konclude also runs (native: 9.6 s for this classification on one worker; this WASM build: 10.1–10.4 s on one pinned core).
- The tableau ends every OR-branching task with a C++ exception, about 324,000 per classification. One throw costs 3.1 µs in Node but 77–79 µs in Chromium (measured in situ, throw to catch): that was 25 of 35 CPU-seconds in the browser.

## Changed

- **Native WebAssembly exceptions** (`-fwasm-exceptions` instead of `-fexceptions`): Node CPU −20 %, Chromium CPU −30–35 % on PMDco.
- **Binaryen optimization at link time** (`--no-wasm-opt` removed): wasm 10.4 MB → 7.05 MB (about 2.1 MB gzipped). `--profiling-funcs` is now opt-in: `KONCLUDE_PROFILING_FUNCS=ON make build-wasm`.
- **`checkConsistency()` runs only up to Konclude's consistency step** instead of a full classification (consistency 2.4 s → 0.4 s on PMDco in Node). Classification is not a prerequisite of consistency; the native `consistency` command stops at the same point. `classify`/`materialize` reload the ontology afterwards, as `materialize` already did.
- **Patch 005 `or-branching-stop-flag`:** on the direct rule chain (`handleTask → tableauRuleProcessing → tableauRuleChoice → applyORRule → executeORBranching`) the task end after OR branching is a status flag instead of an exception. Every other path still throws. Chromium CPU 35 → 12.7 s, Node 11.2 → 10.2 s.

## Explanations

- **One search engine for all explanations.** `explain()`, `explainEntailment()` (`minimal` mode), `explainInconsistencyLaconic()` and `validate()` (errors and unsatisfiable-class warnings) had their own copies of a triple-level search that falls back to one reasoner probe per triple; on a 1 MB ontology `explainEntailment` in `minimal` mode did not finish in 10 minutes. They now share the engine `explainInconsistency` and `repair` already used: QuickXplain over axiom units plus a hitting-set tree, with a deadline. FeSi case from the HermiT comparison: both of HermiT's justifications, exactly, in about 18 s (`tests/integration/explain-entailment-hermit-fesi.test.ts`).
- `validate()` gets a `timeout` option (default 180 000 ms, same meaning as for the explain options).
- **Follow-up explanations reuse worker state.** `explainInconsistency`/`explainInconsistencyAxioms` cache their result per content generation (a repeated call on the same store: 2.9 s to 0.05 s on PMDco) and take the consistency verdict from the synced generation instead of re-syncing a filtered copy. The first explanation still needs about 60 consistency probes (about 2.7 s on PMDco); seeding it from the kernel's own clash information is open work.
- **Inferred triples must be excluded for explanations:** pass the graph that holds them (`inferredGraph`), otherwise an inferred triple counts as an axiom and explains itself (`tests/integration/explain-entailment-hermit-fesi.test.ts` documents it).
- Fe-Si SHACL case: the materialization contains the inferred type and the inverse links, so SHACL on data plus our inferred triples reports the one correct violation (`tests/integration/fesi-inverse-links.test.ts`).

## Known limits and open work

- The stop flag covers the direct chain only. Throws through the nested immediate-processing path, the other `CCalculationStopProcessingException(true)` sites (task completion, backend reuse, merging) and clash/error exceptions remain. A generator for the full conversion is scaffolded in `scripts/returncode/`.
- Classification still runs the ~4,760 sibling tests (same as native Konclude). The transitive-subsumption skip and re-enabling the pseudo-model pre-test were tried and gave no reduction.
- Two benchmark numbers did not improve against the recorded 0.8.0-era run and have not been investigated: Roberts family full realization is 8 % slower (27,471 → 29,640 ms), and the warm "unchanged content" call on Roberts takes 59 ms against 17 ms. GALEN, LUBM and LUBM + data are faster (−12 % to −29 %).
- PMDco wall time in Chromium varies by several seconds between runs when other work shares the machine; CPU-seconds are the stable figure.

## Verification

- Full vitest suite on the released tree: 756 passed, 9 skipped, 0 failed; Playwright browser suite: 13 passed (Chromium, including the Roberts family and LUBM comparisons with native Konclude).
- Inferred triples identical to the shipped v0.9.3 on Roberts family (352,108), LUBM, mini-family, GALEN, PMDco; blank-node round trip (real `BlankNode` terms, labels with `:` and non-ASCII) byte-identical to v0.9.3.
- Benchmarks and method: `docs/benchmark.md` §4 (PMDco) and §1–§3 (WASM columns re-measured; native Konclude and HermiT figures are the recorded ones).
