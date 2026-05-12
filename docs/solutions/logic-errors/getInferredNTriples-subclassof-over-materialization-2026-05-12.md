---
title: getInferredNTriples subClassOf over-materialization — per-concept iteration, stale node pointers, non-deterministic representative
date: 2026-05-12
category: logic-errors
module: wasm-reasoner-output
problem_type: logic_error
component: tooling
symptoms:
  - WASM output contained duplicate subClassOf triples — one per synonym in an equivalence class instead of one per unique node
  - Each equivalence class member emitted subClassOf to every IRI in the parent equivalence class instead of one representative
  - Stale CHierarchyNode pointers in parentNodeSet caused spurious parent triples for merged/defunct nodes
  - Non-deterministic synonym selection produced wrong representative (e.g. Heme instead of Haem) depending on QHash iteration order
  - owl:equivalentClass triples were not emitted at all
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [taxonomy, subclassof, equivalence-class, stale-pointer, ntriples, wasm, CHierarchyNode, nodeHash, representative-selection]
---

# getInferredNTriples subClassOf over-materialization — per-concept iteration, stale node pointers, non-deterministic representative

## Problem

`getInferredNTriples()` in `src/KoncludeReasoner.cpp` produced incorrect NTriples output after OWL-DL classification: duplicate `rdfs:subClassOf` triples, cross-equivalence subclass materialisation, spurious triples from stale node pointers, non-deterministic representative selection, and missing `owl:equivalentClass` triples — all caused by conflating `CConcept` (one per named class) with `CHierarchyNode` (one per equivalence class).

## Symptoms

- LUBM and Roberts produced more `rdfs:subClassOf` triples than native Konclude: both `Woman` and `FemaleDescendent` each emitted their own `subClassOf Person` triple instead of one canonical triple per node.
- Concepts sharing an equivalence class each produced a full set of subclass triples independently, causing O(n²) bloat for n-member equivalence classes.
- `owl:equivalentClass` triples were not emitted at all ("equiv not emitted" was a known open gap prior to this session).
- Galen ontology produced a different representative IRI than native Konclude (e.g. `Heme` instead of `Haem`) depending on QHash iteration order, causing 14 synonym-swap mismatches.
- Silent wrong results when a parent node pointer was present in `getParentNodeSet()` but no longer reachable through `nodeHash` (stale pointer after equivalence merge).

## What Didn't Work

- **Iterating `nodeHash` for the subClassOf emission loop** (session history): `nodeHash` maps every concept to its node, so each concept in an n-member equivalence class independently emitted a full set of parent edges — n times the correct number of triples.

- **Emitting all IRIs for all equivalent concepts on both sides (May 2026 approach)** (session history): After the first blank-node fix, the code was deliberately changed to cross all IRIs in child × all IRIs in parent equivalence classes, as a temporary measure to avoid missing triples. This was intentionally verbose and is exactly the over-materialization now being fixed.

- **`nodeIris(parentNode)` inner loop**: Emitting one triple per IRI in the parent's equivalence class crossed equivalence boundaries, producing triples like `Child subClassOf ParentAlias` in addition to `Child subClassOf Parent`, which native Konclude never emits.

- **First element of `getEquivalentConceptList()` as representative**: List order is non-deterministic (QHash-backed), so the selected IRI varied between runs, mismatching native output.

- **librdf triple store approach** (session history): An earlier implementation read inferred triples from librdf's triple store. Abandoned because librdf held full materialisation (all derived triples including cross-equivalence chains), not just the transitive reduction. The current implementation reads `CTaxonomy` directly via `CHierarchyNode`, which is why the per-concept vs. per-node iteration bugs became relevant.

## Solution

Four coordinated fixes, all in `getInferredNTriples()` in `src/KoncludeReasoner.cpp`:

### Fix 1 — Iterate unique nodes, not per-concept hash entries

**Before:**
```cpp
for (auto it = nodeHash->constBegin(), itEnd = nodeHash->constEnd(); it != itEnd; ++it) {
    CConcept* childConcept = it.key();
    CHierarchyNode* childNode = it.value();
    std::string childIri = conceptIri(childConcept);
    // ...
    for (CHierarchyNode* parentNode : *parents) {
        for (const std::string& parentIri : nodeIris(parentNode)) {
            result += '<' + childIri + "> " + subClassOf + " <" + parentIri + "> .\n";
        }
    }
}
```

**After:**
```cpp
// Second pass iterates nodeToIris — one entry per unique CHierarchyNode
for (auto& [node, iris] : nodeToIris) {
    std::string childIri = nodeRep(node);   // one representative per node
    if (childIri.empty() || childIri == owlNothing || childIri == owlThing) continue;
    // ...
}
```

`nodeToIris` is populated in the first pass by accumulating IRIs keyed by node pointer, so each unique node appears exactly once regardless of equivalence class size.

### Fix 2 — Emit subClassOf to one parent representative, not all parent IRIs

**Before:** The inner loop called `nodeIris(parentNode)` and emitted one triple per IRI in the parent's equivalence class.

