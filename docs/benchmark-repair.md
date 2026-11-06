# `repair()` benchmark

Latency and robustness of `RdfReasoner.repair()` across ontology sizes and kinds of inconsistency. Scripts: [`tests/bench/repair-bench.mjs`](../tests/bench/repair-bench.mjs) (matrix driver), [`repair-case.mjs`](../tests/bench/repair-case.mjs) (one case), [`repair-clashes.mjs`](../tests/bench/repair-clashes.mjs) (the injected clashes), [`repair-example.mjs`](../tests/bench/repair-example.mjs) (prints real output). Speed benchmark of the reasoner itself: [`docs/benchmark.md`](benchmark.md).

```
Date:      2026-11-06
Package:   rdf-reasoner-konclude 0.8.0  (git 6520312)
Host:      Intel(R) Xeon(R) Silver 4216 CPU @ 2.10GHz, 8 cores, 41 GB; load average at start 0.11
Runtime:   Node v25.1.0, node build (dist/worker-node.mjs); NOT measured in a browser
Budget:    repair() timeout 240000 ms per case, maxRepairs 10, one fresh process per case, one run per case
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
ontology: 307 quads + injected clash "disjoint"   repair() took 3.9 s
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
ontology: 307 quads + injected clash "cardinality"   repair() took 5.3 s
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
ontology: 307 quads + injected clash "three"   repair() took 16.1 s
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
ontology: 17158 quads + injected clash "bfo"   repair() took 52.0 s
consistent: false   incomplete: false

justifications (2):
  [0] 3 axioms, 2 declaration triples in context
        obo:BFO_0000004 owl:disjointWith obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000004
  [1] 3 axioms, 2 declaration triples in context
        bx:x rdf:type obo:BFO_0000020
        bx:x rdf:type obo:BFO_0000004
        _:b1 rdf:type owl:AllDisjointClasses   [+7 more triple(s) of the same axiom]

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

One run per case, fresh process, `repair()` budget 240 s. The case runner now records `baseConsistent` itself and the report marks an inconsistent base as `INVALID`; this matrix was measured before that check existed, so the bases were verified separately (all consistent). `checks` = consistency checks issued to the kernel; `recycles` = Worker recycles triggered by the heap threshold; `applied OK` = consistency after removing the first repair from a copy.

| Ontology           |  Quads | Clash       | repair() s | checks | avg check ms | recycles | peak heap MB | justifications (axioms) | repairs (axioms each) | applied OK | status                     |
| ------------------ | -----: | ----------- | ---------: | -----: | -----------: | -------: | -----------: | ----------------------- | --------------------- | ---------- | -------------------------- |
| LUBM schema        |    312 | disjoint    |        3.5 |     31 |          114 |        0 |         1024 | 3                       | 1/1/1                 | True       | complete                   |
| LUBM schema        |    314 | unsat       |        4.3 |     36 |          119 |        0 |         1024 | 4                       | 1/1/1/1               | True       | complete                   |
| LUBM schema        |    317 | cardinality |        5.4 |     46 |          117 |        0 |         1024 | 5                       | 1/1/1/1/1             | True       | complete                   |
| LUBM schema        |    322 | three       |       18.4 |    169 |          109 |        0 |         1024 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap   |
| Roberts family     |   3871 | disjoint    |      167.0 |    584 |          286 |        3 |         2253 | 10/3/10                 | 2/2/2/2/2/2/2/2/2/2   | True       | incomplete: solution-cap † |
| Roberts family     |   3873 | unsat       |      166.3 |    565 |          294 |        3 |         2253 | 10/4/10                 | 2/2/2/2/2/2/2/2/2/2   | True       | incomplete: solution-cap † |
| Roberts family     |   3876 | cardinality |      189.6 |    576 |          329 |        4 |         2253 | 10/5/10                 | 2/2/2/2/2/2/2/2/2/2   | True       | incomplete: solution-cap † |
| Roberts family     |   3881 | three       |      240.3 |    654 |          367 |        6 |         2253 | 10/3/10/3/3/1397        | -                     | -          | incomplete: deadline †     |
| PMDco              |  17163 | disjoint    |       18.8 |     39 |          477 |        1 |         2513 | 3                       | 1/1/1                 | True       | complete                   |
| PMDco              |  17165 | unsat       |       25.0 |     48 |          517 |        2 |         2253 | 4                       | 1/1/1/1               | True       | complete                   |
| PMDco              |  17168 | cardinality |       29.8 |     54 |          547 |        3 |         2513 | 5                       | 1/1/1/1/1             | True       | complete                   |
| PMDco              |  17173 | three       |      101.4 |    221 |          457 |        9 |         2773 | 3/3/3                   | 3/3/3/3/3/3/3/3/3/3   | True       | incomplete: solution-cap   |
| GALEN              |  30822 | disjoint    |       86.0 |     45 |         1906 |        0 |         1797 | 3                       | 1/1/1                 | True       | complete                   |
| GALEN              |  30824 | unsat       |       67.0 |     50 |         1333 |        0 |         1993 | 4                       | 1/1/1/1               | True       | complete                   |
| GALEN              |  30827 | cardinality |       83.1 |     60 |         1379 |        1 |         2253 | 5                       | 1/1/1/1/1             | True       | complete                   |
| GALEN              |  30832 | three       |      242.0 |    169 |         1424 |        4 |         2257 | 3/3/4741                | -                     | -          | incomplete: deadline ‡     |
| LUBM schema + data | 100855 | disjoint    |      118.4 |     49 |         2401 |        5 |         2253 | 3                       | 1/1/1                 | True       | complete                   |
| LUBM schema + data | 100857 | unsat       |      128.5 |     52 |         2454 |        5 |         2253 | 4                       | 1/1/1/1               | True       | complete                   |
| LUBM schema + data | 100860 | cardinality |      152.2 |     62 |         2437 |        6 |         2253 | 5                       | 1/1/1/1/1             | True       | complete                   |
| LUBM schema + data | 100865 | three       |      243.3 |    101 |         2389 |       10 |         2253 | 3/3/100642              | -                     | -          | incomplete: deadline ‡     |
| PMDco              |  17160 | bfo         |       51.9 |    157 |          329 |        4 |         2709 | 3/3                     | 1/1/2                 | True       | complete                   |

† Roberts family: the 10-axiom justifications contain no injected axiom and are most likely false positives, see [Known issue](#known-issue-false-justifications-on-list-heavy-ontologies). The base is consistent.
‡ At the deadline the last justification is the smallest inconsistent set found so far, which is **not minimal** (4741 and 100642 axioms) and no repair was computed. `incomplete: deadline` is the only signal; this should not be reported as a justification (follow-up).

`incomplete: solution-cap` is the `maxRepairs` limit (10), not a failure: three independent clashes with three options each have 27 minimal repair sets.

### Observations

- **The number of checks does not depend on the ontology size.** A clean single clash needs 31-62 checks on every ontology from 312 to 100,855 quads (QuickXplain scales with the size of the justification, about `k log n`). The latency is therefore `checks x per-check cost`.
- **Per-check cost grows with the ontology**: about 0.11 s (312 quads), 0.33-0.55 s (17k), 1.3-1.9 s (30.8k), 2.4 s (100k). A single clash on up to 17k quads takes 3-30 s; GALEN 67-86 s; the 100k-quad LUBM with data 118-152 s.
- **Three independent clashes** need 3x the work plus the verification of up to 10 candidates: 101 s on PMDco, over 240 s on GALEN and LUBM with data (returned as `incomplete: deadline`, never as an exception or hang).
- **Memory**: peak WASM heap 1.0-2.8 GB; the heap-triggered Worker recycle fired up to 10 times (100k quads, three clashes) and no case hit the 4 GiB limit. Without the recycle, the kernel's per-check heap retention would have reached the limit (the heap investigation is tracked separately).
- **Everything returned was verified**: every repair that was returned has `verifiedConsistent: true`, and applying the first one gave a consistent ontology in every case.

## Known issue: false justifications on list-heavy ontologies

On Roberts family the base ontology is consistent (checked: `checkConsistency` is `true` for `roberts-family.nt`, `roberts-160.nt`, `roberts-240.nt`, `lubm.nt`, `pmdco.nt` and `galen.nt`), yet `repair()` returns two extra justifications of 10 axioms that contain no injected axiom (Roberts axioms only: `Woman ≡ ...`, `hasMother range Woman`, `Man ≡ ...`, a property chain, `Female disjointWith Male`, `hasGender` functional ...). That multiplies the checks (565-654) and the repair list.

What was established with direct checks (all in a fresh reasoner):

- The 33-triple flat justification is reported inconsistent on its own, also with all 546 declaration triples of the base added, and also after every axiom is completed to its full blank-node closure.
- Growing that set towards the full ontology, the answer flips to "consistent" when **one triple is added: an `rdf:rest` of an RDF list cell** (`_:b rdf:first isSpouseOf` whose `rdf:rest` was missing).
- The kernel's log for these sets shows the same failure lines as a genuine clash (`'Consistency-Checking' processing step failed`), and the mapper complains elsewhere about incomplete expressions (`Couldn't extract minimal required 2 Class-Expressions`).

