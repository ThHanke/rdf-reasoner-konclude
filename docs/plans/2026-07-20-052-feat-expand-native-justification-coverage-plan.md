---
title: "feat: Expand native justification coverage beyond subClassOf"
type: feat
status: completed
date: 2026-07-20
origin: docs/plans/2026-07-17-051-feat-native-justification-api-plan.md
---

# Expand Native Justification Coverage Beyond SubClassOf

## Overview

v0.5.0 ships a native justification fast-path (~1ms) that only covers `rdfs:subClassOf` and `rdf:type`-via-subClassOf-chain. Everything else falls back to 5-13s BlackBox. This plan defines the research needed to expand native coverage to property restrictions, intersectionOf/unionOf, equivalentClass, owl:sameAs, and domain/range — then produce an implementation plan from the findings.

## Problem Frame

The JustificationCache intercepts dep chains during **classification only**, in the subsumer extraction loop of `CSatisfiableTaskClassificationMessageAnalyser`. This misses:

1. **rdf:type from property restrictions** — e.g. `bob rdf:type Manager` inferred via `∃manages.Employee ⊑ Manager`
2. **rdf:type from intersectionOf/unionOf** — complex class expressions
3. **rdf:type from equivalentClass** — unless it maps to a subClassOf taxonomy edge
4. **owl:sameAs** — individual identity entailments
5. **rdfs:domain/rdfs:range** — property type inferences
6. **owl:equivalentClass** — direct justifications

The gap exists because: (a) the analyser override only fires during classification, not realization; (b) dep chain tags are stored without type discrimination; (c) `buildInferredTripleBuffer` already reconstructs WHY each triple was inferred but discards the reason.

## Requirements Trace

- R1. Identify which Konclude internal data structures carry justification evidence for each gap type
- R2. Identify the interception points (golden windows) in the reasoning pipeline for each gap type
- R3. Determine which gaps can be covered by extending the existing analyser vs. requiring new overrides
- R4. Determine which gaps are covered by TS-side workarounds (someValuesFrom fixpoint, FP/IFP sameAs, etc.) and how to synthesize justifications from workaround data
- R5. Map ontosphere PR #20's application-level explanation patterns to native equivalents
- R6. Produce a ranked implementation plan based on coverage impact and implementation complexity

## Scope Boundaries

- Research and investigation only — no code changes
- No changes to the BlackBox fallback path
- No changes to the laconic justification module
- Focus on what's achievable by intercepting existing Konclude state, not adding new reasoning capabilities

### Deferred to Separate Tasks

- Implementation of any new interception points (separate plan from R6 findings)
- `CAreAxiomsEntailedQuery` as faster BlackBox oracle (see memory: `project_entailment_oracle_optimization.md`)
- Property subsumption (`rdfs:subPropertyOf`) justification

## Context & Research

### Relevant Code and Patterns

- `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` — current interception point (lines 1624-1645)
- `src/JustificationCache.h` — thread-safe singleton, `(subTag, superTag) → vector<int64_t>` dep tags
- `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` (line ~1459), `getSubClassJustification()` (line ~530), `buildAxiomMap()` (line ~519)
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp` — analyser chain (lines 1612-1629): mClassMessAnalyser → mSatTaskPropClassAnalyser → mMarkerPropRealMessAnalyser → mPossAssCollAnalyser → mSatTaskCompAnswerAnalyser → mSatTaskPropBindingAnswerAnalyser
- `vendor/konclude/Source/Reasoner/Kernel/Process/Dependency/CDependencyNode.h` — dep node type enum (lines 75-97)
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CSatisfiableTaskMarkerIndividualPropagationAnalyser.h` — realization marker propagation
- `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CSatisfiableTaskPossibleAssertionCollectingAnalyser.h` — realization assertion collector

### Existing Dep Node Types (from CDependencyNode.h)

| Type | OWL construct | Currently captured? |
|------|--------------|-------------------|
| IMPLICATION | GCI axiom firing | Yes (as concept tag) |
| AND | intersectionOf expansion | Yes (tag only, no structure) |
| OR | unionOf expansion | Yes (tag only) |
| SOME | someValuesFrom | Yes (tag only) |
| ALL | allValuesFrom | Yes (tag only) |
| MERGED_CONCEPT/LINK/INDIVIDUAL | sameAs, nominals | Yes (tag only) |
| FUNCTIONAL | functional property | Yes (tag only) |
| ATLEAST/ATMOST | cardinality | Yes (tag only) |
| CONNECTION | domain/range | Yes (tag only) |
| SAME_INDIVIDUALS_MERGE | sameAs merging | Yes (tag only) |
| ROLE_ASSERTION | role assertions | Yes (tag only) |
| INDEPENDENT_BASE | chain terminus | Yes (stop signal) |

