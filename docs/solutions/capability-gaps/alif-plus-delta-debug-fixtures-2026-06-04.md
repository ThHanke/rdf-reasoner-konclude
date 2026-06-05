---
module: capability-gaps
tags:
  [
    native-trace,
    functional-property,
    inverse-functional-property,
    alif-plus,
    precomputing-hang,
    delta-debug,
    wasm-regression,
    upstream-bug,
  ]
problem_type: hang-investigation
date: 2026-06-04
---

# ALIF+ Delta-Debug Fixtures — Native Hang Investigation 2026-06-04

## Purpose

Establish minimal deterministic NTriples fixture pairs for `owl:FunctionalProperty` (FP) and
`owl:InverseFunctionalProperty` (IFP) where one fixture completes and the next (one triple
added) hangs. These form the instrumentation baseline for Unit 4 C++ precomputing diagnostics.

**Key finding: The hang occurs in native Konclude v0.7.0, not just WASM. Fixtures B and D both
hang at the precomputing stage on the native Docker image. This confirms the ALIF+ hang is an
upstream Konclude bug (or intended limitation) triggered by FP/IFP merge constraints, not a
WASM-specific regression.**

---

## Test Method

Docker image: `konclude/konclude:latest` (v0.7.0-1138 — 500e11d9, Jun 18 2021)

Fixtures written to `/tmp/konclude-test/`. Command template:

```
timeout 15 docker run --rm -v /tmp/konclude-test:/data konclude/konclude:latest \
  realization -i /data/<file>.nt -o /data/<file>-out.owl 2>&1
```

Timeout: 15 seconds. Exit code 124 = timeout (hang). Exit code 0 = completed.

---

## FunctionalProperty Pair (Fixtures A / B)

### Fixture A — FP, one filler (COMPLETES)

**File:** `/tmp/konclude-test/fixture-a.nt`

**Expressiveness:** `ALIF+`

**Semantic content:** `owl:FunctionalProperty hasMother`. Individual `alice` has exactly one
filler `eve`. No merge constraint is triggered — one filler per subject satisfies functionality
trivially.

```ntriples
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/eve> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/eve> .
```

**Docker stdout (full):**

```
{info} 14:21:30:458 >> Starting Konclude ...
{info} 14:21:30:458 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:21:30:458 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:21:30:468 >> Starting realization processing for ontology '/data/fixture-a.nt'.
{info} 14:21:30:472 >> Initializing reasoner. Creating calculation context.
{info} 14:21:30:488 >> Reasoner initialized with 1 processing unit(s).
{info} 14:21:30:489 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:498 >> Finished preprocessing in 7 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:498 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:30:503 >> Finished precomputing in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:503 >> Classifying ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:30:503 >> Ontology 'http://konclude.com/test/kb' has been sufficiently saturated, extracting data for classification.
{info} 14:21:30:507 >> Finished class classification in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:507 >> Classifying object properties for ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:30:511 >> Finished object property classification in 3 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:512 >> Realizing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:30:517 >> Finished (lazy) realization in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:30:517 >> Query 'UnnamedRealizeQuery' processed in '0' ms.
{info} 14:21:30:519 >> Query 'UnnamedWriteIndividualTypesQuery' processed in '0' ms.
EXIT:0
```

**Pipeline timing:**

| Stage                          | Duration |
| ------------------------------ | -------- |
| Preprocessing                  | 7 ms     |
| Precomputing (`ALIF+`)         | 4 ms     |
| Class classification           | 3 ms     |
| Object property classification | 3 ms     |
| Realization (lazy)             | 4 ms     |

**Output file:** `/tmp/konclude-test/fixture-a-out.owl` — contains `owl:Thing` assertions for
`alice` and `eve`.

---

### Fixture B — FP, two fillers (HANGS — native)

**File:** `/tmp/konclude-test/fixture-b.nt`

**Expressiveness:** `ALIF+`

**Delta from Fixture A:** +2 triples:

```ntriples
<http://ex.org/carol> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/carol> .
```

