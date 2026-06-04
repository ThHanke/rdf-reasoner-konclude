---
module: capability-gaps
tags: [native-trace, si-expressiveness, realization-hang]
problem_type: hang-investigation
date: 2026-06-03
---

# SI-Expressiveness Realization Hang — Native Trace 2026-06-03

## Purpose

Establish native Konclude ground truth for R7a (AllDisjointClasses materialize) and R7b
(disjointUnionOf materialize). Both fixtures hang in the WASM `materialize()` call but
complete in ~50ms total (including startup) in native Konclude v0.7.0. This document
captures the exact verbose log output, pipeline stages, expressiveness label, and OWL/XML
output to guide WASM regression investigation (Unit 2+).

## Method

Fixtures were written to `/tmp/konclude-test/`, then mounted as `/data/` inside the
official `konclude/konclude:latest` Docker image (`v0.7.0-1138 - 500e11d9 Jun 18 2021`).

Command template:

```
docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest \
  realization -v -a -i /data/<fixture>.nt -o /data/<out>.owl
```

Flags used:

- `-v` — "Shows loading and processing times in more detail" (per `--help`)
- `-a` — "Periodically prints the progress of the current activities"

No deeper logging level is available: `-l 3` produces `{error} No Loader for 'l' available.`
and `-c <config>` redirects to OWLlink mode. The `-v` output is the maximum verbosity
the binary supports.

---

## R7a — AllDisjointClasses materialize

### Input fixture (`r7a.nt`)

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

### Full stdout (`-v -a`)

```
{info} >> Starting Konclude ...
{info} >> Konclude - Uni Ulm Parallel Reasoner
{info} >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} >> Starting realization processing for ontology '/data/r7a.nt'.
{info} >> Initializing reasoner. Creating calculation context.
{info} >> Ontology parsed in 4 ms.
{info} >> Reasoner initialized with 1 processing unit(s).
{info} >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} >> Finished preprocessing in 7 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished precomputing in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Classifying ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Ontology 'http://konclude.com/test/kb' has been sufficiently saturated, extracting data for classification.
{info} >> Finished class classification in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Classifying object properties for ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished object property classification in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Realizing ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished (lazy) realization in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Query 'UnnamedRealizeQuery' processed in '0' ms.
{info} >> Query 'UnnamedWriteIndividualTypesQuery' processed in '1' ms.
{info} >> Total processing time: 46 ms.
```

Exit code: **0**

### OWL/XML output (`r7a_out.owl`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Ontology xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
          xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns="http://www.w3.org/2002/07/owl#"
          xmlns:xml="http://www.w3.org/XML/1998/namespace"
          xmlns:xsd="http://www.w3.org/2001/XMLSchema#">
    <Prefix name="" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="owl" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="rdf" IRI="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>
    <Prefix name="xml" IRI="http://www.w3.org/XML/1998/namespace"/>
    <Prefix name="xsd" IRI="http://www.w3.org/2001/XMLSchema#"/>
    <Prefix name="rdfs" IRI="http://www.w3.org/2000/01/rdf-schema#"/>
    <Declaration>
        <NamedIndividual IRI="http://example.org/alice"/>
    </Declaration>
    <Declaration>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
    <Declaration>
        <Class IRI="http://example.org/A"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://example.org/A"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
</Ontology>
```

### Key findings — R7a

| Property | Value |
|----------|-------|
| Expressiveness | `SI` |
| Exit code | `0` |
| Total time | ~46 ms (incl. binary startup) |
| Realization time | 3 ms (lazy) |
| ClassAssertion: `owl:Thing` for `alice` | YES |
| ClassAssertion: `A` for `alice` | YES |
| ClassAssertion: `B` for `alice` | NO (correct — B is disjoint from A) |

Pipeline stages (in order):

1. Preprocessing — 7 ms
2. Precomputing (`SI`) — 4 ms
3. Class classification (`SI`) — 3 ms (with saturation note)
4. Object property classification (`SI`) — 3 ms
5. Realization (`SI`, lazy) — 3 ms
6. WriteIndividualTypesQuery — 1 ms

The log line `Ontology '...' has been sufficiently saturated, extracting data for classification`
appears during class classification, indicating the saturation step was completed before
realization. Native uses a single-thread (1 processing unit) lazy realization that exits cleanly.

---

## R7b — disjointUnionOf materialize

### Input fixture (`r7b.nt`)

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

### Full stdout (`-v -a`)

```
{info} >> Starting Konclude ...
{info} >> Konclude - Uni Ulm Parallel Reasoner
{info} >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} >> Starting realization processing for ontology '/data/r7b.nt'.
{info} >> Initializing reasoner. Creating calculation context.
{info} >> Ontology parsed in 3 ms.
{info} >> Reasoner initialized with 1 processing unit(s).
{info} >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} >> Finished preprocessing in 11 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished precomputing in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Classifying ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished class classification in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Classifying object properties for ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished object property classification in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Realizing ontology 'http://konclude.com/test/kb', expressiveness 'SI'.
{info} >> Finished (lazy) realization in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} >> Query 'UnnamedRealizeQuery' processed in '0' ms.
{info} >> Query 'UnnamedWriteIndividualTypesQuery' processed in '0' ms.
{info} >> Total processing time: 49 ms.
```

Exit code: **0**

Note: The `has been sufficiently saturated` log line is absent for R7b class classification.
R7b contains a `disjointUnionOf` but no bare `AllDisjointClasses` — the saturation path
differs slightly (no early-exit saturation note) yet realization still completes correctly.

### OWL/XML output (`r7b_out.owl`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Ontology xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
          xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns="http://www.w3.org/2002/07/owl#"
          xmlns:xml="http://www.w3.org/XML/1998/namespace"
          xmlns:xsd="http://www.w3.org/2001/XMLSchema#">
    <Prefix name="" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="owl" IRI="http://www.w3.org/2002/07/owl#"/>
    <Prefix name="rdf" IRI="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>
    <Prefix name="xml" IRI="http://www.w3.org/XML/1998/namespace"/>
    <Prefix name="xsd" IRI="http://www.w3.org/2001/XMLSchema#"/>
    <Prefix name="rdfs" IRI="http://www.w3.org/2000/01/rdf-schema#"/>
    <Declaration>
        <NamedIndividual IRI="http://example.org/alice"/>
    </Declaration>
    <Declaration>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://www.w3.org/2002/07/owl#Thing"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
    <Declaration>
        <Class IRI="http://example.org/C"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://example.org/C"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
    <Declaration>
        <Class IRI="http://example.org/A"/>
    </Declaration>
    <ClassAssertion>
        <Class IRI="http://example.org/A"/>
        <NamedIndividual IRI="http://example.org/alice"/>
    </ClassAssertion>
</Ontology>
```