### Six Analyser Golden Windows

All fire in sequence after tableau completion, before task memory release:

1. **mClassMessAnalyser** — classification subsumer extraction (**currently overridden**)
2. **mSatTaskPropClassAnalyser** — property hierarchy classification
3. **mMarkerPropRealMessAnalyser** — realization marker propagation
4. **mPossAssCollAnalyser** — realization assertion collecting
5. **mSatTaskCompAnswerAnalyser** — complex answering
6. **mSatTaskPropBindingAnswerAnalyser** — propagation binding

### TS-Side Workarounds (bypass tableau — no dep chains)

These OWL 2 DL features are handled as pre/post-processing workarounds, NOT native Konclude reasoning:
- FP/IFP sameAs pairs — pre-scan + skip + JS emit
- someValuesFrom — blank-node structure scan + fixpoint at build time
- disjointUnionOf — RDF list walk
- oneOf — RDF list walk → member rdf:type
- minCardinality — restriction scan + distinctness check

Justification for workaround-covered entailments must be **synthesized from workaround input data**, not intercepted from dep chains.

### Ontosphere PR #20 Reference

https://github.com/ThHanke/ontosphere/pull/20

Application-level explanation implemented outside Konclude:
- `explainEntailment` via entailment-as-unsatisfiability reduction (BlackBox — already ported as plan 050)
- MIPS extraction for inconsistency diagnosis
- Laconic justification post-processing (Horridge et al.) — already ported as plan 050
- Module extraction via syntactic locality for incremental reasoning
- Property-characteristic mode awareness (FP, IFP, Irreflexive, Asymmetric)
- `getUnsatisfiableClassBuffer()` and `explainInconsistency()` Konclude API calls

Key insight: ontosphere did all this APPLICATION-SIDE because Konclude has no built-in explanation. Now we're INSIDE Konclude — we can intercept reasoning phases directly. PR #20's coverage map tells us what entailment types users actually need explained.

## Key Technical Decisions

- **Research-first**: This plan produces findings and a follow-up implementation plan. No code ships from this plan.
- **Prioritize by buildInferredTripleBuffer coverage**: The types already traced in `buildInferredTripleBuffer` are the ones users see as inferred triples and want explained. That's the coverage map.
- **Override vs. augment**: Prefer augmenting the existing analyser override and `buildInferredTripleBuffer` over creating new overrides, unless the golden window is different.

## Implementation Units

- [x] **R1: Audit dep node type content in the golden window**

**Goal:** Determine what information each dep node type actually carries beyond the concept tag — do SOME/ALL/MERGED/CONNECTION nodes carry role IRIs, individual references, or axiom-level data that could identify the source axiom?

**Requirements:** R1

**Files:**
- Read: `vendor/konclude/Source/Reasoner/Kernel/Process/Dependency/CDependencyNode.h`
- Read: `vendor/konclude/Source/Reasoner/Kernel/Process/Dependency/CIMPLICATIONDependencyNode.h` (and SOME, ALL, MERGED, CONNECTION, ROLE_ASSERTION variants)
- Read: `vendor/konclude/Source/Reasoner/Kernel/Process/Dependency/CDependencyFactory.cpp` — how each type is created, what fields are populated
- Read: `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp` — current walk logic

**Approach:**
- For each dep node type in CDependencyNode.h enum, find the corresponding concrete class
- Document what fields each carries: concept descriptor, role, individual, link, source axiom reference
- Determine if any types carry back-pointers to the CAxiomExpression or CClassAxiomExpression that created them
- Check CDependencyFactory to see what data is populated at creation time
- Produce a table: dep type → fields → OWL construct → can we recover source axiom?

**Verification:** Table of dep node types with field inventories. Clear answer on which types carry axiom-level data vs. just concept tags.

---

- [x] **R2: Map realization pipeline analysers for rdf:type interception**

**Goal:** Determine if the realization-phase analysers (mMarkerPropRealMessAnalyser, mPossAssCollAnalyser) have a golden window equivalent to the classification analyser, and what data is available there for rdf:type justifications.

**Requirements:** R2, R3

**Dependencies:** R1