**Semantic content:** `alice` now has two distinct named fillers (`eve`, `carol`) for the
functional property `hasMother`. This forces Konclude to attempt a merge of the two fillers,
which is the precomputing step that hangs.

**Full fixture:**

```ntriples
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/eve> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/eve> .
<http://ex.org/carol> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/carol> .
```

**Docker stdout (full — timeout at 15s):**

```
{info} 14:21:39:052 >> Starting Konclude ...
{info} 14:21:39:052 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:21:39:052 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:21:39:061 >> Starting realization processing for ontology '/data/fixture-b.nt'.
{info} 14:21:39:065 >> Initializing reasoner. Creating calculation context.
{info} 14:21:39:076 >> Reasoner initialized with 1 processing unit(s).
{info} 14:21:39:080 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:21:39:088 >> Finished preprocessing in 6 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:39:088 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
[HANG — no further output before 15s timeout]
EXIT:124
```

**Hang location:** Inside the precomputing stage, after the log line `Precomputing ontology ...
expressiveness 'ALIF+'`. No "Finished precomputing" line ever appears.

---

### Fixture B-notyping — FP, two fillers, no owl:NamedIndividual typing (HANGS — native)

**File:** `/tmp/konclude-test/fixture-b-notyping.nt`

**Purpose:** Verify whether omitting `owl:NamedIndividual` type declarations changes behavior.

```ntriples
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasMother> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/eve> .
<http://ex.org/alice> <http://ex.org/hasMother> <http://ex.org/carol> .
```

**Docker stdout (full — timeout at 15s):**

```
{info} 14:23:11:509 >> Starting Konclude ...
{info} 14:23:11:510 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:23:11:510 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:23:11:521 >> Starting realization processing for ontology '/data/fixture-b-notyping.nt'.
{info} 14:23:11:525 >> Initializing reasoner. Creating calculation context.
{info} 14:23:11:537 >> Reasoner initialized with 1 processing unit(s).
{info} 14:23:11:537 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:23:11:550 >> Finished preprocessing in 12 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:23:11:550 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
[HANG — no further output before 15s timeout]
EXIT:124
```

**Result:** Still hangs. Omitting `owl:NamedIndividual` typing does not change behavior.
Expressiveness is still elevated to `ALIF+` by the two-filler FP pattern alone.

---

## InverseFunctionalProperty Pair (Fixtures C / D)

### Fixture C — IFP, one subject (COMPLETES)

**File:** `/tmp/konclude-test/fixture-c.nt`

**Expressiveness:** `ALIF+`

**Semantic content:** `owl:InverseFunctionalProperty hasDNA`. Individual `alice` has one IFP
assertion pointing to `seq1`. No merge constraint is triggered — one subject per filler
satisfies inverse functionality trivially.

```ntriples
<http://ex.org/hasDNA> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasDNA> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#InverseFunctionalProperty> .
<http://ex.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/seq1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasDNA> <http://ex.org/seq1> .
```

**Docker stdout (full):**

```
{info} 14:21:32:979 >> Starting Konclude ...
{info} 14:21:32:979 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:21:32:979 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:21:32:989 >> Starting realization processing for ontology '/data/fixture-c.nt'.
{info} 14:21:32:993 >> Initializing reasoner. Creating calculation context.
{info} 14:21:33:000 >> Reasoner initialized with 1 processing unit(s).
{info} 14:21:33:003 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:013 >> Finished preprocessing in 9 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:013 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:33:018 >> Finished precomputing in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:018 >> Classifying ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:33:018 >> Ontology 'http://konclude.com/test/kb' has been sufficiently saturated, extracting data for classification.
{info} 14:21:33:021 >> Finished class classification in 2 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:021 >> Classifying object properties for ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:33:026 >> Finished object property classification in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:026 >> Realizing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
{info} 14:21:33:031 >> Finished (lazy) realization in 4 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:21:33:031 >> Query 'UnnamedRealizeQuery' processed in '0' ms.
{info} 14:21:33:034 >> Query 'UnnamedWriteIndividualTypesQuery' processed in '1' ms.
EXIT:0
```

**Pipeline timing:**

