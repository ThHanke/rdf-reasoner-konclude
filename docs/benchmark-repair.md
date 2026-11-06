# `repair()` benchmark

Latency and robustness of `RdfReasoner.repair()` across ontology sizes and kinds of inconsistency. Scripts: [`tests/bench/repair-bench.mjs`](../tests/bench/repair-bench.mjs) (matrix driver), [`repair-case.mjs`](../tests/bench/repair-case.mjs) (one case), [`repair-clashes.mjs`](../tests/bench/repair-clashes.mjs) (the injected clashes), [`repair-example.mjs`](../tests/bench/repair-example.mjs) (prints real output). Speed benchmark of the reasoner itself: [`docs/benchmark.md`](benchmark.md).

```
Date:      2026-11-06
Package:   rdf-reasoner-konclude 0.8.0 (git 2dadce8, ts/ modified)
WASM:      dist/konclude.wasm sha256 9c95b4419b6a
Host:      Intel(R) Xeon(R) Silver 4216 CPU @ 2.10GHz, 8 cores, 41 GB; load average at start 0.04 1.23 3.39
Runtime:   Node v25.1.0
Budget:    repair() timeout 240000 ms per case, maxRepairs 10, one fresh process per case
```

## Use case

An ontology editor (the consumer is Ontosphere) loads an OWL ontology, the reasoner reports it **inconsistent**, and the user asks _"what do I have to change?"_. `repair()` answers with **complete sets of axioms whose removal restores consistency**, computed by the reasoner and checked by the reasoner:

1. `explainInconsistency`-style search finds minimal inconsistent subsets (justifications) of the ontology (QuickXplain, a few dozen consistency checks).
2. Minimal hitting sets of the justifications are the repair candidates.
3. Each candidate is verified by removing it from a copy and re-checking consistency; a candidate that still fails reveals further justifications and the loop continues.

The caller then picks one repair by its own policy (an optional `cost(axiom)` orders them), removes the returned axioms from its store, and re-checks and re-classifies (about 1 s on a 17k-quad ontology). The store passed to `repair()` is never modified.

This benchmark answers: _how long does that take, how many reasoner calls does it need, does it stay inside the memory budget, and does it return what is expected?_

## What the clashes are and what to expect

A clash is added to a **consistent** base ontology. All clashes except `bfo` use axioms in a fresh namespace (`bx:` = `http://bench.example/`), so they are independent of the base ontology's content: they isolate how cost grows with ontology size. `bfo` is a real clash against PMDco's own BFO axioms. The clash definitions live in `repair-clashes.mjs`; this table is generated from them.