**Files:**
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CSatisfiableTaskMarkerIndividualPropagationAnalyser.h` and `.cpp`
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CSatisfiableTaskPossibleAssertionCollectingAnalyser.h` and `.cpp`
- Read: `vendor/konclude/Source/Reasoner/Kernel/Task/CSatisfiableTaskRealizationMarkedCandidatesMessageAdapter.h`
- Read: `vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp` — lines 1612-1629 and surrounding context
- Read: `vendor/konclude/Source/Reasoner/Realization/CConceptRealization.cpp` — how realization results are assembled

**Approach:**
- Trace the realization pipeline: what tasks are submitted, which analysers process them, what data flows through
- Determine if the realization analysers receive dep track points for individual-type inferences
- Check if the same CDependencyTrackPoint chains are available during realization tasks
- Identify whether an override of one of these analysers could capture (individual, type, dep-chain) tuples
- Document the data available: individual identity, concept/type being tested, dep chain if any

**Verification:** Clear answer on whether rdf:type justification can be captured during realization, and which analyser to override.

---

- [x] **R3: Audit buildInferredTripleBuffer reconstruction logic**

**Goal:** Map how `buildInferredTripleBuffer` traces each entailment type (someValuesFrom, equivalentClass, sameAs, domain/range, object properties) and determine if this reconstruction can double as justification evidence.

**Requirements:** R1, R3

**Files:**
- Read: `src/KoncludeReasoner.cpp` — `buildInferredTripleBuffer()` method, all branches
- Read: `src/KoncludeReasoner.cpp` — workaround sections (someValuesFrom fixpoint, FP/IFP, disjointUnionOf, oneOf, minCardinality)

**Approach:**
- For each entailment type emitted by `buildInferredTripleBuffer`, document:
  - Which Konclude data structure it reads (CTaxonomy, CConceptRealization, CRoleRealization, CSameRealization, etc.)
  - What the input data is (taxonomy edges, realization visitors, ABox linkers)
  - Whether the input data carries enough context to construct a justification (which axioms caused this inference)
  - Whether domain/range appears as GCI subsumption in the taxonomy (Konclude compiles `domain(R,C)` into `∃R.⊤ ⊑ C`)
- For each workaround-emitted type, document what input data the workaround uses and whether that data can be packaged as a justification
- Produce a coverage map: entailment type → data source → justification feasibility → effort estimate

**Verification:** Coverage matrix with feasibility ratings (native/synthesized/not-feasible) for each entailment type.

---

- [x] **R4: Analyse ontosphere PR #20 explanation patterns**

**Goal:** Map ontosphere PR #20's explanation code paths to determine what it covers, how it works, and which patterns we can replace with native interception.

**Requirements:** R5

**Files:**
- Read: ontosphere PR #20 source at https://github.com/ThHanke/ontosphere/pull/20
  - `src/workers/rdfManager.runtime.ts` — KoncludeReasoner class, explain methods
  - `src/workers/entailmentProbe.ts` — probe builder (already ported)
  - `src/workers/laconicJustification.ts` — laconic module (already ported)
  - Any test/conformance files for explanation coverage