| Stage                          | Duration |
| ------------------------------ | -------- |
| Preprocessing                  | 9 ms     |
| Precomputing (`ALIF+`)         | 4 ms     |
| Class classification           | 2 ms     |
| Object property classification | 4 ms     |
| Realization (lazy)             | 4 ms     |

**Output file:** `/tmp/konclude-test/fixture-c-out.owl` — contains `owl:Thing` assertions for
`alice` and `seq1`.

---

### Fixture D — IFP, two subjects (HANGS — native)

**File:** `/tmp/konclude-test/fixture-d.nt`

**Expressiveness:** `ALIF+`

**Delta from Fixture C:** +2 triples:

```ntriples
<http://ex.org/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/bob> <http://ex.org/hasDNA> <http://ex.org/seq1> .
```

**Semantic content:** Both `alice` and `bob` now point to the same filler `seq1` via the
inverse-functional property `hasDNA`. IFP forces a merge of `alice` and `bob` (they must be the
same individual). This merge attempt is the precomputing step that hangs.

**Full fixture:**

```ntriples
<http://ex.org/hasDNA> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/hasDNA> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#InverseFunctionalProperty> .
<http://ex.org/alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/seq1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/alice> <http://ex.org/hasDNA> <http://ex.org/seq1> .
<http://ex.org/bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://ex.org/bob> <http://ex.org/hasDNA> <http://ex.org/seq1> .
```

**Docker stdout (full — timeout at 15s):**

```
{info} 14:22:11:132 >> Starting Konclude ...
{info} 14:22:11:132 >> Konclude - Uni Ulm Parallel Reasoner
{info} 14:22:11:132 >> Reasoner for the SROIQV(D) Description Logic, 64-bit, Version v0.7.0-1138 - 500e11d9 (Jun 18 2021)

{info} 14:22:11:140 >> Starting realization processing for ontology '/data/fixture-d.nt'.
{info} 14:22:11:144 >> Initializing reasoner. Creating calculation context.
{info} 14:22:11:158 >> Reasoner initialized with 1 processing unit(s).
{info} 14:22:11:158 >> Preprocessing ontology 'http://konclude.com/test/kb'.
{info} 14:22:11:166 >> Finished preprocessing in 6 ms for ontology 'http://konclude.com/test/kb'.
{info} 14:22:11:167 >> Precomputing ontology 'http://konclude.com/test/kb', expressiveness 'ALIF+'.
[HANG — no further output before 15s timeout]
EXIT:124
```

**Hang location:** Same as Fixture B — inside the precomputing stage, after the log line
`Precomputing ontology ... expressiveness 'ALIF+'`.

---

## Summary Table

| Fixture | Property | ABox pattern             | Triples | Expressiveness | Native result |
| ------- | -------- | ------------------------ | ------- | -------------- | ------------- |
| A       | FP       | 1 filler for alice       | 5       | `ALIF+`        | COMPLETES ~19ms |
| B       | FP       | 2 fillers for alice      | 7       | `ALIF+`        | HANG (>15s)   |
| B-notyping | FP    | 2 fillers, no NI typing  | 4       | `ALIF+`        | HANG (>15s)   |
| C       | IFP      | 1 subject for seq1       | 5       | `ALIF+`        | COMPLETES ~19ms |
| D       | IFP      | 2 subjects for seq1      | 7       | `ALIF+`        | HANG (>15s)   |

**Minimal delta (FP):** exactly 2 triples (`carol NI` + `alice hasMother carol`), or exactly 1
triple if owl:NamedIndividual typing is dropped (`alice hasMother carol` alone). The anonymous
`carol` individual is inferred from the property assertion even without explicit typing.

**Minimal delta (IFP):** exactly 2 triples (`bob NI` + `bob hasDNA seq1`).

---

## Analysis

### Hang stage: Precomputing

The "Precomputing" stage in Konclude implements BackendAssociatedCache (BackendAssCache) build
and ABox saturation. Per the native operation mechanism trace (see
`si-realization-hang-native-trace-2026-06-03.md`), precomputing performs two update phases
(`Update1 → Retrieval1 → saturation → Update2`) to establish the saturation context needed for
classification and realization.

