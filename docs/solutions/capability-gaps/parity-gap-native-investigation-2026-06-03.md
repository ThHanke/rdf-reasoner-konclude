---
module: capability-gaps
tags: [native-investigation, parity, owl2dl]
problem_type: gap-analysis
date: 2026-06-03
---

# Native Konclude Binary Parity Gap Investigation — 2026-06-03

## Purpose

Documents which OWL 2 DL parity gaps (from plan-039 UPSTREAM_LIMITATION backlog) are native
Konclude v0.7.0 bugs versus WASM regressions. Findings gate C++ patch units 3–7.

## Method

Each gap was tested with a minimal NTriples fixture using `docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest <command> -i /data/<fixture>.nt -o /data/<out>.owl`. Timeouts of 15 seconds were used for hang detection. Consistent/inconsistent results were read from log line `{info} >> Ontology '...' is consistent/inconsistent.` on stdout. Realization/classification results were read from the OWL/XML output file.

**Note on output format:** Konclude writes all log output (including consistency verdicts) to stdout, not stderr. The output file (`-o`) is OWL/XML format (`<SubClassOf>`, `<ClassAssertion>` elements), not NTriples. The task description's NTriples format expectation applies to the WASM layer (which converts back to NTriples); native Konclude uses OWL/XML.

Konclude version: `v0.7.0-1138 - 500e11d9 (Jun 18 2021)`

## Findings

### R2 — AllDisjointProperties ABox clash

**Command:** `consistency -i /data/r2.nt`

**Input:**
```ntriples
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#AllDisjointProperties> .
_:b0 <http://www.w3.org/2002/07/owl#members> _:b1 .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/p> .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:b2 .
_:b2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/r> .
_:b2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
<http://example.org/alice> <http://example.org/p> <http://example.org/bob> .
<http://example.org/alice> <http://example.org/r> <http://example.org/bob> .
```

**Native output (stdout):**
```
{info} >> Ontology '/data/r2.nt' is consistent.
```

**Result:** consistent (WRONG — expected inconsistent)

**Fix path:** native bug — patch needed in WASM C++ layer to enforce AllDisjointProperties ABox clash detection

---

### R3 — differentFrom reflexive

**Command:** `consistency -i /data/r3.nt`

**Input:**
```ntriples
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/alice> <http://www.w3.org/2002/07/owl#differentFrom> <http://example.org/alice> .
```

**Native output (stdout):**
```
{info} >> Ontology '/data/r3.nt' is consistent.
```

**Result:** consistent (WRONG — expected inconsistent)

**Fix path:** native bug — `owl:differentFrom` reflexive clash is not detected by native Konclude v0.7.0. Patch needed, or JS pre-process option: detect `x differentFrom x` in input quads before passing to reasoner and return inconsistent immediately.

---

### R4 — complementOf named-class ABox clash

**Command:** `consistency -i /data/r4.nt`

**Input:**
```ntriples
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/A> <http://www.w3.org/2002/07/owl#complementOf> <http://example.org/B> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/A> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/B> .
```

**Native output (stdout):**
```
{info} >> Ontology '/data/r4.nt' is consistent.
```

**Result:** consistent (WRONG — expected inconsistent)

**Fix path:** native bug — `owl:complementOf` between named classes with ABox assertions is not detected as a clash by native Konclude v0.7.0. Patch needed in the mapper/preprocessor to translate `A complementOf B` into tableau disjointness constraints that interact with ABox saturation.

---

### R5 — someValuesFrom filler type propagation

**Command:** `realization -i /data/r5.nt -o /data/r5_out.owl`

**Input:**
```ntriples
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/PetOwner> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/hasAnimal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
_:r <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Restriction> .
_:r <http://www.w3.org/2002/07/owl#onProperty> <http://example.org/hasAnimal> .
_:r <http://www.w3.org/2002/07/owl#someValuesFrom> <http://example.org/Dog> .
<http://example.org/PetOwner> <http://www.w3.org/2002/07/owl#equivalentClass> _:r .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/rex> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/PetOwner> .
<http://example.org/alice> <http://example.org/hasAnimal> <http://example.org/rex> .
```

**Native output (OWL/XML ClassAssertion elements):**
```xml
<ClassAssertion>
    <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    <NamedIndividual IRI="http://example.org/rex"/>
</ClassAssertion>
<ClassAssertion>
    <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
<ClassAssertion>
    <Class IRI="http://example.org/PetOwner"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
```