**Approach:**
- List every entailment type that ontosphere explains (subClassOf, rdf:type, sameAs, property assertions, etc.)
- For each, document: what oracle is used, what pre/post-processing happens, what the user sees
- Identify which patterns are pure BlackBox (can't be sped up natively) vs. patterns that reconstruct justification from known state (can be replaced)
- Note any property-characteristic awareness (FP, IFP, Irreflexive, Asymmetric) and whether we handle those
- Compare against our current native coverage + BlackBox fallback — identify the gap

**Verification:** Side-by-side coverage comparison table: ontosphere vs. rdf-reasoner-konclude, with gap list.

---

- [x] **R5: Investigate CConcept→axiom reverse mapping for complex expressions**

**Goal:** Determine if there's a path from internal concept tags (used in dep chains and taxonomy) back to the source OWL axioms that created complex class expressions (intersectionOf, unionOf, someValuesFrom restrictions).

**Requirements:** R1, R5

**Dependencies:** R1

**Files:**
- Read: `vendor/konclude/Source/Reasoner/Ontology/CConcreteOntology.h` — what data boxes are available
- Read: `vendor/konclude/Source/Reasoner/Ontology/COntologyDataBoxes.h` — expression mapping containers
- Read: `vendor/konclude/Source/Parser/Expressions/CExpressionDataBoxMapping.h` — the mapping we tried in v0.5.0 (sparse for triple-buffer path)
- Read: `vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp` — how `mapTriples()` creates CConcept structures from librdf triples

**Approach:**
- The v0.5.0 experience showed CExpressionDataBoxMapping is sparse for the triple-buffer loading path (~6 of ~60 axioms). Investigate WHY — does `mapTriples()` create CConcepts without corresponding CClassTermExpressions?
- Check if `mapTriples()` stores any back-reference from the CConcept it creates to the source triple/axiom
- Look at how complex class expressions (someValuesFrom, intersectionOf) are normalized into CConcept trees — is there a mapping from concept tag back to the RDF triples that defined the restriction?
- Check CConcept's own fields: does it carry an operand list, role pointer, or filler concept that could be used to reconstruct the source axiom?
- Investigate the concept operand structure: `getOperandList()`, `getRole()`, `getConceptOperator()` — can these be traversed to reconstruct the OWL axiom?

**Verification:** Clear answer on whether concept-tag-to-axiom reverse mapping exists for complex expressions, and if not, what alternative approaches are viable.

---

- [x] **R6: Synthesize findings into implementation plan**

**Goal:** Produce a prioritized implementation plan based on R1-R5 findings.

**Requirements:** R6

**Dependencies:** R1, R2, R3, R4, R5

**Approach:**
- Rank each entailment type by: (a) user-facing impact (how often users need this explained), (b) implementation feasibility (from R1-R5 findings), (c) effort estimate
- Group into phases: Phase 1 = high-impact/low-effort, Phase 2 = medium, Phase 3 = hard/speculative
- For each type, specify: interception strategy (analyser override / buildInferredTripleBuffer augmentation / workaround synthesis / BlackBox-only), files to modify, cache structure changes needed
- Document which types remain BlackBox-only and why
- Write as a new plan document (053-feat-...) ready for ce-work execution

**Verification:** New plan document with implementation units, file paths, and dependency ordering.

## Research Findings (R1–R5)

### R1: Dep Node Type Content Audit

**Critical finding: Zero axiom back-pointers in dep nodes.** No dependency node type carries a pointer to `CAxiomExpression` or any axiom-level object. However, CConcept (reachable via every dep node's `CConceptDescriptor`) is rich:

| Field | Accessor | Recovers |
|-------|----------|----------|
| Operator code | `getOperatorCode()` | Expression type: CCSOME, CCALL, CCAND, CCOR, CCATLEAST, CCATMOST, CCNOT, CCSUB, CCEQ, CCNOMINAL, CCSELF, CCVALUE |
| Role | `getRole()` → `getPropertyNameLinker()` | Property IRI for restrictions |
| Operands | `getOperandList()` | Child CConcepts as `CSortedNegLinker<CConcept*>` (with negation flag per operand) |
| Parameter | `getParameter()` | Cardinality for ATLEAST/ATMOST |
| Class name | `getClassNameLinker()` | IRI for named classes |
| Nominal | `getNominalIndividual()` | Individual for CCNOMINAL |
| Tag | `getConceptTag()` | Unique integer ID (what current cache stores) |

**Key structural findings:**

1. **Current walk discards everything except concept tags.** The analyser override (lines 1624-1645) only collects `concept->getConceptTag()`, ignoring dep node type, operator code, role, individual, cardinality, and additional dependency branches.

2. **Role IRIs reachable for all quantified types** via `concept->getRole()->getPropertyNameLinker()` for SOME, ALL, SELF, VALUE, ATLEAST, ATMOST, FUNCTIONAL, QUALIFY dep nodes.

3. **ROLE_ASSERTION is the only type with dedicated extra fields** (`mBaseAssertionRole`, `mBaseAssertionIndi`) directly on the dep node itself. All other types encode information through CConcept.

4. **Additional dependencies (mAdditionalAfterDepLinker) form branching paths.** Current walk only follows `getPreviousDependencyTrackPoint()` (single chain), missing branches on ALL (link dep), FUNCTIONAL (two link deps), VALUE/NOMINAL (nominal dep), MERGEDCONCEPT/MERGEDLINK (merge step dep), IMPLICATION (trigger deps), SAMEINDIVIDUALSMERGE (merge dep).

5. **Dep node type enum is diagnostic** — DNTSOMEDEPENDENCY vs DNTALLDEPENDENCY vs DNTIMPLICATIONDEPENDENCY tells you what OWL construct drove that reasoning step.

Full per-type inventory (30+ types) documented in R1 agent output. Key types for justification:

| Dep Type | OWL Construct | Extra Data | Axiom Recovery |
|----------|--------------|------------|----------------|
| INDEPENDENT_BASE | Root/TBox assertion | (none) | Concept tag IS the asserted class |
| AND | Intersection / GCI unfolding | (none) | Via concept's operandList |
| SOME | owl:someValuesFrom | (none) | concept→getRole() + operands |
| ALL | owl:allValuesFrom | mPrevLinkDep (role edge) | concept→getRole() + operands |
| IMPLICATION | Absorbed GCI | prevOtherDependencies* | Via concept operands |
| FUNCTIONAL | FunctionalProperty | mPrevLink1Dep, mPrevLink2Dep | Two link deps = merged role edges |
| ROLE_ASSERTION | ABox role assertion | mBaseAssertionRole, mBaseAssertionIndi | **Direct**: role IRI + individual IRI |
| SAME_INDIVIDUALS_MERGE | owl:sameAs | mAddMergeDep | Via individual node |
| CONNECTION | Role propagation | (none, dual inheritance) | Via concept |

---

### R2: Realization Pipeline Analyser Mapping

**Critical finding: Analysers NEVER run when an instance IS proved.**

The realization pipeline tests "Is `I : NOT(C)` satisfiable?" A clash = `I : C` is entailed. But the analyser chain (lines 1612-1629 in `CCalculationTableauCompletionTaskHandleAlgorithm.cpp`) is inside the `if (satisfiable)` block — it only runs when the individual is NOT an instance. When clashed (lines 1499-1507), the task returns `result=false` and analysers are skipped.

**Realization pipeline flow:**
```
Realizer Thread (COptimizedRepresentativeKPSetOntologyRealizingThread)
  → createNextConceptInstantiationTest()
    → getSatisfiableCalculationJob(concept, negated=true, indiRef)
    → Adapters: PossibleAssertionCollecting, PossibleInstancesMerging
    → NO ClassificationMessageAdapter, NO MarkerCandidatesAdapter
    
  Tableau runs:
    IF SATISFIABLE (NOT an instance): analysers run (useless for justification)
    IF CLASHED (IS an instance): result=false, completed=true, NO ANALYSERS
    
  → realizingTested(): only boolean flows back, no dep chain
```

**Recommended approach: Option C — inject justification hook on the clash path.**

At `CCalculationTableauCompletionTaskHandleAlgorithm.cpp` line 1342-1351, the catch block receives `CClashedConceptDescriptor*` which carries:
- `getConcept()` — the clashing concept
- `getDependencyTrackPoint()` — full dep chain root for the proof
- `getNext()` — linked list of all clash contributors

This IS the justification for `I : C`. A custom hook at line ~1505 (inside the `if (clashed)` block) could check for a realization adapter and extract clash deps into the JustificationCache.

---

### R3: buildInferredTripleBuffer Reconstruction Audit

**Architecture:** `buildInferredTripleBuffer()` (lines 1459-1973) has two sections:
1. **Native C++ reconstruction** — reads CTaxonomy, CRealization (concept/role/same), individual linkers
2. **Workaround emission** — reads pre-parsed Impl structures from `loadTripleBuffer()`

**Coverage matrix:**

| # | Entailment Type | Data Source | Justification Feasibility | Effort |
|---|----------------|-------------|--------------------------|--------|
| 1 | rdfs:subClassOf | CTaxonomy → CHierarchyNode Hasse edges | **NATIVE (done)** | Done |
| 2 | owl:equivalentClass | CTaxonomy → same CHierarchyNode, multiple IRI keys | SYNTHESIZED (easy) | Low |
| 3 | rdf:type (concept realization) | CConceptRealization → visitAllTypes | SYNTHESIZED (partial) | Medium |
| 4 | Object property assertions | CRoleRealization → visitSourceIndividualRoles | **NOT FEASIBLE (native)** | High |
| 5 | owl:sameAs (native) | CSameRealization → visitSameIndividuals | **NOT FEASIBLE (native)** | High |
| 6 | Data property assertions | CIndividual → getAssertionDataLinker() | TRIVIAL (asserted) | None |
| 7 | owl:oneOf → rdf:type | Impl::mOneOfMemberships | SYNTHESIZED (easy) | Low |
| 8 | minCardinality → rdf:type | mMinCardRestrictions + mMinCardRoleAssertions + mDifferentFromPairs | SYNTHESIZED (moderate) | Medium |
| 9 | disjointUnionOf → rdfs:subClassOf | Impl::mDisjointUnionOf | SYNTHESIZED (easy) | Low |
| 10 | FP/IFP → owl:sameAs | Impl::mFpIfpSameAsPairs | SYNTHESIZED (easy) | Low |
| 11 | someValuesFrom fixpoint → rdf:type | mSvfIndex + mSvfRoleAssertions + mSvfABoxTypes | SYNTHESIZED (moderate) | Medium |
| 12 | rdfs:subPropertyOf | CPropertyRoleClassification → CRolePropertiesHierarchy | **NOT FEASIBLE (native)** | High |
| 13 | equivalentProperty → subPropertyOf | Impl::mEquivPropPairs | SYNTHESIZED (easy) | Low |

**Key findings:**
- All 5 workaround types (Units 1-5) carry sufficient input data for synthesized justifications — Impl struct preserves parsed structures
- CConceptRealization and CRoleRealization are **opaque** — answer "what?" but not "why?"
- Domain/range axioms are compiled into anonymous GCI restrictions; domain/range-derived rdf:type inferences are not directly traceable from realization data
- BlackBox remains only option for object property assertions (#4), native sameAs (#5), subPropertyOf (#12)

---

### R4: Ontosphere PR #20 Analysis

**Critical finding: Ontosphere is a pure consumer.** It implements zero explanation algorithms — all justification logic lives in rdf-reasoner-konclude. The ontosphere app's PR #20 wired up the UI to call the package API.

**Coverage comparison:**

| Entailment Type | Ontosphere UI | rdf-reasoner-konclude Current | Gap |
|----------------|---------------|-------------------------------|-----|
| rdfs:subClassOf | Not in UI | Native fast-path (~1ms) | None |
| rdf:type (inferred) | EntailmentExplanation icon | Native for type-via-subClassOf | Falls back to BlackBox for non-subClassOf types |
| Inferred data properties | EntailmentExplanation icon + objectIsLiteral:true | `classifyAxiom()` returns "unsupported" | **BROKEN**: user sees "Asserted" for inferred data props |
| Inferred object property links | Visual only (dashed line, no ? icon) | Not reachable via explainEntailment | **NO explanation path at all** |
| owl:sameAs | Not triggered | Not supported in explain | Gap: FP/IFP sameAs has no explanation |
| someValuesFrom/disjointUnionOf ABox | Not triggered | Not supported | Gap: TS workaround generates, can't explain |
| Inconsistency (MIPS) | Full: explainDiagnostics + RepairSuggestions | explainInconsistency + laconic | Fully delegated |
| Unsatisfiable classes | explainDiagnostics reports them | getUnsatisfiableClasses + isSatisfiable | Detected, not individually explained |

**Priority gaps by user impact:**
1. **Inferred data properties** — actively shown in UI with broken explanation
2. **Inferred object property assertions** — natural next step for UI
3. **owl:sameAs chains** — generated by FP/IFP workaround, no explanation
4. **someValuesFrom/disjointUnionOf ABox** — generated by workaround, no explanation

---

### R5: CConcept→Axiom Reverse Mapping

**Major correction: CExpressionDataBoxMapping is NOT sparse.** The v0.5.0 "sparse" observation was wrong. The triple-buffer path (mapTriples()) uses the same `CConcreteOntologyUpdateBuilder` as the OWL/XML parser. `getConceptForClassTerm()` populates BOTH direction hashes for every class term:

```
mClassTermConceptHash->insert(classTermExp, concept)   // forward
mConceptClassTermHash->insert(concept, classTermExp)    // reverse
```

**Full reverse mapping chain exists:**
1. `CConcept` → `mConceptClassTermHash` → `CClassTermExpression*`
2. `CClassTermExpression` → `mClassTermClassAxiomHash` → `CClassAxiomExpression*` (with `insertMulti` for multiple axioms)
3. Cast to `CSubClassOfExpression`, `CEquivalentClassesExpression`, etc. based on `getType()`

**Concrete example** for `∃manages.Employee ⊑ Manager`:
1. `mConceptClassTermHash[someValuesFromConcept]` → `CObjectSomeValuesFromExpression*`
2. `expr->getType()` == `BETOBJECTSOMEVALUEFROM`
3. `expr->getObjectPropertyTermExpression()` → `:manages`
4. `expr->getClassTermExpression()` → `:Employee`
5. `mClassTermClassAxiomHash[someValuesFromExpr]` → `CSubClassOfExpression*`
6. Axiom recovered: `SomeValuesFrom(:manages, :Employee) SubClassOf :Manager`

**Two complementary approaches:**
- **Approach A (preferred): Expression-level reverse lookup** — preserves original axiom structure
- **Approach B (fallback): CConcept tree reconstruction** — walk operator code + role + operands to reconstruct Manchester Syntax

Key files: `CConcreteOntologyUpdateBuilder.cpp` lines 2064-2109, `CExpressionDataBoxMapping.h` lines 98-99 and 124-125.

---

## R6: Prioritized Implementation Roadmap

### Summary of Feasibility

| Strategy | Mechanism | Entailment Types |
|----------|-----------|-----------------|
| **Enrich existing analyser** | Extend dep chain walk in classification analyser to capture (concept tag, operator code, role tag, dep node type) tuples + walk additional dep branches | rdfs:subClassOf (enhanced), owl:equivalentClass |
| **Clash-path hook** | New override point at CCalculationTableauCompletionTaskHandleAlgorithm line ~1505, extracting CClashedDependencyDescriptor chains during realization | rdf:type from any reasoning path |
| **Axiom reverse mapping** | CConcept → CClassTermExpression → CClassAxiomExpression via expression data box hashes | All dep-chain-based justifications (converts concept tags to OWL axioms) |
| **Workaround synthesis** | Package Impl struct data as justification at buildInferredTripleBuffer time | FP/IFP sameAs, someValuesFrom, disjointUnionOf, oneOf, minCardinality, equivalentProperty |
| **BlackBox only** | No native data available | Object property assertions, native sameAs, subPropertyOf |

### Phase 1: High Impact / Low Effort

**1a. Axiom reverse mapping infrastructure** (foundation for all phases)
- Expose `CExpressionDataBoxMapping` hashes through `KoncludeReasoner` C++ API
- Add `getAxiomsForConceptTag(int64_t tag)` method that walks CConcept → CClassTermExpression → CClassAxiomExpression
- Serialize axiom expressions to N-Triples or Manchester Syntax for JS consumption
- **Files:** `src/KoncludeReasoner.cpp`, `src/KoncludeReasoner.h`, `src/bindings.cpp`
- **Impact:** Transforms all existing dep-chain justifications from opaque concept tags to human-readable OWL axioms

**1b. owl:equivalentClass justification**
- Detect when two named classes share a CHierarchyNode in taxonomy
- Compose bidirectional subClassOf justifications (both A⊑B and B⊑A from JustificationCache)
- **Files:** `src/KoncludeReasoner.cpp` (`getSubClassJustification` area), `ts/index.ts`
- **Impact:** Low effort, direct extension of existing native path

**1c. Workaround-synthesized justifications (4 easy types)**
- FP/IFP → owl:sameAs: justification = FP/IFP type declaration triple + role assertion triples showing multi-filler conflict
- disjointUnionOf → rdfs:subClassOf: justification = the disjointUnionOf axiom triples
- owl:oneOf → rdf:type: justification = the oneOf list triples
- equivalentProperty → subPropertyOf: justification = the equivalentProperty axiom triple
- **Files:** `src/KoncludeReasoner.cpp` (`buildInferredTripleBuffer` workaround sections), `ts/types.ts` (justification result types)
- **Impact:** Covers 4 entailment types with minimal code — input data already captured in Impl struct

### Phase 2: Medium Effort

**2a. Realization clash-path hook for rdf:type**
- Add justification extraction point at `CCalculationTableauCompletionTaskHandleAlgorithm.cpp` line ~1505 (clashed path)
- Check for realization adapter, extract `CClashedDependencyDescriptor` chain
- Store (individual tag, concept tag, dep-chain) in JustificationCache
- Walk dep chain using enriched format from Phase 1a (concept tag + operator code + role)
- **Files:** `vendor/konclude/...CCalculationTableauCompletionTaskHandleAlgorithm.cpp` (new override or patch), `src/JustificationCache.h` (schema extension), `src/KoncludeReasoner.cpp`
- **Impact:** Covers ALL rdf:type justifications natively, not just subClassOf-chain types
- **Risk:** Requires modifying the core tableau algorithm (patch or override)

**2b. someValuesFrom chain justification**
- Track propagation chain in fixpoint: type(x,C) + SvF(C,P,F) + role(x,P,y) → type(y,F)
- Package chain as justification at buildInferredTripleBuffer time
- **Files:** `src/KoncludeReasoner.cpp` (Unit 2 workaround section)
- **Impact:** Covers someValuesFrom ABox inferences, moderate chain tracking needed

**2c. minCardinality justification**
- Package: restriction definition + role assertions + differentFrom pairs
- All data already in Impl fields (mMinCardRestrictions, mMinCardRoleAssertions, mDifferentFromPairs)
- **Files:** `src/KoncludeReasoner.cpp` (Unit 5 workaround section)
- **Impact:** Covers minCardinality ABox inferences

### Phase 3: Hard / Speculative

**3a. Enrich classification analyser dep chain walk**
- Walk `mAdditionalAfterDepLinker` branches (currently skipped)
- Capture dep node type enum alongside concept tags
- Capture role tags for quantified dep nodes
- **Files:** `src/compat/overrides/CSatisfiableTaskClassificationMessageAnalyser.cpp`
- **Impact:** Richer justification evidence for subClassOf chains involving restrictions
- **Risk:** Performance impact of deeper chain walks during classification

**3b. Inferred data property explanation**
- Fix entailmentProbe.ts `classifyAxiom()` to handle `objectIsLiteral: true`
- Map data property entailments to appropriate probe shapes
- **Files:** `ts/entailmentProbe.ts`
- **Impact:** Fixes broken UI in ontosphere (top user-facing gap from R4)
- **Note:** May be achievable with BlackBox path fix rather than native interception

**3c. Object property assertion, native sameAs, subPropertyOf**
- No internal provenance data available from realization
- Must remain BlackBox-only unless CAreAxiomsEntailedQuery optimization (plan 050) makes BlackBox fast enough
- **Deferred:** These types have no native interception path

### Dependency Graph

```
Phase 1a (axiom reverse mapping) ─┬─→ Phase 1b (equivalentClass)
                                  ├─→ Phase 1c (workaround synthesis)
                                  ├─→ Phase 2a (clash-path hook)
                                  ├─→ Phase 2b (someValuesFrom chain)
                                  ├─→ Phase 2c (minCardinality)
                                  └─→ Phase 3a (enriched dep chain walk)

Phase 3b (data property explanation) — independent, TS-only fix
Phase 3c (BlackBox-only types) — blocked on plan 050 (CAreAxiomsEntailedQuery)
```

### Coverage Summary After Full Implementation

| Entailment Type | Current | After Phase 1 | After Phase 2 | After Phase 3 |
|----------------|---------|---------------|---------------|---------------|
| rdfs:subClassOf | Native (tags) | Native (axioms) | — | Native (enriched) |
| owl:equivalentClass | BlackBox | Native | — | — |
| rdf:type (subClassOf chain) | Native (tags) | Native (axioms) | — | — |
| rdf:type (restriction/complex) | BlackBox | — | Native (clash hook) | — |
| FP/IFP → owl:sameAs | None | Synthesized | — | — |
| disjointUnionOf | None | Synthesized | — | — |
| owl:oneOf → rdf:type | None | Synthesized | — | — |
| equivalentProperty | None | Synthesized | — | — |
| someValuesFrom → rdf:type | None | — | Synthesized (chain) | — |
| minCardinality → rdf:type | None | — | Synthesized | — |
| Inferred data properties | Broken | — | — | Fixed (BlackBox) |
| Object property assertions | BlackBox | BlackBox | BlackBox | BlackBox |
| Native sameAs | BlackBox | BlackBox | BlackBox | BlackBox |
| subPropertyOf | BlackBox | BlackBox | BlackBox | BlackBox |

## System-Wide Impact

- **No code changes** — this is a research plan
- **Downstream**: findings feed into plan 053 (implementation)
- **BlackBox fallback**: remains unchanged and correct for all unsupported types
- **JustificationCache**: R1/R2 findings may require schema changes (additional fields beyond concept tags) — document needed changes but don't implement

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Dep nodes carry only concept tags, no axiom back-references | R1 will determine this early; if true, shift strategy to buildInferredTripleBuffer augmentation |
| Realization analysers don't receive dep track points | R2 will determine this; if true, rdf:type justification must come from buildInferredTripleBuffer tracing or taxonomy+realization cross-reference |
| CExpressionDataBoxMapping remains sparse for triple-buffer path | R5 investigates CConcept operand structure as alternative; worst case, reconstruct axioms from concept tree traversal |
| Workaround-covered types have no Konclude-internal evidence | R3 documents this; justification must be synthesized from workaround input data (feasibility varies) |

## Sources & References

- **Origin plan:** [docs/plans/2026-07-17-051-feat-native-justification-api-plan.md](docs/plans/2026-07-17-051-feat-native-justification-api-plan.md)
- **Explanation API plan:** [docs/plans/2026-07-17-050-feat-explanation-api-expansion-plan.md](docs/plans/2026-07-17-050-feat-explanation-api-expansion-plan.md)
- **Ontosphere PR #20:** https://github.com/ThHanke/ontosphere/pull/20
- Horridge, M., Parsia, B., Sattler, U. "Laconic and Precise Justifications in OWL" ISWC 2008
- Memory: `project_entailment_oracle_optimization.md` (CAreAxiomsEntailedQuery follow-up)
- Memory: `project_native_operation_mechanisms.md` (ground truth pipelines)
