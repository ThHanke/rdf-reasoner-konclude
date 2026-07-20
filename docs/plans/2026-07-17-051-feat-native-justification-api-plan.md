# Native Justification API — v0.4.3 Plan

**Goal:** Expose Konclude's internal tableau axiom-dependency tracking through the WASM interface so entailment explanations become O(1) lookups instead of O(N log N) BlackBox searches.

**Problem:** The current `explainEntailment` uses a BlackBox algorithm that re-loads the full ontology into WASM 20-40 times per query (binary search + deletion pass), each taking ~200-500ms. Cold explanations take 5-13 seconds. Konclude is a tableau reasoner — during classification it tracks which GCI axioms fired to derive each inference via CDependencyTrackPoint chains. This data exists in C++ memory during reasoning but is transient (freed when task memory is released) and not exposed via the Embind WASM interface.

**Approach — Dep Chain Interception:** Override `CSatisfiableTaskClassificationMessageAnalyser` to walk each subsumer's dependency chain in the "golden window" (after tableau completion, before task memory release). Record which IMPLICATION dep nodes fired (GCI axiom applications) for each discovered subsumption. Use integer concept tags throughout; resolve to IRIs only on query.

## Research Phase (completed)

- [x] **R1: Locate tableau dependency tracking in Konclude source**

  CDependencyNode/CDependencyTrackPoint chains track backjumping at concept level (not axiom level). ~60 dep node types; IMPLICATION nodes correspond to GCI axiom firings. Created in `CDependencyFactory::createIMPLICATIONDependency()` (line 543). Controlled by `mConfBuildDependencies` flag (default true).

  Bridge to axioms: `CExpressionDataBoxMapping` provides CConcept* ↔ CClassTermExpression* ↔ CClassAxiomExpression* (persistent ontology data).

- [x] **R2: Determine dependency data lifetime**

  Dep chains are transient — allocated from `CProcessContext` task-scoped memory pools. Freed in `CTaskProcessorThread::processCompleteTask()` at line 146 (`releaseMemoryPoolContainer()`). BUT: callbacks fire BEFORE memory release (lines 130-138), and `analyseSatisfiableTask()` runs before `communicateTaskComplete()` (line 1614 vs 1649 in tableau algorithm). This is the **golden window** for interception.

- [x] **R3: Verify mapping chain works**

  Full chain confirmed:
  - `CSubClassOfExpression::getSubClassTermExpression()` / `getSuperClassTermExpression()` → `CClassTermExpression*`
  - `dynamic_cast<CClassExpression*>` → `CNameAssociator::getName()` → IRI string
  - `CExpressionDataBoxMapping::getConceptClassTermMappingHash()` → CConcept* ↔ CClassTermExpression*
  - `getClassTermExpressionClassAxiomExpressionHash()` → CClassTermExpression* → CClassAxiomExpression*

  Konclude has NO built-in explanation/justification computation. `CAreAxiomsEntailedQuery` provides boolean entailment testing only (potential faster BlackBox oracle — see memory: `project_entailment_oracle_optimization.md`).

### Go/No-Go Gate: PASS

Dep chain data is live during `analyseSatisfiableTask()`. IMPLICATION dep nodes carry concept descriptors mappable to axioms. Override of analyser captures all justifications generically — not limited to simple SubClassOf. Near-zero overhead (3-10 pointer chases per subsumer vs thousands of tableau operations per test).

## Supported Entailment Shapes

Native justification index covers:
- `rdfs:subClassOf` — subsumption justifications (direct, transitive, complex axiom interactions)
- `rdf:type` — instance classification justifications

All other shapes (`rdfs:subPropertyOf`, property assertions, `owl:sameAs`, etc.) fall back to BlackBox. Laconic justifications and HSDAG multi-justification enumeration also require BlackBox — they need an oracle that tests entailment of arbitrary axiom subsets, which pre-computed justifications cannot provide.

## Architecture — Three-Phase Design

### Phase 1: Pre-build axiom map (once, at classify() start)

Walk `CExpressionDataBoxMapping`. For each axiom, find its corresponding `CConcept*` via `mClassTermConceptHash`. Build:

```cpp
unordered_map<cint64, int> mConceptTagToAxiomId;  // concept tag → axiom index
vector<AxiomInfo> mAxiomTable;                      // axiom index → IRI data
```

O(N) where N = number of axioms. Maps GCI trigger concepts to their source axioms so dep chain walk can do O(1) integer lookups.

### Phase 2: Dep chain walk (during reasoning, per subsumer)

Override `CSatisfiableTaskClassificationMessageAnalyser::analyseSatisfiableTask()` in `src/compat/overrides/`. At line 1608, for each confirmed deterministic subsumer:

