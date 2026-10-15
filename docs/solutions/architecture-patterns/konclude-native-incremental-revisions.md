---
title: Konclude's native incremental mechanism (ontology revisions) and our status
module: reasoner kernel / KoncludeReasoner
tags: [incremental, revision, classify, realize, native-harness]
problem_type: architecture
status: paused (2026-10-10)
updated: 2026-10-09
---

# Konclude native incremental reasoning

Goal (user): the Konclude kernel itself does incremental classify + realize on a kept-alive reasoner; the TS layer only maps quads to/from the N3 store.

## How upstream does it (verified in source)

- A new ontology **revision** = `new CConcreteOntology(previousOntology, config)`; its constructor calls `referenceOntology(prev)` (shares data boxes, string mapping, build data, triples data) and `setPreviousOntologyVersion(prev)` (`CConcreteOntology.cpp`). Used by `CSPOntologyRevisionManager` for every OWLlink "Tell".
- Updates are added to the new revision through the normal update builder (`CConcreteOntologyUpdateCollectorBuilder` + `addTriplesData` + mapper). The RDF parser chains each update's triples data to the previous one: `initTriplesData(updateType, builder->getLatestTriplesData(...))` (`CRDFRedlandRaptorParser::getUpdatingTripleData`).
- Incremental processing is selected per component from `COntologyIncrementalRevisionData` (axiom-change data, previous ontology versions): `CRealizationManager::getRealizer` picks `CIncrementalKPSetOntologyConceptRealizingThread` when `getPreviousClassTypesRealizedOntology() != nullptr` and only ABox axioms changed; there are also `CIncrementalPrecomputationThread` and `CIncrementalKPSetClassSubsumptionClassifierThread`.
- Revisions must stay alive: incremental code walks `getPreviousOntologyVersion()` chains.

## Our status (native prototype, `KoncludeReasoner::addRevisionNTriplesStr`, native-only)

- Today `reset()` builds a fresh `CConcreteOntology` per call (no revision chain), so nothing incremental is ever used.
- Prototype: derive a revision from the current ontology, keep the chain alive, add triples via the same loader. `konclude_repro --mode incr-abox --hold <iri>` holds back one individual's self-contained ABox triples (blank-node list cells stay in the base), realizes the base, adds the held triples as a revision, realizes again.
- Required loader fix (found by crash): the native `loadNTriplesStr` must keep **statement copies in a `CXLinker` list** like the production loader; the triple indexer stores `librdf_statement*` and model-stream statements dangle (`librdf_new_node_from_node ... NULL`).
- Result (Roberts, hold `dereck_heath`): the revision run's output equals the full-ontology oracle on **46 of 47 buckets**; only `isRelationOf` differs (the separate, known lossy bucket). So correctness through a revision is OK.
- But it is **not actually incremental yet**: the log shows the whole pipeline re-running (representative cache "updated 405 of 405 individual associations", KPSet classifier "Used 62 satisfiable tests", role classifier again). The incremental threads were not selected. Suspects: our WASM overrides `CPrecomputationManager` / `CClassificationManager` (and manager wiring) replace the upstream selection; `getPreviousClassTypesRealizedOntology()` is not set because nothing marks the base revision as realized.

## Findings 2026-10-10 (why it is paused)

1. **Setup mirrored.** `Konclude.Ontology.Revision.IncrementalRebuild` defaults to false; with it off the preprocessor never links previous built/consistent/classified/realized versions. With it on they are linked (prevCons/prevClassified/prevRealized non-null, ABox-only flag correct).
2. **Classification reuse works** but only if the base was classified by `CIncrementalKPSetClassSubsumptionClassifierThread` (the only KPSet variant recording individual-dependence tracking). Our forced plain KPSet classifier records none, so upstream falls back to full reclassification. The factory only picks the incremental one inside the `AutomatedOptimizedClassifierSelection` branch, which the port disables.
3. **Upstream incremental realization does not exist in this version.** `CIncrementalKPSetOntologyConceptRealizingThread::initializeIndividualProcessingKPSetsFromConsistencyData` has its entire body commented out (returns true, initializes no individual) -> revision output is only the taxonomy. The commented body is the blueprint for a real implementation: per individual, reuse the previous realization item's known same-individuals and known concept instances unless `isIndividualAffectedByIncrementalChanges` / `isIndividualItemAffectedByIncrementalChanges`, otherwise `extractKnownPossibleIndividualDataFromConsistencyData`. Roles are not covered at all (upstream is concept-only).
4. **Lifetime crash.** With incremental precomputation + classification and the FULL realizer on a revision, a tableau test segfaults in `removeSignatureBlockingBlockerFollowing` (`CQtManagedRestrictedModificationHash::findNode`, corrupt set): previous-revision data freed/reset (our cache resets, "free stale items at start of next call"). Needs an ownership audit of what the incremental precomputation reuses.
5. **Payoff is small on role-heavy data.** Roberts: realization is ~34 of ~37 s, nearly all role realization. Reusing classification/precomputation saves seconds. Only incremental role realization would matter.

Experiment files (not applied): `docs/experiments/` (patches 021/022, overrides diff).

## Next (if resumed, "option 3": our own incremental realization)

1. Fix the lifetime crash first (finding 4): audit what `CIncrementalPrecomputationThread` keeps from the previous consistency model; keep revision chain data alive.
2. Implement the commented-out reuse body for concepts; then design incremental role realization (new; none upstream), gated on the oracle comparison per bucket.
3. Until then the kept-alive reasoner gets its speed from caching its own results (C++ API units U6/U7), not Konclude's incremental threads.
