---
module: capability-gaps
tags: [native-trace, npa, negative-property-assertion, realization-hang, wasm-regression]
problem_type: hang-investigation
date: 2026-06-04
---

# NPA Realization — Native Trace 2026-06-04

## Purpose

Establish native Konclude ground truth for the NPA (NegativePropertyAssertion) realization
hang. The WASM `materialize()` call hangs indefinitely on consistent ontologies containing
`owl:NegativePropertyAssertion` blank nodes. This document confirms whether native Konclude
v0.7.0 also hangs, or whether the hang is a WASM regression.

**Verdict: COMPLETES — native Konclude v0.7.0 completes in ~0.8s total (< 15ms reasoning time). The NPA materialize hang is a WASM regression, not a native Konclude bug.**

---

## Fixture

Source: `tests/integration/property-characteristics.test.ts`, constant
`NEGATIVE_PROPERTY_ASSERTION_CONSISTENT_NTRIPLES` (lines 195–203).

A minimal ontology asserting `owl:NegativePropertyAssertion(alice, knows, bob)` without the
positive triple `alice knows bob`. The ontology is consistent — no contradiction is present.

```ntriples
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://example.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
_:neg <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NegativePropertyAssertion> .
_:neg <http://www.w3.org/2002/07/owl#sourceIndividual> <http://example.org/alice> .
_:neg <http://www.w3.org/2002/07/owl#assertionProperty> <http://example.org/knows> .
_:neg <http://www.w3.org/2002/07/owl#targetIndividual> <http://example.org/bob> .
```

---

## Method

Fixture written to `/tmp/konclude-test/npa-consistent.nt`, mounted as `/data/` inside the
official `konclude/konclude:latest` Docker image (`v0.7.0-1138 - 500e11d9 Jun 18 2021`).

Command used:

```
timeout 15 docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest \
  realization -i /data/npa-consistent.nt -o /data/npa_out.owl
```

---

## Docker Output (full stdout)

```
{info} 14:18:02:278 >> Starting Konclude ...
{info} 14:18:02:278 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:18:02:278 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:18:02:286 >> Starting realization processing for ontology '/data/npa-consistent.nt'.
{info} 14:18:02:289 >> Initializing reasoner. Creating calculation context.
{info} 14:18:02:301 >> Reasoner initialized with 1 processing unit(s).
{info} 14:18:02:301 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:314 >> Finished preprocessing in 8 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:314 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALI+'.
{info} 14:18:02:319 >> Finished precomputing in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:320 >> Classifying ontology 'http://konclude.com/test/kb', expressiveness 'ALI+'.
{info} 14:18:02:320 >> Ontology 'http://konclude.com/test/kb' has been sufficiently saturated, extracting data for classification.
{info} 14:18:02:323 >> Finished class classification in 2 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:323 >> Classifying object properties for ontology 'http://konclude.com/test/kb', expressiveness 'ALI+'.
{info} 14:18:02:328 >> Finished object property classification in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:328 >> Realizing ontology 'http://konclude.com/test/kb', expressiveness 'ALI+'.
{info} 14:18:02:334 >> Finished (lazy) realization in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:18:02:334 >> Query 'UnnamedRealizeQuery' processed in '0' ms.
{info} 14:18:02:336 >> Query 'UnnamedWriteIndividualTypesQuery' processed in '0' ms.

real    0m0.777s
user    0m0.036s
sys     0m0.029s
EXIT_CODE: 0
```

---

## OWL/XML Output File (`npa_out.owl`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Ontology xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://www.w3.org/2002/07/owl#" xmlns:xml="http://www.w3.org/XML/1998/namespace" xmlns:xsd="http://www.w3.org/2001/XMLSchema#">
    <Prefix name="" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="owl" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="rdf" IRI="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>
    <Prefix name="xml" IRI="http://www.w3.org/XML/1998/namespace"/>
    <Prefix name="xsd" IRI="http://www.w3.org/2001/XMLSchema#"/>
    <Prefix name="rdfs" IRI="http://www.w3.org/2000/01/rdf-schema#"/>
    <Declaration>
        <NamedIndividual IRI="http://example.org/bob"/>
    </Declaration>
    <Declaration>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
        <NamedIndividual IRI="http://example.org/bob"/>
    </ClassAssertion>
    <Declaration>
        <NamedIndividual IRI="http://example.org/alice"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
</Ontology>
```

---

## Analysis

### Expressiveness

Native Konclude labels this ontology `ALI+` — not ALIF+ (which triggers the known hang for
FunctionalProperty, R8). The NPA blank-node structure does not elevate expressiveness.

### Pipeline stages (timing)

| Stage                        | Duration |
| ---------------------------- | -------- |
| Preprocessing                | 8 ms     |
| Precomputing (`ALI+`)        | 4 ms     |
| Class classification         | 2 ms     |
| Object property classification | 4 ms   |
| Realization (lazy)           | 4 ms     |
| **Total reasoning**          | **~22 ms** |
| Total wall-clock (incl. JVM) | ~0.8 s   |

### Correctness

The output contains only `owl:Thing` type assertions for alice and bob. No `knows` property
assertion appears anywhere. This is correct: `owl:NegativePropertyAssertion` carries no
positive entailment.

- `alice knows bob` — **NOT present** (correct)
- `bob knows alice` — **NOT present** (correct)
- `alice rdf:type owl:Thing` — present (expected, trivially true)
- `bob rdf:type owl:Thing` — present (expected, trivially true)

### Implication for WASM

The NPA materialize hang is a **WASM regression** — the same ontology completes in 22 ms of
reasoning time on native Konclude. The blank-node NPA structure (`_:neg rdf:type
owl:NegativePropertyAssertion` with `owl:sourceIndividual`, `owl:assertionProperty`,
`owl:targetIndividual` links) is handled correctly by the native `ALI+` realization pipeline.

The WASM hang must be caused by something in the WASM-specific code path that diverges from
native. Likely candidates:

1. The blank-node reification triples for NPA are parsed but not mapped correctly in the
   WASM `mapTriples()` seam, causing the realizer to spin waiting for a result that never
   arrives.
2. A thread synchronization issue in the WASM pthread pool triggered specifically by the
   combination of NPA blank-node reification and the lazy realization phase (the same
   interaction that caused R7a/R7b hangs — those were also lazy-realization path).

---

## Second Fixture (owl2dl-parity.test.ts line 497)

The skipped test at line 497 of `owl2dl-parity.test.ts` is a stub with no fixture body:

```typescript
it.skip("UPSTREAM_LIMITATION — NPA/materialize: blank-node hang (upstream Konclude limitation)", async () => {
    // Not testable — materialize() with NPA blank nodes hangs indefinitely
}, 30_000);
```

There is no second distinct fixture to test. The sole NPA realization fixture is
`NEGATIVE_PROPERTY_ASSERTION_CONSISTENT_NTRIPLES` in `property-characteristics.test.ts`.

---

## Verdict

**COMPLETES** — native Konclude v0.7.0 completes NPA realization in ~0.8s wall-clock
(~22ms reasoning). The WASM materialize hang on NPA ontologies is a **WASM regression**, not
an upstream Konclude bug. Fix work in Unit 6 is warranted.
