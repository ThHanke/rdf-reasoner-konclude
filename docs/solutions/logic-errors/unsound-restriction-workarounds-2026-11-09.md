---
title: Unsound restriction post-processing in buildInferredTripleBuffer and the explanation code
date: 2026-11-09
module: src/KoncludeReasoner.cpp, ts/index.ts
problem_type: logic-error
tags: [soundness, someValuesFrom, hasSelf, minCardinality, fp-ifp-skip, workarounds, explain]
status: P0-1/2/3 + minCardinality fixed 2026-11-09; P0-4 (FP/IFP skip) open
---

# Unsound restriction workarounds (coworker report, 2026-11-07)

Source: `ONTOSPHERE_FIX_LIST.md` (Ontosphere revision-2 evaluation: port vs HermiT / native Konclude). This note records what was reproduced in this repo on 2026-11-09 (branch `feat/repair-weakening-assessment`, package 0.9.0, same code as 0.7.2 and 0.8.0 for these paths). Repro inputs: `tests/fixtures/soundness/*.ttl`; run `node dist/cli.js -i F.ttl -m materialize -o out.nt` (output holds only new entailments).

## Root cause: wrong parity expectation

`docs/solutions/capability-gaps/parity-gap-native-investigation-2026-06-03.md` (R5) expected `rex rdf:type Dog` from `alice : PetOwner`, `PetOwner ≡ ∃hasAnimal.Dog`, `hasAnimal(alice, rex)`. That is not entailed (alice may have another dog). Native Konclude correctly did not emit it; the investigation called that a native bug and prescribed "post-process: emit the filler type". plan-047 then moved the rule into C++ ("Unit 2"), and tests/docs recorded it as expected behaviour: `tests/integration/owl2dl-parity.test.ts` ("alice:PetOwner, alice hasAnimal rex → rex rdf:type Dog"), `tests/integration/entailment-coverage.test.ts` ("rex rdf:type Dog via PetOwner ≡ ∃hasAnimal.Dog (entailed)"), README entailment table. Those expectations are wrong and must change with the fix.

## Findings (reproduced on the current build)

| Case | Input | Port emits | Correct |
| --- | --- | --- | --- |
| `svf_fwd_sub` | `A ⊑ ∃p.B`, `a:A`, `p(a,c)` | `c : B` | nothing — **unsound (P0-1)** |
| `svf_fwd_eq` | `A ≡ ∃p.B`, `a:A`, `p(a,c)` | `c : B` | nothing — **unsound (P0-1)** |
| `svf_bwd_eq` | `A ≡ ∃p.B`, `p(a,c)`, `c:B` | `a : A` | `a : A` ok |
| `svf_bwd_sub` | `A ⊑ ∃p.B`, `p(a,c)`, `c:B` | nothing | nothing ok |
| `self_bwd_sub` | `A ⊑ ∃p.Self`, `p(a,a)` | `a : A` | nothing — **unsound (P0-2)** |
| `self_bwd_eq` | `A ≡ ∃p.Self`, `p(a,a)` | `a : A` | `a : A` ok |
| `hv_bwd_sub` / `hv_bwd_eq` | `A ⊑/≡ ∃p.{c}`, `p(a,c)` | nothing / `a : A` | nothing / `a : A` ok |
| `mincard_sub` | `A ⊑ ≥2 p`, `p(a,c1)`, `p(a,c2)`, `c1≠c2` | `a : A` | nothing — **unsound, NOT in the report** |
| `mincard_eq` | `A ≡ ≥2 p`, same | `a : A` | `a : A` ok |
| `fp_multi` | `p` functional, `p(a,c1)`, `p(a,c2)`, `c1:B`, `B ⊑ D`, `E ≡ ∃q.B`, `q(z,c2)` | `c1:D`, `c1 sameAs c2` | also `c2:B`, `c2:D`, `z:E` — **incomplete (P0-4 mechanism)** |

## Per item