### Key findings — R7b

| Property | Value |
|----------|-------|
| Expressiveness | `SI` |
| Exit code | `0` |
| Total time | ~49 ms (incl. binary startup) |
| Realization time | 4 ms (lazy) |
| ClassAssertion: `owl:Thing` for `alice` | YES |
| ClassAssertion: `C` for `alice` | YES (inferred via `disjointUnionOf` — `A⊑C`) |
| ClassAssertion: `A` for `alice` | YES |
| ClassAssertion: `B` for `alice` | NO (correct — B is disjoint from A in C's union) |

Pipeline stages are identical to R7a: precompute → class classify → property classify →
lazy realize → write. The `disjointUnionOf` axiom causes `A⊑C` to be inferred during
TBox classification; realization then materializes `ClassAssertion(C, alice)` via
the class hierarchy.

---

## Logging depth analysis

The `-v` flag is the maximum verbosity available in the native binary. Deeper log lines
(BackendAssCache update phases, KPSet stages, realizer thread signals) are only emitted
when Konclude is compiled with debug logging enabled (`KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED`
is not set and debug output is compiled in). The released Docker image has all debug
logging compiled out.

Available log levels from native binary:
- `{info}` — pipeline milestones (visible with or without `-v`)
- `{error}` — command-line parsing errors

Internal BackendAssCache Update1/Update2 phases, KPSet worker signals, and realizer
semaphore drain events are not visible in native logs. These must be observed from the
WASM side (Unit 2 instrumentation).

---

## Pipeline stage summary for WASM replication

Both R7a and R7b execute the same 5-stage pipeline:

```
1. Preprocessing          (7–11 ms)
2. Precomputing      [SI] (4 ms)
3. Class classification  [SI] (3–4 ms)  ← saturation occurs here
4. Property classification [SI] (3 ms)
5. Lazy realization  [SI] (3–4 ms)      ← emits ClassAssertion facts
   WriteIndividualTypesQuery (0–1 ms)   ← serialises to OWL/XML
```

The expressiveness `SI` label appears in precomputing, class classification, property
classification, and realization log lines — confirming all four phases share the same
expressiveness tag.

The key distinction from simpler (AL-family) ontologies: the native logs show
`(lazy) realization` for both fixtures, indicating the realizer found no additional
satisfiability tests needed beyond saturation. This is consistent with the zero-work
hang hypothesis (plan fix path 3b): if no tableau jobs are queued,
`setDynamicRequirementProcessed()` never fires for those steps and the realizer
semaphore is never signalled. In native this drains cleanly; the WASM hang implies
the zero-work completion path does not drain correctly in the ported threading model.

---

## What WASM must replicate

For the WASM `materialize()` call on SI-expressiveness ontologies to complete:

1. **Lazy realization must exit** — Native `Finished (lazy) realization in 3–4 ms`. The
   WASM realization call does not return. Unit 2 instrumentation should target the
   ranked candidates from plan-040: (a) BackendAssCache Update2 completion — confirm
   the cache update fully signals before realization starts; (b) zero-work hang
   (most probable, fix path 3b) — if no tableau jobs are queued,
   `setDynamicRequirementProcessed()` never fires and the realizer semaphore is never
   signalled; (c) STPU pool exhaustion — confirm the thread pool has available slots
   when the realizer tries to schedule.

2. **Output must include two ClassAssertion facts for R7a**:
   - `ClassAssertion(owl:Thing, alice)` — all named individuals are a member of Thing
   - `ClassAssertion(A, alice)` — direct assertion, propagated through realization

3. **Output must include three ClassAssertion facts for R7b**:
   - `ClassAssertion(owl:Thing, alice)`
   - `ClassAssertion(C, alice)` — inferred: `A⊑C` via disjointUnionOf TBox axiom
   - `ClassAssertion(A, alice)` — direct assertion

4. **No `B` assertion for either** — B is disjoint from A (AllDisjointClasses in R7a;
   disjointUnionOf member-disjointness in R7b). Emitting `ClassAssertion(B, alice)` would
   be incorrect.

5. **SI precomputing and KPSet classification must complete before realization** — native
   logs confirm the classify→realize ordering. The WASM hang likely occurs during
   realization (after classify completes) or at the classify→realize handoff.

---

## References

- Previous gap analysis: `docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md`
- WASM pthread concurrency: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
- Plan: `docs/plans/2026-06-03-040-fix-wasm-si-realization-hang-plan.md`
