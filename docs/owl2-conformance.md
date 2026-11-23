# OWL 2 DL conformance

What the reasoner is tested against, how it scores on the W3C OWL 2 test suite, which language features are supported, and which known gaps remain with their causes.

- [Scope and method](#scope-and-method)
- [Results](#results)
- [Supported features](#supported-features)
- [Datatypes](#datatypes)
- [Entailment](#entailment)
- [Known gaps](#known-gaps)
- [Parity with native Konclude](#parity-with-native-konclude)
- [How the tests are organised](#how-the-tests-are-organised)
- [How to reproduce](#how-to-reproduce)

## Scope and method

The reasoner is **Konclude 0.7.x compiled to WebAssembly** with a TypeScript layer around it. Conformance is measured on the **W3C OWL 2 approved test cases** (`https://www.w3.org/2009/11/owl-test/approved/all.rdf`, downloaded 2026-11-14), restricted to the tests whose species include **DL** and whose semantics include the **Direct Semantics**: 266 tests. The other 89 approved tests are OWL Full only. No DL test was selected or dropped by hand.

- **Consistency tests.** For each test the premise is loaded and `checkConsistency` must give the expected verdict. Two sets are run: *raw* (the premise as published, or its ROBOT conversion where the test exists only in functional syntax) and *normalized* (the premise rewritten as RDF/XML by ROBOT 1.9.11; 264 tests, two XML-literal tests cannot be written that way).
- **Entailment tests (84, raw set).** A conclusion is checked by refutation: the premise plus the negation of each conclusion axiom (probe ontologies written with ROBOT) must be inconsistent. Where probes cannot be built the harness falls back to `isEntailed` on named triples, and reports "unsupported" when the conclusion has blank nodes or annotations.
- Every step has a 60 s limit; after a timeout the reasoner is restarted.

The tools (harness, case files, per-test verdict tables) are in the reviewer kit `docs/experiments/pr18-reviewer-kit/` (not part of the repository history). The cases that guard against regressions are copied as N-Triples into `tests/fixtures/w3c-pr18/` and run by `tests/integration/w3c-conformance-pr18.test.ts`.

## Results

| Run | PR #18 as delivered | This branch |
|---|---|---|
| Consistency, raw set (266) | 247 correct | **265 correct** |
| Consistency, normalized set (264) | 247 correct | **263 correct** |
| Entailment (84) | 60 correct, 4 wrong, 20 unsupported | **68 correct, 3 wrong, 13 unsupported** |
| Native Konclude 0.7.0 (reference) | consistency 241 correct; entailment 59 correct, 9 wrong, 16 unsupported | |

The only consistency case still wrong is `WebOnt-description-logic-035`. Cases fixed on top of the PR: `New-Feature-Rational-003`, `Plus_and_Minus_Zero_are_Distinct`, `Datatype-Float-Discrete-001`, `Minus_Infinity_is_not_in_owl_real`, `one_two`, `WebOnt-description-logic-008`, `-012`, `-013`, `-015`, `-017`, `-105`, `-502`, `-612`, `-613`, `-615`, `-617`, `WebOnt-miscellaneous-203`, `-204`. No case that was correct before became wrong.

## Supported features

| Area | Status |
|---|---|
| Class expressions: intersection, union, complement, one-of, all/some/has-value/has-self restrictions, (qualified) cardinalities | supported |
| Property axioms: sub-property, equivalent, inverse, domain, range, characteristics (functional, inverse-functional, transitive, symmetric, asymmetric, reflexive, irreflexive), disjoint properties, property chains | supported |
| Individuals: types, property assertions, same/different individuals, negative property assertions (rewritten), `owl:hasKey` (rewritten) | supported |
| Data ranges: datatype restrictions with facets, complement, one-of, union/intersection | supported for the datatypes below |
| Punning, imports | imports are not resolved by the library: load the imported ontology into the store yourself |
| Rules | DL-safe SWRL in `materialize`, see [swrl.md](swrl.md) |
| OWL 1 style constructors on a named class | rewritten (one equivalent class per constructor triple, so several `owl:oneOf` lists are an intersection) |
| Annotations | inert for reasoning; `isEntailedGraph` can look them up |

Reasoning tasks: consistency, classification, realization, property classification, satisfiability, entailment, explanations, repair. See [api.md](api.md).

## Datatypes

Supported value spaces: integers and all derived integer types with their bounds (including the signed minimums), `xsd:decimal`, `owl:rational`, `owl:real`, `xsd:float`, `xsd:double` (with -0, +0, INF, NaN), strings and languages, booleans, binary, IRIs, date and time types, and `rdf:XMLLiteral` (compared by canonical form).

- Integers are represented in 64 bits. A valid `xsd:integer` beyond that is not representable and is reported by `lastLiteralIssues` as `beyond-kernel-integers`.
- Ill-typed literals are dropped by the kernel; they are listed (default) or rejected (`illTypedLiterals: "error"`). See [options.md](options.md#ill-typed-literals).
- Datatype clashes between value spaces (an integer where a string is required), negated derived datatypes and data cardinality over enumerated ranges are decided correctly (fixed in this adoption, see the tests `datatype-value-space`, `datatype-bounds`, `data-cardinality`).
- `rdf:XMLLiteral`: XML is not parsed by the kernel. The library sends the canonical form (attributes sorted, empty elements expanded, entities normalized, whitespace text nodes kept), so equal XML values compare equal. Equality is by canonical string, not by full XML infoset.

## Entailment

`isEntailed` decides subsumption (with the transitive closure of the hierarchy), type, `sameAs`, equivalent properties, ranges and domains, disjointness, property assertions of declared properties, property characteristics and declarations. `isEntailedGraph` additionally decides conclusions with anonymous individuals (existential trees) and annotation triples. `false` means *not entailed* (open world), `null` means *not decided*. Details and the table of shapes: [api.md](api.md#isentailedstore-axiom-quad-opts-promiseboolean--null-and-isentailedstore-axioms-quad-opts-promiseboolean--null).

Of the 84 W3C entailment tests: 68 correct. The 3 wrong (`Consistent-but-all-unsat`, `WebOnt-I5.8-010`, `WebOnt-imports-011`) are wrong in native Konclude too (value-space reasoning over a single forced value; imports not loaded by the harness). The 13 unsupported are conclusions that are annotation triples (not DL entailment), or anonymous class expressions on both sides of a subclass axiom, or a kernel limit.

## Known gaps

| Case | Wrong because | Notes |
|---|---|---|
| `WebOnt-description-logic-035` | consistency says consistent; the saturation and the full tableau both miss the clash (nominal `spy`, inverse role `invP` with `≤2`, a class with `≥3 r`; cardinality pairs `(3,2)`, `(4,2)`, `(4,3)` are missed, `(2,1)`, `(3,1)`, `(5,2)`, `(2,0)` are caught) | not located in the kernel; pinned in the conformance test |
| `WebOnt-I5.8-010` (entailment) | needs the value-space fact that `nonNegativeInteger ∩ nonPositiveInteger = {0}` | native wrong too |
| `Consistent-but-all-unsat`, `WebOnt-imports-011` (entailment) | kernel limit; imports | native wrong too |
| Integers beyond 64 bits | valid `xsd:integer`, not representable | reported by `lastLiteralIssues` |
| Ill-typed literals | dropped by the kernel | reported, or rejected with `"error"` |

Causes and fixes of every case that was ever wrong in this work: [solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md](solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md).

## Parity with native Konclude

The WebAssembly build is the vendored Konclude source with patches (`patches/`): Qt removal, a pthread-based threading layer, memory lifecycle fixes and correctness fixes. Where this branch differs from unmodified native Konclude 0.7.0 on the W3C suite it is **right and native is wrong** in the cases listed under Results (the kernel fixes of this adoption are patches to the vendored source, so they are candidates for upstream). On the performance fixtures the WebAssembly build is within about 5% to 8% of native on one pinned core (`docs/benchmark.md`).

The WebAssembly build needs native WebAssembly exception handling (Chrome 95+, Firefox 100+, Safari 15.2+, Node 17+), and 2 MiB stacks per thread (set in `emscripten.cmake`; the default of 64 KiB overflowed on deep nominal recursion).

## How the tests are organised

| What | File |
|---|---|
| W3C consistency cases by construct, with known gaps pinned | `tests/integration/w3c-conformance-pr18.test.ts` (manifest `tests/fixtures/w3c-pr18/manifest.json`) |
| Kernel fixes (datatype clashes, double free, shared blank nodes) | `tests/integration/pr18-kernel.test.ts` |
| Datatype value spaces, bounds, data cardinality, XML literals | `datatype-value-space`, `datatype-bounds`, `data-cardinality`, `xml-literal` |
| Realization of the normalized premises (stack size) | `tests/integration/realization-normalized.test.ts` |
| Entailment: hierarchy, `sameAs`, equivalence, range/domain, graph conclusions | `entailment-equivalence`, `entailment-range-domain`, `entailment-graph`, `entailmentGraph` (unit) |
| OWL 2 DL parity constructs | `tests/integration/owl2dl-parity.test.ts` and `tests/fixtures/owl2dl/` |
| SWRL | `swrl-fixpoint`, `swrl` (unit) |

## How to reproduce

```bash
npm run build && npx vitest run                 # everything, about 5 minutes
cd docs/experiments/pr18-reviewer-kit && npm install
node harness/w3c-conformance.mjs --reasoner ../../.. --set raw        # 266 consistency + 84 entailment tests, about 10 minutes
node harness/w3c-conformance.mjs --reasoner ../../.. --set normalized # 264 consistency tests
```

Compare the output with `results/w3c-raw.json` and `results/w3c-normalized.json` (the PR author's recorded run) per test: the harness prints a summary and the rows carry `consistencyCorrect` and `entailmentCorrect`.
