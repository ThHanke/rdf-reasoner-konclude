# Incremental-revision experiments (2026-10-10, not applied)

Parked, NOT in `patches/ENABLED`. Reapply by hand when picking up "incremental realization of our own".

- `021-incremental-classifier-selection.patch` (+ `mod_021_*.py`): factory picks `CIncrementalKPSetClassSubsumptionClassifierThread` for base ontologies and ABox-only revisions even with `AutomatedOptimizedClassifierSelection=false`. The base must use it because only it records individual-dependence tracking that later revisions reuse.
- `022-realizer-selection.patch` (+ `mod_022_*.py`): `getRealizer` never picks the stub incremental realizer.
- `incremental-revision-overrides.diff`: `Konclude.Ontology.Revision.IncrementalRebuild=true` in `WasmConfigProvider` (needed so the preprocessor links previous built/consistent/classified/realized versions), native-only `INCR` diagnostic in `runPipeline`, `CClassificationManager` / `CPrecomputationManager` overrides with two singletons each (incremental kind for base + ABox-only revisions, plain kind otherwise).

Result: classification reuse works (0 ms on an ABox-only revision), but (1) upstream's incremental concept realizer is a stub, and (2) with incremental precomputation + classification the full realizer's tableau tests segfault (`removeSignatureBlockingBlockerFollowing`, corrupt hash: reads freed previous-revision data). See `docs/solutions/architecture-patterns/konclude-native-incremental-revisions.md`.