For FP/IFP with two merge candidates, the saturation must apply a functionality merge rule:

- **FP:** `hasMother(alice, eve) ∧ hasMother(alice, carol) ∧ Functional(hasMother)` → merge
  `eve` and `carol` into a single anonymous node.
- **IFP:** `hasDNA(alice, seq1) ∧ hasDNA(bob, seq1) ∧ InverseFunctional(hasDNA)` → merge
  `alice` and `bob` into a single anonymous node.

The hang occurs when Konclude's precomputing thread waits for a merge result that is never
delivered. This is consistent with the known ALIF+ precomputing hang documented in
`project_owl2dl_parity_gaps.md` (R8 entry).

### Native hang, not WASM regression

**Important:** This is confirmed to be a native Konclude hang. The Docker image
`konclude/konclude:latest` (v0.7.0-1138) hangs on Fixtures B and D. The WASM build's hang on
the same fixtures is therefore:

1. Not a bug introduced by the WASM port — it reproduces natively.
2. A correct indicator of a known Konclude upstream limitation in the `ALIF+` precomputing path
   when named individuals must be merged.
3. Consistent with the upstream bug inventory in `project_upstream_konclude_bugs.md` (the
   `FunctionalProperty+ABox ALIF+ hang` entry).

### Why Fixture A/C complete but B/D hang

Fixtures A and C involve a functional/inverse-functional property with a single filler or
subject per relevant pair — no merge is required. The precomputing stage succeeds immediately
because no equality constraint needs to be discharged.

Fixtures B and D require the reasoner to merge two distinct named individuals. In the OWA
(open-world assumption) ALIQ/ALIF+ tableau, merging two named individuals (which are distinct
under the UNA — unique name assumption — unless explicitly unified) is a non-trivial operation.
Konclude's native precomputing code hangs waiting for this merge to complete, suggesting a
deadlock in the merge propagation mechanism for ALIF+ ABox saturation.

### Expressiveness notes

All four fixtures are labeled `ALIF+` by Konclude, including the one-filler cases (A and C).
The `F` in `ALIF+` is contributed by the presence of the `owl:FunctionalProperty` or
`owl:InverseFunctionalProperty` axiom in the TBox. The `+` suffix indicates ABox individuals are
present. The expressiveness label alone does not distinguish the passing from the hanging cases —
the hang is triggered by the *number* of merge candidates, not merely the presence of FP/IFP.

---

## Implications for Unit 4

The precomputing hang is in the **native** Konclude code path. Unit 4 instrumentation of the
WASM build will need to instrument the precomputing/saturation C++ code to confirm whether:

1. The hang is a deadlock (thread waiting for a condition that is never signalled).
2. The hang is an infinite loop (saturation rule firing repeatedly without progress).
3. The hang differs between native and WASM builds in *where* it stalls (e.g., different thread
   synchronization in the WASM pthreads pool).

The minimal fixtures established here (Fixture A/B for FP, C/D for IFP) provide the smallest
possible ontologies to trigger each behavior, minimizing noise in the precomputing trace.

---

## Fixture Files

All fixtures are at `/tmp/konclude-test/` (ephemeral; recreate for each investigation session):

- `fixture-a.nt` — FP, 1 filler (COMPLETES)
- `fixture-b.nt` — FP, 2 fillers (HANGS)
- `fixture-b-notyping.nt` — FP, 2 fillers, no NI typing (HANGS)
- `fixture-c.nt` — IFP, 1 subject (COMPLETES)
- `fixture-d.nt` — IFP, 2 subjects (HANGS)

---

## Unit 4 WASM Verbose Log Observations

**Build:** `WASM_PRECOMP_VERBOSE=ON` via `docker-compose.override.yml`, applied via
`patches/032-precomp-verbose-logging.patch`. Log points instrument
`CTotallyPrecomputationThread::createNextTest()` and related phase-gate functions.