**Result:** `rex rdf:type Dog` NOT emitted (WRONG — expected `ClassAssertion(Dog, rex)`)

**Expressiveness detected:** `ALEI+`

**Fix path:** native bug — native Konclude v0.7.0 does not propagate the `someValuesFrom` filler type to the named existing individual `rex`. The reasoner confirms `alice` is a `PetOwner` but does not materialize that `rex` must be of type `Dog` (because `PetOwner ≡ ∃hasAnimal.Dog` and `alice hasAnimal rex` is asserted). This is a known limitation of lazy realization — the filler is an existing named individual but no `rex rdf:type Dog` assertion is propagated. Patch needed, or post-process option: after realization, traverse `someValuesFrom` restrictions and assert filler types for known role fillers.

---

### R6 — disjointUnionOf classify A⊑C

**Command:** `classification -i /data/r6.nt -o /data/r6_out.owl`

**Input:**
```ntriples
<http://example.org/C> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/C> <http://www.w3.org/2002/07/owl#disjointUnionOf> _:b0 .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/A> .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:b1 .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/B> .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
```

**Native output (OWL/XML SubClassOf elements):**
```xml
<SubClassOf>
    <Class IRI="http://example.org/C"/>
    <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
</SubClassOf>
<SubClassOf>
    <Class IRI="http://example.org/A"/>
    <Class IRI="http://example.org/C"/>
</SubClassOf>
<SubClassOf>
    <Class IRI="http://example.org/B"/>
    <Class IRI="http://example.org/C"/>
</SubClassOf>
```

**Result:** CORRECT — native Konclude emits both `A ⊑ C` and `B ⊑ C`

**Expressiveness detected:** `SI`

**Fix path:** WASM regression — native emits correctly; investigate why WASM `classification` path does not emit these subClassOf triples. The mapper or NTriples serialization of classification output may be dropping non-strict subClassOf entries.

---

### R7a — AllDisjointClasses materialize

**Command:** `realization -i /data/r7a.nt -o /data/r7a_out.owl` (15s timeout)

**Input:**
```ntriples
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/A> .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#AllDisjointClasses> .
_:b0 <http://www.w3.org/2002/07/owl#members> _:b1 .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/A> .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:b2 .
_:b2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/B> .
_:b2 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
```

**Native output:**
```xml
<ClassAssertion>
    <Class IRI="http://example.org/A"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
<ClassAssertion>
    <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
```

**Result:** Completes successfully (no hang). Emits `alice rdf:type A` and `alice rdf:type Thing` — this is correct. No `alice rdf:type B` (B is disjoint from A and alice is in A). Expressiveness `SI`. Exit 0 in ~8ms.

**Fix path:** WASM regression — native realization with AllDisjointClasses does NOT hang; it completes correctly. The WASM hang in `materialize()` for this fixture is a WASM-specific regression (likely related to how AllDisjointClasses interacts with the realization thread lifecycle in the ported code). Investigate WASM realization path for SI-expressiveness ontologies with `AllDisjointClasses`.

---

### R7b — disjointUnionOf materialize

**Command:** `realization -i /data/r7b.nt -o /data/r7b_out.owl` (15s timeout)

**Input:**
```ntriples
<http://example.org/C> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/C> <http://www.w3.org/2002/07/owl#disjointUnionOf> _:b0 .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/A> .
_:b0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:b1 .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> <http://example.org/B> .
_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> <http://www.w3.org/1999/02/22-rdf-syntax-ns#nil> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/A> .
```

**Native output:**
```xml
<ClassAssertion>
    <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
<ClassAssertion>
    <Class IRI="http://example.org/C"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
<ClassAssertion>
    <Class IRI="http://example.org/A"/>
    <NamedIndividual IRI="http://example.org/alice"/>
</ClassAssertion>
```

**Result:** Completes successfully (no hang). Emits `alice rdf:type C` (correct — A⊑C via disjointUnionOf) and `alice rdf:type A`. Exit 0 in ~9ms.

**Fix path:** WASM regression — native realization with disjointUnionOf does NOT hang; it completes correctly with `alice rdf:type C` inferred. The WASM hang in `materialize()` for this fixture is a WASM-specific regression. Same suspected cause as R7a: realization thread lifecycle issue with SI-expressiveness ontologies involving `disjointUnionOf`.

---

### R8 — FunctionalProperty ALIF+ hang

**Command:** `realization -i /data/r8.nt -o /data/r8_out.owl` (15s timeout)

