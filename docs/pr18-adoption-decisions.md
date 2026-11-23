# PR #18 adoption: decisions and evidence (for the PR note)

Branch `adopt/pr18-folded-patches` is built on the head of PR #18 (`dafcc7e`, every PR commit is an ancestor). This file lists every decision taken while checking and extending the PR, with the evidence, so the author can follow what changed and why. Numbers come from this machine (Node 25, WASM build from the folded patches); absolute times differ from the author's kit, ratios match.

## 1. What was verified as correct and kept

| Item | Evidence | Decision |
|---|---|---|
| Datatype clash between value spaces (patch 006 of the PR) | 5 of 10 small ontologies wrong on `main`, all right on the PR build (`tests/integration/pr18-kernel.test.ts`) | Keep |
| Negated derived datatype keeps the value space (PR patch 007) | A build with only 006 gets `not xsd:positiveInteger` with `-5` wrong; with 007 right | Keep |
| One shared Redland world (PR patch 008) | Without it a trap after consecutive loads once 006/007 are in (`table index out of bounds`) | Keep |
| Double free in `buildComplexABoxAxioms` (PR patch 009) | `main` and builds without 009 crash on a blank-node class shared by 3+ individuals (`memory access out of bounds`) | Keep |
| Data super-property values (`hasAge ⊑ hasNumber`) | Code review plus 7 soundness tests; the extra PMDco triples are confirmed by an independent refutation probe (`tests/integration/data-superproperty.test.ts`) | Keep; documented limit: values from `hasValue` on inferred types stay implicit |
| Input rewrites (`ts/inputNormalize.ts`) | 19 W3C control cases pass; rewrites are deterministic across verbs (generation does not move) | Keep |
| Vendor patches 006-009 as separate files | Folded into 002 (datatype fixes, signed minimums) and 004 (Redland world, double free); vendor tree hash identical to sequential application | Folded; originals in `patches/archive/pr18-pre-fold/` |

## 2. Decisions that change or extend the PR