**After:**
```cpp
for (CHierarchyNode* parentNode : *parents) {
    if (nodeToIris.count(parentNode) == 0) continue;   // Fix 3 stale-pointer guard
    std::string parentIri = nodeRep(parentNode);
    if (parentIri.empty() || parentIri == owlNothing) continue;
    auto key = std::make_pair(childIri, parentIri);
    if (!emitted.insert(key).second) continue;
    result += '<' + childIri + "> " + subClassOf + " <" + parentIri + "> .\n";
}
```

### Fix 3 — Guard against stale CHierarchyNode pointers

When Konclude merges taxonomy nodes during equivalence detection it does not update the `parentNodeSet` of child nodes — those sets retain raw pointers to the defunct merged-away nodes. The defunct nodes have no entries in `nodeToIris` (no concept in `nodeHash` references them), so the count-zero guard skips them safely:

```cpp
if (nodeToIris.count(parentNode) == 0) continue;
```

### Fix 4 — Deterministic representative via lowest concept tag

**Before:** The representative was whichever concept happened to be first in `getEquivalentConceptList()` (QHash iteration order, non-deterministic).

**After:**
```cpp
auto nodeRep = [&conceptIri](CHierarchyNode* node) -> std::string {
    if (!node) return "";
    QList<CConcept*>* list = node->getEquivalentConceptList();
    if (!list) return "";
    CConcept* best = nullptr;
    qint64 bestTag = std::numeric_limits<qint64>::max();
    for (CConcept* c : *list) {
        if (!c) continue;
        std::string iri = conceptIri(c);
        if (iri.empty()) continue;
        qint64 tag = c->getConceptTag();
        if (tag < bestTag) { bestTag = tag; best = c; }
    }
    return best ? conceptIri(best) : "";
};
```

`CConcept::getConceptTag()` returns the sequential internal concept ID assigned at ontology parse time. The primary/older named concept is created first and receives a lower tag. This matches native Konclude's internal concept identity semantics.

### Fix 5 — Emit owl:equivalentClass triples

Added emission of `owl:equivalentClass` triples in the first pass over `nodeToIris`. For each node with multiple named concepts, emit one triple per pair:

```cpp
if (iris.size() > 1) {
    for (size_t i = 0; i < iris.size(); ++i) {
        for (size_t j = i + 1; j < iris.size(); ++j) {
            result += '<' + iris[i] + "> " + equivalentClass + " <" + iris[j] + "> .\n";
            result += '<' + iris[j] + "> " + equivalentClass + " <" + iris[i] + "> .\n";
        }
    }
}
```

This matches native Konclude's XML `<EquivalentClasses>` groups translated to NTriples format.

## Why This Works

The four iteration bugs share a common root: the original code conflated `CHierarchyNode` (one per equivalence class) with `CConcept` (one per named class). Konclude's taxonomy compacts equivalent classes into a single node before classification, so iterating the concept-keyed `nodeHash` visits each concept separately even though they all map to the same `CHierarchyNode`. The fix introduces `nodeToIris` (keyed by node pointer) as the iteration unit for the second pass, making the node — not the concept — the unit of subClassOf emission.

The stale pointer bug is a consequence of Konclude's merge optimisation: it reuses the winning node and leaves `parentNodeSet` entries on children pointing to the losing (defunct) node. Because no concept in `nodeHash` references the losing node after the merge, its absence from `nodeToIris` is the correct membership test.

`QHash` and `std::unordered_map` offer no ordering guarantees. Concept tags are assigned sequentially during RDF parsing — the first-encountered named concept for a class is definitionally the primary one, matching how native Konclude tracks concept identity throughout its tableau algorithm.

## Prevention

- **Diff against native output at the triple level, not just triple count.** A count match can pass even with duplicate triples compensating for missing ones. Use sorted-diff of `tests/fixtures/*-wasm-out.nt` against `tests/fixtures/*-native-out.nt` across all three ontologies (LUBM, Galen, Roberts).

- **When iterating `nodeHash` for topology purposes, always project to unique nodes first.** A `QHash<CConcept*, CHierarchyNode*>` has n entries for an n-member equivalence class; any loop that emits one thing per edge must key on node pointers, not concept pointers.

- **Never trust raw pointers from `getParentNodeSet()` without membership-checking them against the live node index.** Konclude's merge phase does not update reverse edges.

- **Avoid list-position-based representative selection on Konclude data structures backed by QHash.** Always impose an explicit stable ordering; `getConceptTag()` is the appropriate key for named concepts.

- **After any change to `getInferredNTriples()`, verify all three fixture ontologies.** LUBM, Roberts, and Galen exercise different classifier paths and different equivalence class sizes. One can regress silently while the other two pass.

## Related Issues

- `docs/solutions/logic-errors/saturation-subsumer-extraction-flag-scoping-logic-error-2026-05-12.md` — same symptom surface (wrong subClassOf triples in NTriples output) but different layer: classifier computes wrong parents vs. serializer mis-serializes correct parents. Both bugs were present simultaneously in LUBM output.
- `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md` — background on why the WASM reasoner requires pthreads, which constrains the execution environment `getInferredNTriples()` runs in.
- `docs/plans/2026-05-06-002-fix-feat-wasm-correctness-pthreads-plan.md` — R-C1 requirement names `getInferredNTriples()` output parity as acceptance criterion; line ~412 discusses the `CConcept* → CHierarchyNode*` hash semantics and equivalence edge cases.