**Test method:** Vitest run with a warmup `checkConsistency` call (no FP) before each fixture.
Output captured from `[WASM-PRECOMP]` lines in stderr during the test run.

**Key discovery: Fixture A is a WASM regression** — it also hangs in WASM, despite completing
in ~19ms in native Konclude v0.7.0. The native ALIF+ hang was confirmed to affect only the
2-filler (Fixture B) case natively; the WASM port has a worse hang that triggers even with
1 filler (Fixture A).

### Warmup (no FP) — COMPLETES

The trivial warmup ontology (no `owl:FunctionalProperty`) processes through all phase gates:

```text
[WASM-PRECOMP] createNextTest: entry, processingList.size()=1
[WASM-PRECOMP] before-while: isEmpty=N
[WASM-PRECOMP] while-iter-start
[WASM-PRECOMP] got-first, ptr=0x5c18000
[WASM-PRECOMP] cast-done, ptr=0x5c18000
[WASM-PRECOMP] loop: consistenceStepRequired=Y, finished=N, reqsSatisfied=Y, conceptSatCreated=N
[WASM-PRECOMP] phaseGate: CONCEPT_SAT_JOB_CREATE, indiCount=3
[WASM-PRECOMP] phaseGate: CONCEPT_SAT_JOB_SUBMITTED
[WASM-PRECOMP] phaseGate: INDIVIDUALS_QUEUED, indiAdded=true, remaining=1
[WASM-PRECOMP] ...
[WASM-PRECOMP] phaseGate: INDI_SAT_JOB_SUBMIT, batchSize=1
[WASM-PRECOMP] phaseGate: INDI_SAT_BATCH_DONE, saturationID=1
[WASM-PRECOMP] phaseGate: ALL_INDI_SAT_DONE_SYNC_RETRIEVE_START
[WASM-PRECOMP] phaseGate: BACKEND_CACHE_RETRIEVE_START, fullCG=true, limit=-1
[WASM-PRECOMP] phaseGate: BACKEND_CACHE_RETRIEVE_DONE, resultSize=0
[WASM-PRECOMP] phaseGate: ALL_INDI_SAT_DONE_SYNC_RETRIEVE_DONE
[WASM-PRECOMP] phaseGate: CREATE_CONSISTENCE_CHECK_START
[WASM-PRECOMP] isAllAssertionIndiSatSufficient: checked=true, result=true
[WASM-PRECOMP] phaseGate: FINISH_ONTOLOGY_PRECOMPUTATION, allStepsFinished=false
```

### Fixture A — FP, 1 filler — HANGS IN WASM

Last log line before hang (same thread, immediately after warmup completes):

```text
[WASM-PRECOMP] createNextTest: entry, processingList.size()=1
```

No further output. The `before-while` log never fires. The hang occurs after the very first
`createNextTest()` call for the FP ontology — the function body never reaches the while-loop
condition check. This is **a WASM regression** — native Konclude v0.7.0 completes Fixture A
in ~19ms.

### Fixture B — FP, 2 fillers — HANGS IN WASM

Last log line before hang:

```text
[WASM-PRECOMP] createNextTest: entry, processingList.size()=1
```

**Identical to Fixture A.** No divergence between 1-filler and 2-filler cases in WASM.

### Exact divergence point

**There is no divergence between Fixture A and Fixture B in WASM.** Both hang at the same
phase: `createNextTest: entry` → hang (no `before-while` log). The WASM hang point is
**earlier** than the native hang point:

| Build  | Fixture A (1 filler) | Fixture B (2 fillers) | Hang point                                                    |
| ------ | -------------------- | --------------------- | ------------------------------------------------------------- |
| Native | COMPLETES ~19ms      | HANGS in precomputing | After "Precomputing ontology … ALIF+" log                     |
| WASM   | HANGS                | HANGS                 | After first `createNextTest: entry` — before `before-while`   |

The WASM hang precedes even the first `while` loop iteration in `createNextTest()`. This
suggests the hang is in the **initialization of the precomputing phase** for ALIF+ ontologies
— specifically in the machinery that routes the precomputing event to the thread before
`createNextTest()` is called again.