- **P0-1 confirmed.** `mSvfIndex` is filled for both `rdfs:subClassOf` and `owl:equivalentClass` restriction links (`src/KoncludeReasoner.cpp`, "Unit 2: build mSvfIndex", ≈ l.1819-1853) and the fixpoint in `buildInferredTripleBuffer` ("Unit 2: someValuesFrom fixpoint", ≈ l.3426-3470) emits `y : F` for `x : C`, `p(x,y)`. Invalid for both ⊑ and ≡. Delete the fixpoint together with `mSvfIndex`, `mSvfRoleAssertions`, `mSvfABoxTypes` (only used there). Backward direction (`p(x,y)`, `y:F` → `x:C` for ≡) is already done by Konclude.
- **P0-2 confirmed, wider than reported.** `classToRestr` (≈ l.1411) takes `eqCIdx` and `scIdx` links alike. Wrong for subClassOf: hasSelf (emits the type via `mHasSelfTypes`, ≈ l.1469), hasValue-backward (justification only), svf-backward (justification only), and **minCardinality (Unit 5, ≈ l.1950, `isSub` accepted; emits the type)**. The allValuesFrom branch is valid for both (`C ⊑ ∀p.F` is all that is used). Fix: carry a flag "from equivalentClass" and gate hasSelf, hasValue-backward, svf-backward and minCardinality on it; the intersectionOf and oneOf rules attach to the class node itself (an equivalence in RDF), so they are fine.
- **P0-3 confirmed.** `ts/index.ts` `_synthesizeRestrictionJustification` ("Reverse someValuesFrom", l.1469-1489, covers ⊑ and ≡) and `explainEntailment` ("Reverse someValuesFrom filler typing", l.2606-2624) return `[p(x,y), x:C, C ≡ ∃p.F]` as justification for `y : F`. The second one even answers `isEntailed: true`. Remove both blocks.
- **P0-4 mechanism confirmed.** "Unit 1" (`forRealization` only, ≈ l.1186-1270 and the skip at ≈ l.1627) removes `FunctionalProperty` / `InverseFunctionalProperty` declarations for any property with two fillers on one subject (object) in the ABox and emits `sameAs` pairs instead. The kernel never sees the characteristic, so nothing propagates through the merged individuals (`fp_multi`: `c2:B`, `c2:D`, `z:E` lost). Not yet shown for the TQC pattern (we do not have its input); to test, disable the skip in the native build (`build-native/konclude_repro`, only `KoncludeReasoner.cpp` changes) and see whether the original ALIF+ hang returns. Whatever remains skipped must be reported to the caller (`skippedAxioms`) and not dropped silently.
- **P0-5 not reproducible here.** The "exact check" with the 120 s limit lives in Ontosphere (`rdfManager.runtime.ts`). The library part is `explain()` (BlackBox, no module extraction): one trivial entailed subsumption on `tests/fixtures/pmdco.nt` takes 4.7 s. Needs the Fe-Si and steel/TQC inputs to say more; locality-module extraction would be new work in the library.
- **P0-6 library behaves correctly.** The stall is detected and reported (`ReasonerStalledError`, CLI exit 2 after the 600 s `stallTimeoutMs`, one restart-and-retry included). Swallowing it and returning `success: true` is Ontosphere code.
- **P2-2 count drift is real on this side.** On `tests/fixtures/pmdco.nt` classify gives 153 inferred triples with 0.7.2 and 136 with 0.9.0 (`galen.nt`: 1386 both, `lubm.nt`: 11 both, so GALEN's 1389 vs 1386 comes from the evaluation harness, not from the library). 15 of the 17 removed PMDco edges are transitively redundant (0.7.2 emitted non-Hasse edges); 2 (`PMD_0020243 ⊑ PMD_0023003`, `PMD_0080022 ⊑ PMD_0023003`) are not derivable from the other edges and `isEntailed` says false in 0.9.0. They need a HermiT check. Pizza is not in the repo (`tests/fixtures/pizza.nt` is a 2 KB toy).

## Not in this repo

P1-1..P1-7, P2-1, P2-3..P2-6 and the app side of P0-5/P0-6 are Ontosphere. P1-4 (lost literals) and P1-6 (blank nodes, skolem IRIs `urn:vg:bnode:*`) may touch the library's term interning; not examined.

## Suggested order

1. Add tests (`tests/fixtures/soundness`, expected values above) and fix the expectations in `owl2dl-parity` / `entailment-coverage`.
2. Delete the Unit 2 fixpoint and the two TS reverse-svf blocks; gate hasSelf / hasValue-backward / svf-backward / minCardinality on equivalentClass.
3. Experiment: disable the FP/IFP skip natively; if the hang is gone, remove it, otherwise report `skippedAxioms` and keep types through sameAs.
4. Rebuild WASM (+ `patch-wasm`), run vitest and the browser specs, re-run the coworker's `check_port_soundness.py` and `compare_port_hermit.py`; note the output change (fewer unsound types) in the release notes.

## Status after the fix (2026-11-09)

Fixed (WASM rebuilt with patches 000-008): the someValuesFrom fixpoint (`mSvfIndex` and its three collections) is gone; hasSelf, hasValue-backward, someValuesFrom-backward and minCardinality take effect only for `owl:equivalentClass`; the two reverse-someValuesFrom blocks in `ts/index.ts` are removed. All 16 cases in `tests/fixtures/soundness/` are checked by `owl2dl-parity.test.ts`; the wrong `rex : Dog` expectations in it and in `entailment-coverage.test.ts` are corrected.

Upstream check (pristine `konclude/konclude` image v0.7.0-1138, `realization`, RDF/XML of the fixtures):
- `svf_fwd_sub`: finishes in 1 s and derives only `a : A` — `c : B` is not derived. The old rule was unsound against the real binary, not only against HermiT.
- `svf_fwd_functional` and `fp_multi`: **upstream hangs in "Precomputing ontology … expressiveness 'SIF'"** on 7 axioms (no result in 271 s; killed). This is the ALIF+ hang the FP/IFP skip (Unit 1) works around, and it means those two inputs cannot be used as an upstream parity oracle.

P0-4 (FP/IFP skip) stays open and cannot be closed by simply removing the skip:
- With the patched kernel natively (`build-native/konclude_repro --seq m:file`) both inputs finish in about 20 ms, with and without the skip (`KON_NO_FPIFP_SKIP=1`, debug switch in `KoncludeReasoner.cpp`), so the patched kernel does not show the hang on these tiny inputs. The harness does not print ABox types for them, though, so completeness (`c2:B`, `c2:D`, `z:E` for `fp_multi`) was not verified there, and WASM does not appear to see the environment variable.
- The two tests that need this are therefore written as "sound subset" checks (`svf_fwd_functional`, `fp_multi` in `incompleteCases`); the missing entailments are listed in the test. To close it: expose the switch as a real option (or rebuild WASM with the default flipped), run `fp_multi` and the Roberts/PMDco hang inputs, and decide between removing the skip, narrowing it, or reporting `skippedAxioms` to the caller.

## Separate finding: PMDco classification lost two direct edges between 0.7.2 and 0.8.0 (2026-11-09)

Reference: upstream Konclude's own classification of PMDco, `tests/fixtures/pmdco-native-class.owl.xml` (1,570 named direct `SubClassOf` edges besides `owl:Thing`). Result of `classify()` on `tests/fixtures/pmdco.nt`, asserted plus inferred edges against that reference:

| Version | native edges missing | inferred edges not in native | determinism (3 fresh processes) |
| --- | --- | --- | --- |
| 0.7.2 | 0 | 38 | 3 different sets (166 / 157 / 152 edges) |
| 0.8.0 (npm), HEAD wasm, current wasm | **2** | 23 | one set (136 edges) |

The two missing edges are `PMD_0020243 ⊑ PMD_0023003` and `PMD_0080022 ⊑ PMD_0023003`. Upstream lists them as direct superclasses; 0.9.0 does not entail them (`isEntailed` false, the raw kernel buffer before any TypeScript filtering lacks them, the input has no triple between the two classes). It is therefore a kernel classification gap introduced between 0.7.2 and the published 0.8.0 (the patch aggregation 000-004 / 0.8.0 kernel changes; patches 005-008 are not involved since the published 0.8.0 already lacks the edges). 0.7.2 emitted extra redundant edges non-deterministically, 0.8.0 made it deterministic and 15 of the 17 edges that disappeared were redundant, but these two were not.

Likely the same cause as the coworker's P0-4 (missing types for `PMD_0023002` / `PMD_0023003` in the TQC pattern): the missing superclass is the same class. The FP/IFP skip is not the cause (classify does not use it; removing disjointness, functional, inverse, domain, range, subPropertyOf or characteristic axioms one category at a time does not bring the edges back; the branch's disjointness work post-dates 0.8.0).

Not solved: no minimal justification. `PMD_0020243 ⊑ (PMD_0050051 ⊓ ∃RO_0000080.(…))` carries the derivation (RO_0000080 is functional with an inverse and a domain axiom), but 0.7.2's own `explain` did not finish in 15 minutes, and hop-limited modules of up to 589 triples (subject references only) do not derive the edge in either version. Next steps: bisect by patch (000-004 individually) with a WASM or native build, or obtain the coworker's TQC inputs and Konclude's justification from a debug build. A test comparing `classify` on `pmdco.nt` with `pmdco-native-class.owl.xml` is missing and should be added once fixed.