Working explanation: `consistency()` returns `false` whenever the classification pipeline fails, for any reason; a **malformed RDF structure** (a list cell without its `rest`, an incomplete expression) makes the pipeline fail and is reported as "inconsistent". QuickXplain removes triples one by one and can leave such fragments, so on ontologies with many lists (property chains, intersections) it can return false justifications. PMDco contains lists too, but no false justification occurred there in these runs. The verification step is not affected (it checks the full ontology), so every returned repair is valid, but the repairs can contain unnecessary axioms and the `minimal` flag is not reliable on such inputs.

Proposed fix (not implemented): run the minimization on **whole axioms** (blank-node closure units, declarations as always-present background) so no check set contains a partial structure, and make the kernel report a failed load/mapping separately from a real inconsistency.

## How to run

```
npm run build                      # the node tests and this benchmark load dist/
npm run bench:repair               # whole matrix (about 40 minutes), writes /tmp/repair-bench.jsonl, prints the table
node tests/bench/repair-bench.mjs --only "PMDco"        # a subset of the cases
node tests/bench/repair-example.mjs . tests/fixtures/pmdco.nt bfo    # print the real output of one case
```

The host should be quiet (the driver prints the load average); every case is a fresh process with a fresh `RdfReasoner`.

## Limits of this benchmark

One run per case (no spread), one machine, node only, synthetic clashes except `bfo`, and a 240 s `repair()` timeout (the default is 300 s). Native Konclude has no repair operation, so there is no comparison column.