### Working hypothesis

The `createNextTest: entry` log fires from the main WASM thread context (event handler
dispatch). After creating the concept saturation job (if it reaches `CONCEPT_SAT_JOB_SUBMITTED`)
the job is submitted to the STPU. For FP-containing ontologies, the STPU or the saturation
kernel hangs before the callback returns to the precomputing thread, so `createNextTest()` is
never called a second time. Since even Fixture A (1 filler, no merge needed) hangs, the
trigger is the *presence of `owl:FunctionalProperty`* in the ALIF+ expressiveness path, not
the *number of fillers*.

**Next investigation step (superseded by Unit 1 — see below):** Add logging to `createSaturationConstructionJob()` and the STPU
dispatch to confirm whether the hang is in the concept saturation job itself (STPU-level
deadlock for ALIF+ TBox) or in the precomputing thread's event delivery mechanism.

---

## Hypothesis Testing Results (Unit 1)

**Date:** 2026-06-05

**Build:** `WASM_PRECOMP_VERBOSE=ON` compiled into `dist/konclude.wasm` via
`patches/032-precomp-verbose-logging.patch` + `patches/033-precomp-diagnostic-verbose.patch`.
Diagnostic test: `tests/integration/alif-debug.test.ts`.

### Log lines observed (FP call — Fixture A)

The full precompute sequence for the warmup (`checkConsistency`, non-FP) completes normally,
then classification runs. After classification, the second precompute event fires:

```text
[WASM-PRECOMP] precompute-event: ontId=4680967221865528148
```

Then the test times out (6s). **No further log lines appear.** Specifically:
- `createNextTest: entry` — does NOT fire
- `after-entry-A`, `after-entry-B`, `after-entry-C` — do NOT fire
- `before-while` — does NOT fire

### Which hypothesis is confirmed

**H3 confirmed (variant): `canProcessMoreTests()` returns false — `mCurrRunningTestParallelCount` is not zero.**

The hang is between `precompute-event` log and the first instruction of `createNextTest()`. The
`doNextPendingTests()` function body checks `canProcessMoreTests()` before calling
`createNextTest()`. `mConfMaxTestParallelCount` is 1. If `mCurrRunningTestParallelCount >= 1`
at the moment of the second `precompute-event`, `doNextPendingTests()` exits the while loop
immediately without calling `createNextTest()` at all — and the thread then waits for a
calculation callback to decrement `mCurrRunningTestParallelCount`.

The precomputing thread is stalled in `waitForCallback()` (or equivalent idle event-loop wait)
waiting for a `CPrecomputationCalculatedCallbackEvent` that never arrives. This means:

1. A calculation job was submitted during the FIRST precomputation sequence (classification).
2. The callback for that job was never delivered (or delivered to a different ontology item).
3. `mCurrRunningTestParallelCount` was not decremented, so it remains 1 when the realization
   precompute event arrives.
4. `doNextPendingTests()` exits without calling `createNextTest()`, and the thread idles
   forever.

### Exact hang point

```
CPrecomputationThread::processCustomsEvents()
  → doNextPendingTests()
    → canProcessMoreTests() returns false (mCurrRunningTestParallelCount=1)
    → createNextTest() never called
  → thread returns to event loop and waits for callback that never arrives
```

### New hypothesis for Unit 2

The stale `mCurrRunningTestParallelCount=1` after the FIRST precompute cycle (classification)
suggests a job was submitted in phase-gate `CONCEPT_SAT_JOB_SUBMITTED` but its callback was
either:

- Delivered to the first ontology item (classification) but then the item was cleaned up or
  reset, causing `mCurrRunningTestParallelCount` to remain incremented.
- OR: the callback IS delivered to a different ontology context (second precompute cycle =
  realization), and the counter is decremented, but only AFTER a timeout waiting for it.

**Next investigation step:** Add `mCurrRunningTestParallelCount` logging to
`doNextPendingTests()` before the while-loop condition check. This will confirm whether
`canProcessMoreTests()` is the gate that prevents `createNextTest()` from being called in
the second precompute sequence.
