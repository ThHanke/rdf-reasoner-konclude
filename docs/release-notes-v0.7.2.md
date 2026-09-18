# Release Notes — v0.7.2

## Summary

v0.7.2 is a correctness, determinism, and output efficiency release. No API changes. Drop-in upgrade from v0.7.1.

---

## What Changed

### OWL 2 DL Correctness

**AsymmetricProperty self-loop clash detection (patch-027)**
Konclude now correctly detects consistency violations when an individual has a role assertion `r(a, a)` and `r` is declared `owl:AsymmetricProperty`. Previously this was silently accepted. All 17 OWL 2 DL conformance cases in the test suite pass.

**`owl:hasSelf` + `owl:propertyDisjointWith` clash detection (patch-022)**
Saturation now flags as inconsistent any individual that satisfies both `∃r.Self` and `∃s.Self` when `r` and `s` are disjoint properties (including when a role is disjoint with itself, i.e. irreflexive via disjointness).

### KPSet Classifier Determinism

**Canonical subClassOf hierarchy output (TS layer)**
`classify()` and `materialize()` now sort the inferred `rdfs:subClassOf` hierarchy deterministically before returning it. Eliminates the 50–61 edge count nondeterminism observed with parallel KPSet runs on repeated calls.

**Batch-sync scheduling (patch-026)**
KPSet only schedules downstream work after a full parallel batch completes, not after each individual test result. Eliminates a class of out-of-order callback races.

### Explain Path Fix

**`owl:Thing` edges restored in `classify()` with explanations**
When `wantExplanations: true` was passed to `classify()`, root classes were missing their `rdfs:subClassOf owl:Thing` edges in the inferred output. Fixed — `missingRootThingEdges` is now applied in both the plain and explanation branches.

### Hasse-Reduced Inferred Triple Output

`classify()` and `materialize()` now export only the **direct (Hasse-reduced) subClassOf edges** to the inferred graph — redundant transitive edges that are implied by the hierarchy are omitted. This significantly reduces the size of the inferred graph for ontologies with deep class hierarchies and eliminates noise in downstream consumers. Previously all subClassOf triples returned by Konclude were written verbatim.

### Skolemized Blank Node Regression Guard

Added integration tests confirming that `urn:vg:bnode:` IRI restriction nodes (ontosphere's skolemization scheme for blank nodes) are handled correctly by Konclude without any caller-side deskolemization. Two `owl:someValuesFrom` restrictions with distinct fillers do not collapse to `owl:equivalentClass`, and ABox inference is selective.

---

## Fixes Since v0.7.1

| Area | Fix |
|---|---|
| OWL 2 DL | AsymmetricProperty self-loop `r(a,a)` now detected as inconsistent |
| OWL 2 DL | hasSelf + propertyDisjointWith clash correctly detected in saturation |
| explain | `owl:Thing` edges missing in `classify()` + explanations path |
| KPSet | Deterministic hierarchy output across repeated calls |
| KPSet | Batch-sync scheduling eliminates callback ordering races |
| Output | Inferred graph contains only direct (Hasse-reduced) subClassOf edges |
| Memory | `reset()` is bounded; RSS stays stable across sequential calls |
| Tests | Skolemized IRI restriction node regression suite added |

---

## Upgrade

```bash
npm install rdf-reasoner-konclude@0.7.2
```

No API changes. No migration required from v0.7.1.

---

## Known Limitations

- **Browser target**: The WASM binary requires `SharedArrayBuffer` (COOP/COEP headers). A `PROXY_TO_PTHREAD` browser build that avoids this requirement is deferred to a future release.
- **Preprocessing overhead**: WASM classification is slower than native Konclude on large ontologies. The kernel reasoning uses pthreads; overhead is primarily in the preprocessing and ontology mapping stages.
- **Hierarchy nondeterminism on very large ontologies**: The TS-layer canonicalization covers most cases; a deeper KPSet-internal source of nondeterminism on large inputs (>100 classes) is under investigation.