| # | Decision | Why | Where |
|---|---|---|---|
| D1 | **The `getUnsatisfiableClassBuffer` check in `materialize()` stays as is.** | Real W3C files (`description-logic-008/-012`) show it catches individuals the kernel's consistency step misses; cost under 1% (0.7 ms PMDco, 35 ms LUBM-1). A kernel fix would need a classification (about 4 s on PMDco) in every consistency check. My hand-built reconstruction of -008 had suggested the check was ineffective; that was my error, not the PR's. | `ts/index.ts` (unchanged) |
| D2 | **SWRL rules are applied by default, `materialize(store, { swrl: false })` opts out.** `lastSwrl` reports `{ rules, unsupported, rounds, derived, applied }`; with the option off it still lists the rules found. | Keeps the PR's behaviour. Detection is free: a store without `swrl:Imp` pays nothing, rules that never match cost 1.0x. | `ts/types.ts`, `ts/index.ts` |
| D3 | **SWRL fixpoint reworked, not moved into the kernel.** Rule chains are closed in TypeScript (semi-naive matching); the kernel is called only when new facts appeared. | 300-material benchmark, 4,863 derived triples: 7 kernel rounds became 2, 4755 ms became 1417 ms (7.8x became 2.5x over the rule-free run). The remaining overhead is one kernel round (realization of a larger ABox); a kernel-native rule engine would still do that work, and would need deadlock-prone threading changes. Revisit only if a real ontology with many derived triples shows that round dominating. | `ts/swrl.ts`, `ts/index.ts`, `tests/bench/swrl-bench.mjs` |
| D4 | **`isEntailed` answers hierarchy questions by reachability over the classifier's reduced taxonomy** (base and inferred graph). Nothing is written to the store. | The classifiers write only direct edges, so `A ⊑ B ⊑ C` asked as `A ⊑ C`, `A ⊑ A`, `A ⊑ Thing` and `A ⊑ B` for `A ≡ B` were wrongly `false`. This is the transitive-reflexive closure of subsumption under the OWL 2 direct semantics: open world, adds nothing the classification did not entail. `false` means not entailed, not refuted. | `ts/index.ts` |
| D5 | **`isEntailed` decides `owl:sameAs`, `owl:equivalentProperty`, `rdfs:range` and `rdfs:domain`.** | `sameAs` and `equivalentProperty` always returned `null`. Range/domain are decided by refutation probes (datatype hierarchy: `p range byte` entails `p range short`), `null` on an inconsistent ontology. Tests that pinned `sameAs` as unsupported now assert the decided answers. | `ts/index.ts`, `ts/entailmentProbe.ts` |
| D6 | **`closure: true` (opt-in) writes the transitive hierarchy closure to the inferred graph** for `classify`, `classifyProperties` and `materialize` with `includeClassHierarchy`. Default stays the reduced hierarchy. | Consumers of the graph (SPARQL, SHACL, the app) need every entailed subsumption as a triple. Size is about 6-9x the direct edges (PMDco 1,612 to 10,572 pairs; GALEN 3,382 to 30,795), computing takes milliseconds. Opt-in so existing output does not change. | `ts/index.ts`, `ts/types.ts` |
| D7 | **Signed integer minimums fixed (patch 002).** byte -128, short -32768, int -2147483648. | Upstream Konclude had -127, -32767, -2147483647, so the valid minima made an ontology inconsistent. | `patches/002-...`, `tests/integration/datatype-bounds.test.ts` |
| D8 | **Entailment conformance work was narrowed.** 4 wrong and 20 unsupported W3C entailment tests: not pursued as a general feature. | Native Konclude is wrong on all four; most unsupported cases are harness limits (blank-node or annotation conclusions that ROBOT could not turn into probes), and `isEntailed` returns `null` there, never a wrong answer. Port 60 correct / 4 wrong / 20 unsupported against native 59 / 9 / 16. The datatype-hierarchy conclusions, which users need, were implemented (D5). Details: `docs/solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md`. | docs |

## 3. Findings that are not fixed (and why)

| Finding | Status |
|---|---|
| Ill-typed literals (`"5abc"^^xsd:integer`, `"1.5"^^xsd:integer`, hex floats, `"abc"^^xsd:float`) and integers beyond 64 bits are silently dropped by the kernel's literal parsers, giving a wrong "consistent". The Qt shim's `toDouble`/`toULongLong` accept a numeric prefix unlike Qt, but Qt's strict failure would drop the literal as well, so the verdict is the same. | Pinned in `tests/integration/datatype-bounds.test.ts` (9 known-gap cases). Fix location: literal validation before the kernel (`ts/inputNormalize.ts`). Policy open, see the plan. |
| 10 W3C consistency verdicts wrong (float/double value spaces, `owl:rational`, `description-logic-035/-105` where native Konclude is wrong too, `-502`, `miscellaneous-203/-204`) | Pinned in `tests/integration/w3c-conformance-pr18.test.ts`; table in the known-gaps note |
| Realization deadlock for two ROBOT-normalized premises (`SymmetricProperty-002`, `TransitiveProperty-002`) | See section 4 |

## 4. Open at the time of writing

Updated at the end of the work; see the git log of this file.

## 5. Reproducing

- Tests: `npx vitest run` (full suite, about 4 minutes). New files: `pr18-kernel`, `w3c-conformance-pr18`, `swrl-fixpoint`, `data-superproperty`, `input-normalize-determinism`, `datatype-bounds`, `entailment-range-domain`, `entailment-equivalence`, `hierarchy-closure`.
- SWRL benchmark: `node tests/bench/swrl-bench.mjs --materials 300 --runs 3` (`--nofire` for rules that never match).
- The author's reviewer kit (`docs/experiments/pr18-reviewer-kit/`, 43 MB) is not committed; the W3C cases used are copied as small N-Triples fixtures in `tests/fixtures/w3c-pr18/` and `tests/fixtures/pr18/`.