**Input:**
```ntriples
<http://example.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://example.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/carol> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/alice> <http://example.org/p> <http://example.org/bob> .
<http://example.org/alice> <http://example.org/p> <http://example.org/carol> .
```

**Native output:** No output produced — container killed after 15+ seconds.

**Result:** hangs — confirmed native Konclude v0.7.0 bug

**Expressiveness detected:** `ALIF+` (logged before hang)

**Fix path:** confirmed deferred — native Konclude v0.7.0 bug. The `ALIF+` expressiveness triggers a hang in the precomputing phase even in native. No WASM-specific patch can fix this; it requires upstream Konclude fix or a JS pre-process workaround (detect FunctionalProperty + multiple fillers + OWA, return sameAs or error).

---

## Summary Table

| Gap | Native result | Fix path |
|-----|--------------|----------|
| R2 AllDisjointProperties ABox clash | consistent (WRONG) | native bug — patch needed |
| R3 differentFrom reflexive | consistent (WRONG) | native bug — JS pre-process viable (trivial check) |
| R4 complementOf named-class ABox | consistent (WRONG) | native bug — patch needed in mapper |
| R5 someValuesFrom filler type | missing `rex:Dog` (WRONG) | native bug — patch or JS post-process |
| R6 disjointUnionOf classify A⊑C | emits A⊑C, B⊑C (CORRECT) | WASM regression — investigate classify output path |
| R7a AllDisjointClasses materialize | completes correctly (CORRECT) | WASM regression — investigate realization SI hang |
| R7b disjointUnionOf materialize | emits alice:C correctly (CORRECT) | WASM regression — investigate realization SI hang |
| R8 FunctionalProperty ALIF+ | hangs (WRONG) | confirmed deferred — native Konclude v0.7.0 bug |

## Recommendations for Unit 3–7

### Proceed with patches (native bugs confirmed):

**R2 (AllDisjointProperties ABox clash):** Native Konclude v0.7.0 does not enforce AllDisjointProperties in ABox consistency checking. A patch is required in the C++ mapper or preprocessor to translate the `owl:AllDisjointProperties` RDF list pattern into a pairwise `DisjointObjectProperties` axiom that the tableau checker will use for clash detection.

**R3 (differentFrom reflexive):** Native fails. The simplest fix is JS-layer pre-processing: scan input quads for `?x owl:differentFrom ?x` and short-circuit with "inconsistent" before calling the reasoner. This avoids a complex C++ patch entirely.

**R4 (complementOf named-class ABox):** Native Konclude v0.7.0 fails to detect the clash when an individual is typed as both `A` and `B` where `A owl:complementOf B`. Patch needed in the mapper to convert named-class `complementOf` axioms into a form that triggers clash detection during ABox saturation (e.g., complement class expansion or explicit DisjointClasses axiom generation).

**R5 (someValuesFrom filler type):** Native Konclude v0.7.0 lazy realization does not propagate filler types from `someValuesFrom` restrictions to existing named individuals. Post-process option in JS: after realization, scan `equivalentClass`/`subClassOf` someValuesFrom restrictions and for each asserted role filler, emit the filler type. Alternatively, patch the mapper to assert `rex rdf:type Dog` during preprocessing when the pattern is fully determined.

### Investigate WASM regressions (native works, WASM broken):

**R6 (disjointUnionOf classify):** Native correctly emits `A ⊑ C` and `B ⊑ C`. The WASM `classify()` result does not include these. Investigate `getInferredNTriples()` or the NTriples serialization of classification output — the OWL/XML hierarchy writer may be working but the WASM NTriples output path may be filtering or not serializing non-explicit subClassOf entries.

**R7a + R7b (materialize hang with SI expressiveness):** Native realization completes in <10ms for both AllDisjointClasses and disjointUnionOf fixtures (expressiveness `SI`). The WASM `materialize()` call hangs for the same fixtures. This is a WASM-specific realization thread lifecycle regression, likely related to how `SI`-expressiveness triggers different KPSet/saturation paths. Investigate the realization thread drain and semaphore handling for `SI`-expressiveness ontologies in the WASM port.

### Defer (native Konclude v0.7.0 bug, no WASM fix possible):

**R8 (FunctionalProperty ALIF+ hang):** Native Konclude v0.7.0 itself hangs at `ALIF+` precomputing phase. This is a pre-existing upstream bug. No C++ patch in the WASM port can resolve this. Options: (a) detect `FunctionalProperty` ABox patterns in JS and skip calling the reasoner; (b) wait for upstream fix; (c) document as known limitation.