1. Walk `depTrackPoint → getDependencyNode() → getPreviousDependencyTrackPoint()` iteratively
2. For IMPLICATION nodes only: record concept tag → O(1) lookup into Phase 1 axiom map
3. Skip AND/MERGE/OR nodes (internal tableau mechanics, not axiom applications)
4. Stop at INDEPENDENT_BASE (root assertion, chain terminus)
5. Store: `(testingConceptTag, subsumerConceptTag) → vector<int>` (axiom IDs)

Chain length: typically 2-5 nodes for direct subsumptions, 5-15 for complex. Near-zero overhead on classification.

### Phase 3: Resolve to IRIs (on query, O(1))

When `getSubClassJustification(subIri, superIri)` is called:
1. Map IRIs → concept tags via existing `mConceptByIri`
2. Look up axiom IDs from Phase 2 cache
3. Resolve axiom IDs → NTriples via `mAxiomTable`

### Cost Summary

| Phase | When | Cost |
|-------|------|------|
| Axiom map build | Once before classify | O(num_axioms) |
| Dep chain walk | Per subsumer found during reasoning | O(chain_length) ≈ 3-10 pointer chases |
| IRI resolve | Per query at runtime | O(1) |

## Implementation Phase

- [ ] **I1: Pre-build axiom map**

  In `KoncludeReasoner::Impl`, add `mConceptTagToAxiomId` and `mAxiomTable`. Populate from `CExpressionDataBoxMapping` before `prepareOntology()`. Walk `mClassTermConceptHash` and `mClassTermClassAxiomSet` to map concept tags to axiom descriptors. Clear on `reset()`.

- [ ] **I2: Override CSatisfiableTaskClassificationMessageAnalyser**

  Create `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp`. Copy the original `analyseSatisfiableTask()` method. Add dep chain walk in the subsumer extraction loop (after line 1616 condition). Walk IMPLICATION dep nodes, collect axiom IDs, store in shared cache. Cache must be accessible from `KoncludeReasoner::Impl` — use a global or thread-safe shared pointer.

  **Key constraint:** The analyser runs on KPSet worker threads (parallel). Cache writes must be thread-safe — use a mutex or lock-free structure. Since each (testingConcept, subsumer) pair is unique to one task, a concurrent hash map with pair keys avoids contention.

- [ ] **I3: Add C++ query methods + Embind**

  ```cpp
  // Returns justification as NTriples string (axioms that justify the subsumption)
  std::string getSubClassJustification(const std::string& subIri, const std::string& superIri);
  std::string getTypeJustification(const std::string& individualIri, const std::string& classIri);
  bool hasNativeJustification(const std::string& subIri, const std::string& superIri);
  ```

  Register in `bindings.cpp`. Add worker dispatch cases in `ts/worker.ts`.

- [ ] **I4: TS wrappers + fast-path in explainEntailment**

  Add TS methods in `ts/index.ts`. When the justification index has data for the query (`rdfs:subClassOf`, `rdf:type`), return directly (O(1)). Fall back to BlackBox for unsupported shapes, laconic justifications, multi-justification enumeration, or when the index is empty.

- [ ] **I5: Tests + benchmark**

  - Unit test: justification returned matches expected axioms for Roberts ontology
  - Unit test: transitive subsumption justification collects axioms along path
  - Unit test: complex axiom justification (intersection, restriction) captured correctly
  - Benchmark: compare cold explanation time before/after (target: <5ms vs current 5-13s)

## Risks

- **Thread safety in dep chain cache:** KPSet runs parallel workers. Mitigate with per-thread local buffers merged after classification, or a concurrent map.
- **IMPLICATION dep node coverage:** Not all subsumptions go through IMPLICATION nodes — some come from AND-expansion, saturation, or merging. If coverage is incomplete, fall back to BlackBox for missing entries.
- **Override maintenance:** Overriding `analyseSatisfiableTask()` means copying ~600 lines of vendor code. Upstream changes require manual diff. Keep override minimal — add only the dep chain walk, don't restructure existing logic.
- **WASM memory:** Storing justifications for all subsumptions in large ontologies. Mitigate with integer-only storage (concept tags, not strings) and lazy IRI resolution.

## Relationship to Plan 050

Plan 050 ports the existing BlackBox approach into the package API. This plan (051) replaces the BlackBox's inner loop with direct C++ lookups for supported shapes. Plan 050's `explainEntailment` method structure remains — only the oracle changes from "re-encode + re-load + re-reason + consistency check" to "index lookup". If I2 shows incomplete IMPLICATION coverage, plan 050's BlackBox is the fallback and remains correct.

**Follow-up optimization:** `CAreAxiomsEntailedQuery` can serve as a much faster BlackBox oracle — tests entailment on the existing in-memory ontology without reloading. See memory: `project_entailment_oracle_optimization.md`.