| Clash         | What it models                                                                                                                                                                                              | Axioms added                                                                                                                                                                                                                                               | Expected result                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `disjoint`    | An individual asserted into two classes that are declared disjoint (the classic ABox clash).                                                                                                                | <pre>bx:C0a a owl:Class . bx:C0b a owl:Class .<br>bx:C0a owl:disjointWith bx:C0b .<br>bx:ind0 a bx:C0a , bx:C0b .</pre>                                                                                                                                    | One justification of 3 axioms (the disjointness axiom and the two type assertions). Three repairs, each removing one of them.                                                                                                                                                        |
| `unsat`       | A TBox error (class U is a subclass of two disjoint classes, so unsatisfiable) that only becomes an inconsistency because an individual is an instance of it.                                               | <pre>bx:A a owl:Class . bx:B a owl:Class . bx:U a owl:Class .<br>bx:A owl:disjointWith bx:B .<br>bx:U rdfs:subClassOf bx:A , bx:B .<br>bx:u1 a bx:U .</pre>                                                                                                | One justification of 4 axioms (disjointness, the two subclass axioms, the instance assertion). Four repairs, each removing one of them.                                                                                                                                              |
| `cardinality` | A number restriction violated by two provably different fillers. The restriction is an axiom made of four triples (blank-node closure) that must be removed as one unit.                                    | <pre>bx:p a owl:ObjectProperty . bx:K a owl:Class .<br>bx:K rdfs:subClassOf [ a owl:Restriction ; owl:onProperty bx:p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .<br>bx:k1 a bx:K ; bx:p bx:y1 , bx:y2 .<br>bx:y1 owl:differentFrom bx:y2 .</pre> | One justification of 5 axioms (the restriction as ONE axiom of 4 triples, the instance assertion, the two role assertions, differentFrom). Five repairs, each removing one axiom.                                                                                                    |
| `three`       | Three independent clashes in one ontology: the repair set must fix all of them.                                                                                                                             | <pre># three independent copies of the "disjoint" clash, with C0a/C0b, C1a/C1b, C2a/C2b and ind0, ind1, ind2</pre>                                                                                                                                         | Three justifications of 3 axioms. Every complete repair removes one axiom per clash (size 3); there are 27 such minimal sets, so repair() stops at its cap of 10 and reports `incomplete: solution-cap` (by design, not a failure).                                                  |
| `bfo`         | A real clash against the ontology's own BFO axioms (no synthetic axioms): the individual is typed with two classes that PMDco declares disjoint, both directly and through an owl:AllDisjointClasses axiom. | <pre>bx:x a obo:BFO_0000004 , obo:BFO_0000020 . # PMDco only: BFO "continuant"-side and "occurrent"-side classes, declared disjoint in the ontology</pre>                                                                                                  | Two justifications of 3 axioms: {direct disjointWith, 2 type assertions} and {AllDisjointClasses axiom (grouped as one unit), the same 2 type assertions}. Repairs: remove either type assertion (size 1, it hits both justifications), or remove both disjointness axioms (size 2). |

## Real output of the API

Each block is the unedited result of `repair(store)` for one case, printed by `node tests/bench/repair-example.mjs <root> <base.nt> <clash>` (axioms shortened to prefixes; `[+N more triple(s)]` marks an axiom that is several triples, which are removed together).

### LUBM schema (307 quads) + `disjoint`

```
ontology: 307 quads + injected clash "disjoint"   repair() took 3.0 s
consistent: false   incomplete: false

justifications (1):
  [0] 3 axioms, 2 declaration triples in context
        bx:C0a owl:disjointWith bx:C0b
        bx:ind0 rdf:type bx:C0a
        bx:ind0 rdf:type bx:C0b

repairs (3):
  [0] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
  [1] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:ind0 rdf:type bx:C0a
  [2] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:ind0 rdf:type bx:C0b
```

### LUBM schema + `cardinality` (a restriction axiom is one unit of four triples)

```
ontology: 307 quads + injected clash "cardinality"   repair() took 3.9 s
consistent: false   incomplete: false

justifications (1):
  [0] 5 axioms, 2 declaration triples in context
        bx:K rdfs:subClassOf _:b1   [+3 more triple(s) of the same axiom]
        bx:k1 rdf:type bx:K
        bx:k1 bx:p bx:y1
        bx:k1 bx:p bx:y2
        bx:y1 owl:differentFrom bx:y2

repairs (5):
  [0] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:K rdfs:subClassOf _:b1   [+3 more triple(s) of the same axiom]
  [1] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:k1 rdf:type bx:K
  [2] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:k1 bx:p bx:y1
  [3] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:k1 bx:p bx:y2
  [4] remove 1 axiom(s); covers justifications [0]; verifiedConsistent: true; minimal: true
        - bx:y1 owl:differentFrom bx:y2
```

### LUBM schema + `three` (independent clashes, capped repair list)

```
ontology: 307 quads + injected clash "three"   repair() took 9.4 s
consistent: false   incomplete: true   reason: solution-cap

justifications (3):
  [0] 3 axioms, 2 declaration triples in context
        bx:C0a owl:disjointWith bx:C0b
        bx:ind0 rdf:type bx:C0a
        bx:ind0 rdf:type bx:C0b
  [1] 3 axioms, 2 declaration triples in context
        bx:C1a owl:disjointWith bx:C1b
        bx:ind1 rdf:type bx:C1a
        bx:ind1 rdf:type bx:C1b
  [2] 3 axioms, 2 declaration triples in context
        bx:C2a owl:disjointWith bx:C2b
        bx:ind2 rdf:type bx:C2a
        bx:ind2 rdf:type bx:C2b

repairs (10):
  [0] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:C1a owl:disjointWith bx:C1b
        - bx:C2a owl:disjointWith bx:C2b
  [1] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:C1a owl:disjointWith bx:C1b
        - bx:ind2 rdf:type bx:C2a
  [2] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:C1a owl:disjointWith bx:C1b
        - bx:ind2 rdf:type bx:C2b
  [3] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1a
        - bx:C2a owl:disjointWith bx:C2b
  [4] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1a
        - bx:ind2 rdf:type bx:C2a
  [5] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1a
        - bx:ind2 rdf:type bx:C2b
  [6] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1b
        - bx:C2a owl:disjointWith bx:C2b
  [7] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1b
        - bx:ind2 rdf:type bx:C2a
  [8] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:C0a owl:disjointWith bx:C0b
        - bx:ind1 rdf:type bx:C1b
        - bx:ind2 rdf:type bx:C2b
  [9] remove 3 axiom(s); covers justifications [0,1,2]; verifiedConsistent: true; minimal: true
        - bx:ind0 rdf:type bx:C0a
        - bx:C1a owl:disjointWith bx:C1b
        - bx:C2a owl:disjointWith bx:C2b
```

### PMDco (17,158 quads) + `bfo` (a real clash with two justifications)

```
ontology: 17158 quads + injected clash "bfo"   repair() took 30.2 s
consistent: false   incomplete: false

justifications (2):
  [0] 3 axioms, 2 declaration triples in context
        obo:BFO_0000004 owl:disjointWith obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000004
  [1] 3 axioms, 3 declaration triples in context
        _:b1 rdf:type owl:AllDisjointClasses   [+7 more triple(s) of the same axiom]
        bx:x rdf:type obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000004

repairs (3):
  [0] remove 1 axiom(s); covers justifications [0,1]; verifiedConsistent: true; minimal: true
        - bx:x rdf:type obo:BFO_0000020
  [1] remove 1 axiom(s); covers justifications [0,1]; verifiedConsistent: true; minimal: true
        - bx:x rdf:type obo:BFO_0000004
  [2] remove 2 axiom(s); covers justifications [0,1]; verifiedConsistent: true; minimal: true
        - obo:BFO_0000004 owl:disjointWith obo:BFO_0000020
        - _:b1 rdf:type owl:AllDisjointClasses   [+7 more triple(s) of the same axiom]
```

The type assertions are in both justifications, so removing either one (size 1) repairs both; removing the two disjointness axioms (size 2) is the alternative. All repairs are verified (`verifiedConsistent: true`) and inclusion-minimal.

## Results

One run per case, fresh process, `repair()` budget 240 s, minimization over whole axiom units (see below). `checks` = consistency checks issued to the kernel; `recycles` = Worker recycles triggered by the heap threshold; `applied OK` = consistency after removing the first repair from a copy. The runner records `baseConsistent` and the report marks an inconsistent base as `INVALID`; all bases are consistent.

| Ontology           |  Quads | Clash       | repair() s | checks | avg check ms | recycles | peak heap MB | justifications (axioms) | repairs (axioms each) | applied OK | status                   |
| ------------------ | -----: | ----------- | ---------: | -----: | -----------: | -------: | -----------: | ----------------------- | --------------------- | ---------- | ------------------------ |
| LUBM schema        |    312 | disjoint    |        2.8 |     23 |          121 |        0 |         1024 | 3                       | 1/1/1                 | True       | complete                 |
| LUBM schema        |    314 | unsat       |        2.9 |     25 |          117 |        0 |         1024 | 4                       | 1/1/1/1               | True       | complete                 |
| LUBM schema        |    317 | cardinality |        3.3 |     31 |          107 |        0 |         1024 | 5                       | 1/1/1/1/1             | True       | complete                 |
| LUBM schema        |    322 | three       |       10.1 |     95 |          106 |        0 |         1024 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap |
| Roberts family     |   3871 | disjoint    |       33.7 |     29 |         1158 |        0 |         1861 | 3                       | 1/1/1                 | True       | complete                 |
| Roberts family     |   3873 | unsat       |       41.9 |     35 |         1195 |        0 |         1993 | 4                       | 1/1/1/1               | True       | complete                 |
| Roberts family     |   3876 | cardinality |       51.3 |     37 |         1384 |        1 |         2253 | 5                       | 1/1/1/1/1             | True       | complete                 |
| Roberts family     |   3881 | three       |      135.2 |    121 |         1116 |        3 |         2253 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap |
| PMDco              |  17163 | disjoint    |       13.0 |     31 |          413 |        0 |         1024 | 3                       | 1/1/1                 | True       | complete                 |
| PMDco              |  17165 | unsat       |       15.3 |     35 |          431 |        0 |         1024 | 4                       | 1/1/1/1               | True       | complete                 |
| PMDco              |  17168 | cardinality |       16.5 |     37 |          440 |        0 |         1024 | 5                       | 1/1/1/1/1             | True       | complete                 |
| PMDco              |  17173 | three       |       55.9 |    144 |          385 |        0 |         1729 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap |
| GALEN              |  30822 | disjoint    |       34.8 |     33 |         1044 |        0 |         1333 | 3                       | 1/1/1                 | True       | complete                 |
| GALEN              |  30824 | unsat       |       39.8 |     37 |         1066 |        0 |         1465 | 4                       | 1/1/1/1               | True       | complete                 |
| GALEN              |  30827 | cardinality |       42.4 |     39 |         1077 |        0 |         1465 | 5                       | 1/1/1/1/1             | True       | complete                 |
| GALEN              |  30832 | three       |      160.0 |    154 |         1033 |        2 |         2253 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap |
| LUBM schema + data | 100855 | disjoint    |      105.7 |     43 |         2428 |        4 |         2253 | 3                       | 1/1/1                 | True       | complete                 |
| LUBM schema + data | 100857 | unsat       |      108.3 |     45 |         2375 |        4 |         2253 | 4                       | 1/1/1/1               | True       | complete                 |
| LUBM schema + data | 100860 | cardinality |      128.0 |     51 |         2479 |        5 |         2253 | 5                       | 1/1/1/1/1             | True       | complete                 |
| LUBM schema + data | 100865 | three       |      242.0 |    102 |         2351 |        9 |         2253 | 3/3                     | -                     | -          | incomplete: deadline     |
| PMDco              |  17160 | bfo         |       28.9 |     83 |          346 |        0 |         1201 | 3/3                     | 1/1/2                 | True       | complete                 |

`incomplete: solution-cap` is the `maxRepairs` limit (10), not a failure: three independent clashes with three options each have 27 minimal repair sets. `incomplete: deadline` is the 240 s budget: `repair()` returns what it has (here two complete justifications, no repair computed yet) and never an exception.

### Observations

- **The number of checks does not depend on the ontology size.** A single clash needs 23-51 checks on every ontology from 312 to 100,855 quads (QuickXplain over axiom units scales with the size of the justification, about `k log n`). The latency is `checks x per-check cost`.
- **Per-check cost grows with the ontology and with what the check has to do**: about 0.11 s (312 quads), 0.35-0.44 s (PMDco, 17k), 1.0-1.1 s (GALEN, 30.8k), 2.4 s (LUBM with data, 100k). Roberts (3.9k quads, ABox-heavy) costs 1.1-1.4 s per check: a check on a _consistent_ subset runs the whole classification pipeline, an inconsistent one stops early, and the false justifications that used to dominate the Roberts runs were cheap early failures.
- **A single clash** takes 3-6 s up to 3.9k quads, 13-17 s on PMDco, 35-42 s on GALEN and 106-128 s on the 100k-quad ontology. **Three independent clashes** need about three times the checks and verify up to 10 candidates: 10-56 s on the small ontologies, 135-160 s on Roberts and GALEN, and the 100k-quad ontology reaches the 240 s deadline.
- **Memory**: peak WASM heap 1.0-2.3 GB, no case reached the 4 GiB limit; the heap-triggered Worker recycle fired up to 9 times (100k quads, three clashes). PMDco stays flat at 1,024 MB with the WASM binary named above.
- **Everything returned was verified**: every repair has `verifiedConsistent: true` and applying the first one gave a consistent ontology in every case that computed repairs.

### What the axiom-unit minimization changed

The first version of this benchmark (git 6520312, minimization over individual triples, an older WASM binary) against the current one:

| Ontology           | Clash       | checks before | checks now | repair() s before | repair() s now | justifications before | justifications now |
| ------------------ | ----------- | ------------: | ---------: | ----------------: | -------------: | --------------------- | ------------------ |
| LUBM schema        | disjoint    |            31 |         23 |               3.5 |            2.8 | 3                     | 3                  |
| LUBM schema        | unsat       |            36 |         25 |               4.3 |            2.9 | 4                     | 4                  |
| LUBM schema        | cardinality |            46 |         31 |               5.4 |            3.3 | 5                     | 5                  |
| LUBM schema        | three       |           169 |         95 |              18.4 |           10.1 | 3/3/3                 | 3/3/3              |
| Roberts family     | disjoint    |           584 |         29 |             167.0 |           33.7 | 10/3/10               | 3                  |
| Roberts family     | unsat       |           565 |         35 |             166.3 |           41.9 | 10/4/10               | 4                  |
| Roberts family     | cardinality |           576 |         37 |             189.6 |           51.3 | 10/5/10               | 5                  |
| Roberts family     | three       |           654 |        121 |             240.3 |          135.2 | 10/3/10/3/3/1397      | 3/3/3              |
| PMDco              | disjoint    |            39 |         31 |              18.8 |           13.0 | 3                     | 3                  |
| PMDco              | unsat       |            48 |         35 |              25.0 |           15.3 | 4                     | 4                  |
| PMDco              | cardinality |            54 |         37 |              29.8 |           16.5 | 5                     | 5                  |
| PMDco              | three       |           221 |        144 |             101.4 |           55.9 | 3/3/3                 | 3/3/3              |
| GALEN              | disjoint    |            45 |         33 |              86.0 |           34.8 | 3                     | 3                  |
| GALEN              | unsat       |            50 |         37 |              67.0 |           39.8 | 4                     | 4                  |
| GALEN              | cardinality |            60 |         39 |              83.1 |           42.4 | 5                     | 5                  |
| GALEN              | three       |           169 |        154 |             242.0 |          160.0 | 3/3/4741              | 3/3/3              |
| LUBM schema + data | disjoint    |            49 |         43 |             118.4 |          105.7 | 3                     | 3                  |
| LUBM schema + data | unsat       |            52 |         45 |             128.5 |          108.3 | 4                     | 4                  |
| LUBM schema + data | cardinality |            62 |         51 |             152.2 |          128.0 | 5                     | 5                  |
| LUBM schema + data | three       |           101 |        102 |             243.3 |          242.0 | 3/3/100642            | 3/3                |
| PMDco              | bfo         |           157 |         83 |              51.9 |           28.9 | 3/3                   | 3/3                |

The Roberts rows are the point of the change (565-654 checks and two false 10-axiom justifications before). The other rows combine two effects that this benchmark cannot separate: fewer checks from the smaller candidate set, and the newer WASM binary (PMDco's peak heap fell from 2.5 GB to 1.0 GB).

## Former issue: false justifications on list-heavy ontologies (fixed)

On Roberts family (a consistent base) the first version returned two extra justifications of 10 axioms that contained no injected axiom. Cause, confirmed by single-triple experiments in a fresh reasoner: the minimization worked on individual RDF triples, and for the kernel a subset of an ontology's triples is **not** a weakening of the ontology.

1. **A partial RDF list is a different, stronger axiom.** The 33-triple justification, completed to whole axioms with all 546 declarations of the base added, is consistent. Cutting one `rdf:rest` out of the `hasGreatGrandfather propertyChainAxiom` list makes it inconsistent: a chain cut down to fewer roles is a stronger sub-property axiom. The same holds for intersections and other list-based axioms.
2. **A missing declaration changes the reading of the axioms.** The same complete axioms with only the 8 declarations that were in the justification are inconsistent; adding one triple, `hasGrandfather a owl:ObjectProperty`, makes them consistent.

Fix (this version): `explainInconsistency`, `explainInconsistencyAxioms` and `repair` minimize over **axiom units** (connected components of triples through blank nodes; see `ts/axiomGrouping.ts`), with **all declaration triples as fixed background** of every check. No check set contains part of a list or a restriction, and the justifications are axiom-level. A justification whose search was cut short by the deadline is dropped instead of being returned as a non-minimal set. Declarations of the entities a justification mentions are returned with it (`context`).

## How to run

```
npm run build                      # the node tests and this benchmark load dist/
npm run bench:repair               # whole matrix (about 40 minutes), writes /tmp/repair-bench.jsonl, prints the table
node tests/bench/repair-bench.mjs --only "PMDco"        # a subset of the cases
node tests/bench/repair-example.mjs . tests/fixtures/pmdco.nt bfo    # print the real output of one case
```

The host should be quiet (the driver prints the load average); every case is a fresh process with a fresh `RdfReasoner`.

## Limits of this benchmark

One run per case (no spread), one machine, node only, synthetic clashes except `bfo`, and a WASM binary that changed between the first and the second measurement (see the comparison table), and a 240 s `repair()` timeout (the default is 300 s). Native Konclude has no repair operation, so there is no comparison column.
