# PR #18 handover: what the PR was, what we kept, what we added

Read this first. It compares the state of PR #18 (`dafcc7e`, "Datatype clashes, memory fixes, input rewrites, DL-safe SWRL and property entailment") with the state of branch `adopt/pr18-folded-patches`, which is built on top of it (every PR commit is an ancestor). Details live in the linked documents; this page is the map.

- [In one paragraph](#in-one-paragraph)
- [1. The PR as delivered](#1-the-pr-as-delivered)
- [2. What we verified and kept](#2-what-we-verified-and-kept)
- [3. What we added or fixed on top](#3-what-we-added-or-fixed-on-top)
- [4. Before and after in numbers](#4-before-and-after-in-numbers)
- [5. Behaviour changes users will notice](#5-behaviour-changes-users-will-notice)
- [6. Decisions for your review](#6-decisions-for-your-review)
- [7. Open items](#7-open-items)
- [8. How to verify](#8-how-to-verify)
- [9. Where everything is documented](#9-where-everything-is-documented)

## In one paragraph

The PR's kernel fixes are correct and are all kept; each was reproduced on `main` and verified. We folded the four vendor patches into the existing patch files, covered every claim with a test, reworked the SWRL fixpoint (7.8x slower than no rules became 2.5x), and then used the W3C OWL 2 test suite as a regression gate to close most of its remaining gaps: data cardinality, XML literals, float/double value spaces, nominal counting, the consistency saturation for the unsatisfiable-individual family, and the realization "stall" (a thread stack overflow, not a deadlock). W3C consistency went from 247 to 265 correct of 266. `isEntailed` gained `sameAs`, `equivalentProperty`, range/domain and the transitive hierarchy closure, and there is a new `isEntailedGraph`. New options are documented with their defaults; the one behaviour decision left to you is listed in [section 6](#6-decisions-for-your-review).

## 1. The PR as delivered

| Part | Content |
|---|---|
| Kernel (vendor C++, patches 006-009) | datatype concepts get their datatype operator at creation; a negated derived datatype does not close the whole value space; one shared Redland world; use-after-free in `buildComplexABoxAxioms` |
| `src/KoncludeReasoner.cpp`, `QtCompat.h` | data values follow data sub-properties; real date/time classes instead of stubs; shared Redland world |
| TypeScript | DL-safe SWRL in `materialize`; input rewrites (`ts/inputNormalize.ts`: negative property assertions, bottom data property, OWL 1 boolean constructors, disjoint data properties, `owl:hasKey`); `isEntailed` for property assertions, property characteristics, declarations; `weaken(alsoRemove)`; an unsatisfiable-class check after `materialize` |
| Claims | 410 unit tests pass; W3C OWL 2 DL: consistency correct on 247 of 264 (native Konclude 0.7.0: 240/241), entailment correct on 60 of 84, wrong on 4, unsupported on 20; six reference ontologies unchanged |
| Not included (stated by the PR) | float/double value counting, data cardinality over finite value spaces, two normalized files whose realization did not finish within 60 s |

## 2. What we verified and kept

| PR item | Result of our check | Evidence |
|---|---|---|
| Datatype clash and negated derived datatype | Confirmed: 5 of 10 small ontologies wrong on `main`, all right with the patches; the negated-datatype fix is needed (a build with only the first gives `-5` wrong) | `tests/integration/pr18-kernel.test.ts` |
| Shared Redland world | Confirmed: without it, a trap after consecutive loads once the datatype patches are in | same |
| Double free in `buildComplexABoxAxioms` | Confirmed: `main` crashes with `memory access out of bounds` on a blank-node class shared by 3+ individuals | same |
| Data sub-property values | Sound by review; 7 tests; the extra PMDco triples are confirmed by an independent entailment probe | `tests/integration/data-superproperty.test.ts` |
| Input rewrites | 19 W3C control cases pass; rewrites are deterministic (no spurious rebuilds) | `tests/integration/w3c-conformance-pr18.test.ts`, `input-normalize-determinism.test.ts` |
| Unsatisfiable-class check in `materialize` | Confirmed on the real W3C files; cost under 1% (0.7 ms PMDco, 35 ms LUBM-1). **Kept untouched on purpose**, see section 6 | decisions log D1 |
| SWRL | Correct, but 7.8x slower than a rule-free run: reworked, see section 3 | `tests/integration/swrl-fixpoint.test.ts` |

The four vendor patches are folded into `patches/002` and `004` (the vendor tree hash is identical to the sequential application; the originals are in `patches/archive/pr18-pre-fold/`).

## 3. What we added or fixed on top

### Kernel (vendor C++, all in `patches/002`, `004`, `006`; each fix found by tracing with graphify and gdb on the native test binary)

| Fix | W3C case(s) it closes | Cause |
|---|---|---|
| Signed integer minimums byte -128, short -32768, int -2147483648 | (valid minima gave a false inconsistent) | upstream bounds were one too high |
| Data cardinality over enumerated data ranges (3 changes) | `New-Feature-Rational-003` and the `{a}`, `{1,1}`, `{0.5,0.25}` family | value exclusion across distinct nodes, non-integer points in the real value space map, cardinality above 1 on data roles routed to the tableau |
| Nominal cardinality clash in the consistency saturation | `description-logic-105` | the clash was skipped for nominal nodes and the representative successor was left out of the count |
| Separated-node saturation (critical cardinality under the super role; representative successor at its limit) | `description-logic-008`, `-012` and the family `-013`, `-015`, `-017`, `-612` to `-617` | lookup under the wrong role key; successor left out of the count |
| `rdf:XMLLiteral` values | `miscellaneous-203`, `-204` (and `-202` with the canonicalizer) | the Qt `QDomDocument` shim always failed, so every XML literal was dropped |
| Float/double: -0 before +0, `strtod`/`strtof` parsing, inverted test at the last map point of `CDatatypeCompareValueSpaceMap::getNextPossibleDataValue` | `Plus_and_Minus_Zero_are_Distinct`, `Datatype-Float-Discrete-001` | IEEE `==` for -0, `std::stof` throws on subnormals, an inverted branch made empty intervals look satisfiable |
| `excludeValue` compared against the maximum in the wrong direction (real, compare, string value space maps) | `Minus_Infinity_is_not_in_owl_real` | typo (`isGreaterThan`): a negated literal inside an OR branch was dropped |
| Link moving on merge for non-child neighbours (patch 006) | `one_two` | links stayed on the old node, so an inverse-functional rule saw one link instead of two |
| Null guard on missing association data (two places) | native SIGSEGV on `SymmetricProperty-002` and `description-logic-035` | unchecked `nullptr` |
| Thread stacks 2 MiB (`emscripten.cmake`, not a vendor patch) | `SymmetricProperty-002`, `TransitiveProperty-002` "stall" | the 64 KiB default overflowed on the backend-cache nominal recursion (about 3,400 frames) and corrupted the heap silently |

### TypeScript and API

| Change | Where |
|---|---|
| SWRL: rule chains closed in TypeScript, semi-naive matching, kernel called only for new facts; opt-out `swrl: false`; `lastSwrl` | `ts/swrl.ts`, [swrl.md](swrl.md) |
| `closure: true` (opt-in): write the transitive hierarchy closure into the inferred graph | [options.md](options.md#hierarchy-closure) |
| `isEntailed`: hierarchy closure by reachability, `sameAs`, `equivalentProperty` (probe fallback), `rdfs:range`, `rdfs:domain` | `ts/index.ts`, [api.md](api.md#isentailedstore-axiom-quad-opts-promiseboolean--null-and-isentailedstore-axioms-quad-opts-promiseboolean--null) |
| `isEntailedGraph`: conclusions with blank nodes (existential trees) and annotation triples | `ts/entailmentGraph.ts` |
| `illTypedLiterals` (`report` default, `error`, `ignore`), `lastLiteralIssues`, `InvalidLiteralError` | `ts/literalValidation.ts` |
| Canonical form of `rdf:XMLLiteral` before the kernel; one rewritten class per OWL 1 constructor triple (fixes `description-logic-502`) | `ts/xmlLiteral.ts`, `ts/inputNormalize.ts` |

### Tests and documentation

18 new test files (kernel fixes, W3C conformance table, SWRL oracle, value spaces, entailment, closure, literals, XML, realization of the normalized premises) and fixtures under `tests/fixtures/pr18/` and `tests/fixtures/w3c-pr18/`. Documentation: this page, [api.md](api.md), [options.md](options.md), [swrl.md](swrl.md), [owl2-conformance.md](owl2-conformance.md), the decisions log, the known-gaps note and the release-notes draft.

## 4. Before and after in numbers

| Measure | PR #18 as delivered | This branch |
|---|---|---|
| W3C consistency, raw set (266 tests) | 247 correct | **265 correct** (only `description-logic-035` wrong) |
| W3C consistency, normalized set (264 tests) | 247 correct | **263 correct** (only `description-logic-035` wrong) |
| W3C entailment (84 tests) | 60 correct, 4 wrong, 20 unsupported | **68 correct, 3 wrong, 13 unsupported** |
| Native Konclude 0.7.0 for reference | consistency 241, entailment 59 correct / 9 wrong / 16 unsupported | |
| Realization of the two normalized premises | never returns | about 0.3 s each |
| `materialize` with 2 chained SWRL rules, 4,863 derived triples | 7 kernel rounds, 4755 ms (7.8x a rule-free run) | 2 rounds, 1417 ms (2.5x) |
| Speed on fixtures (this machine) | pizza 485 ms, LUBM-schema 495 ms, PMDco 3.07 s | pizza 484 ms, LUBM-schema 483 ms, PMDco 3.11 s (within noise; `main`: 465, 485, 2.99 s) |
| Output of the reference ontologies | | LUBM-1 71,025 inferred triples, GALEN 1,386, PMDco 152 (same counts as the PR) |
| Test suite | 498 tests in the unit and parity files; the PR reported 410 unit tests | 992 passed, 9 skipped in 97 files |
| Known gaps pinned as tests | none | one W3C consistency case (`description-logic-035`) and the entailment cases, each with its cause |

The consistency cases that changed from wrong to right on top of the PR: `Rational-003`, `Plus_and_Minus_Zero_are_Distinct`, `Datatype-Float-Discrete-001`, `Minus_Infinity_is_not_in_owl_real`, `one_two`, `description-logic-008/-012/-013/-015/-017/-105/-502/-612/-613/-615/-617`, `miscellaneous-203/-204`. No consistency or entailment case that was correct in the recorded PR run became wrong (the one regression we introduced, `miscellaneous-202`, was fixed in the same round).

## 5. Behaviour changes users will notice

| Change | Before | Now |
|---|---|---|
| `isEntailed` for `owl:sameAs`, `owl:equivalentProperty`, `rdfs:range`, `rdfs:domain` | `null` | a definite `true` or `false` |
| `isEntailed(A ⊑ C)` for a chain, `A ⊑ A`, `A ⊑ B` with `A ≡ B` | `false` | `true` |
| `checkConsistency` for ontologies with an individual in an unsatisfiable class (`description-logic-008` family) | consistent | inconsistent (kernel fix; `materialize` keeps its check) |
| Valid ontologies with `byte -128`, `short -32768`, `int -2147483648` | inconsistent | consistent |
| Ontologies with an XML literal | the literal was dropped | the value takes part (functional properties can clash) |
| Ill-typed numeric literals | silently dropped | still not rejected by default, but listed in `lastLiteralIssues` |
| New opt-in | | `closure: true` |
| New opt-out | | `swrl: false` (SWRL stays on by default as in the PR) |

## 6. Decisions for your review

Full table with reasoning: [pr18-adoption-decisions.md](pr18-adoption-decisions.md). The ones to look at:

1. **`illTypedLiterals` default is `"report"`** (decided): keep loads working on sloppy data; strict users set `"error"`.
2. **SWRL on by default, `swrl: false` to opt out** (decided, as in the PR).
3. **The unsatisfiable-individual check in `materialize()` is kept** although the kernel now catches the whole family itself. It can be retired once the app flow (consistency, then materialize) is confirmed on real data; the kernel route is the intended end state.
4. **Version number and release grouping** are open. The additions are new options and fixes; the visible behaviour change is `isEntailed` returning definite answers where it returned `null`.

## 7. Open items

| Item | State |
|---|---|
| `description-logic-035` (nominal, inverse role, cardinalities `(3,2)`, `(4,2)`, `(4,3)`) | wrong in the kernel (saturation and full tableau); not located; documented and pinned |
| Entailment: `Consistent-but-all-unsat`, `I5.8-010`, `imports-011` wrong; 13 cases unsupported | kernel or harness limits (native is wrong on the first three too); the unsupported ones are annotation or blank-node conclusions, now handled by `isEntailedGraph` for existential trees and annotations; `description-logic-901` needs anonymous classes on both sides of a subclass axiom |
| Ill-typed literals | reported, not rejected (decision 1) |
| Built-in atoms for SWRL, explanations that include rule consequences | not supported; listed in [swrl.md](swrl.md#follow-ups) |
| Benchmark | `node --expose-gc tests/bench/bench.mjs --quick --wasm-only` (2026-11-23, load average 8.3 at start): LUBM schema 283 ms (recorded 261), GALEN 1134 ms (recorded 1126), TS layer 439 ms and 1720 ms (recorded 415 and 1649); inferred counts equal (44, 3,287). Within the spread of a loaded host. The native and HermiT comparison needs the Docker images (removed in the disk cleanup) and the full `npm run bench` has not been run |
| Browser tests (`npm run test:browser`), lint (`trunk`) | not run in this work |
| Version | `package.json` and `package-lock.json` are 0.9.7; not published |

## 8. How to verify

```bash
npm run build && npx vitest run     # full suite (about 5 minutes); 992 tests pass, 9 skipped
node tests/bench/swrl-bench.mjs --materials 300 --runs 3          # SWRL cost, add --nofire for rules that never match
node tests/bench/simple-run.mjs "$PWD" tests/fixtures/pmdco.nt materialize   # one fixture, one fresh process
```

W3C consistency end to end uses the reviewer kit (`docs/experiments/pr18-reviewer-kit/`, not committed): `node harness/w3c-conformance.mjs --reasoner <repo> --set raw` (and `--set normalized`). The cases that matter for regressions are copied as small N-Triples fixtures into `tests/fixtures/w3c-pr18/` and run by `tests/integration/w3c-conformance-pr18.test.ts`.

Kernel work follows the patch workflow in `CLAUDE.md`: graphify first, patches through `scripts/new-multi-file-patch.sh`, `make reset-patches` before a rebuild. The native test binary (`build-native-ordered/konclude_repro`) is the fastest way to reproduce a kernel question.

## 9. Where everything is documented

| Document | Content |
|---|---|
| [api.md](api.md) | every method, property, error and constant |
| [options.md](options.md) | every option with default, cost and when to change it; opt-in and opt-out lists |
| [swrl.md](swrl.md) | SWRL scope, semantics, limits, cost |
| [owl2-conformance.md](owl2-conformance.md) | OWL 2 DL parity: method, results, supported features, known gaps |
| [pr18-adoption-decisions.md](pr18-adoption-decisions.md) | each decision with reasoning and evidence |
| [release-notes-v0.9.7.md](release-notes-v0.9.7.md) | release notes draft |
| [solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md](solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md) | cause of every W3C gap, fixed and open |
| [solutions/architecture-patterns/swrl-fixpoint-ts-closure-2026-11-23.md](solutions/architecture-patterns/swrl-fixpoint-ts-closure-2026-11-23.md) | SWRL design and measurements |
| [../patches/README.md](../patches/README.md) | what each vendor patch contains; archive of the originals |
