---
module: conformance
tags: [owl2dl, w3c-tests, datatypes, known-gaps, pr18]
problem_type: capability-gap
date: 2026-11-23
---

# Known W3C consistency gaps after PR #18

Source: the PR #18 reviewer kit verdict table (raw run, 266 W3C OWL 2 DL tests, 19 wrong before the unsatisfiable-individual check in `materialize()`). The nine unsatisfiable-individual cases (`description-logic-008, -012, -013, -015, -017, -612, -613, -615, -617`) are decided by that `materialize()` check and are not listed here.

`tests/integration/w3c-conformance-pr18.test.ts` pins these ten cases with their current wrong verdict (`known-gap` entries in `tests/fixtures/w3c-pr18/manifest.json`). Fixing one makes its test fail until the manifest entry is flipped to `pass`.

| Case | W3C expects | Port answers | Status / suspected cause |
|---|---|---|---|
| `Datatype-Float-Discrete-001` | inconsistent | inconsistent | **Fixed** (patch 002): `CDatatypeCompareValueSpaceMap::getNextPossibleDataValue` had an inverted test at the last map point (an empty interval looked satisfiable); parsing accepts subnormals; the single-node value search runs. |
| `Minus_Infinity_is_not_in_owl_real` | inconsistent | inconsistent | **Fixed** (patch 002): `excludeValue` compared the maximum in the wrong direction (typo `isGreaterThan`), so a negated literal inside an OR branch was dropped (real, compare and string value space maps). |
| `Plus_and_Minus_Zero_are_Distinct` | inconsistent | inconsistent | **Fixed** (patch 002): -0 orders before +0 in float and double values and value-space maps; float parsing uses strtod/strtof (accepts subnormals). |
| `one_two` | inconsistent | inconsistent | **Fixed** (patch 006): `mergeIndividualNodeInto` moved a neighbour's links to the merge target only for nominals, the parent and existing successors, so a blockable non-child neighbour kept its link on the old node and an inverse-functional rule at the target saw one link instead of two. One added clause (`!isIndividualAncestor`). |
| `New-Feature-Rational-003` | consistent | consistent | **Fixed** (2026-11-23, patch 002): three kernel changes for data cardinality over enumerated ranges (value exclusion across distinct nodes in `checkSatisfiability`, non-integer points in `CDatatypeRealValueSpaceMap::getNextPossibleDataValue`, data cardinality above 1 routed to the tableau). `tests/integration/data-cardinality.test.ts`. |
| `WebOnt-description-logic-035` | inconsistent | consistent | **Still open.** Both the saturation and the full tableau miss it (nominal `spy`, inverse role `invP` with `≤2`, a class with `≥3 r`; cardinality pairs `(3,2)`, `(4,2)`, `(4,3)` are missed, `(2,1)`, `(3,1)`, `(5,2)`, `(2,0)` are caught). A native null dereference on this case is guarded (patch 006). Not located. |
| `WebOnt-description-logic-105` | inconsistent | inconsistent | **Fixed** (patch 002): the saturation skipped the cardinality clash for nominal nodes, so the consistency step stopped early; the node is now marked insufficient and the full tableau runs. `-008`/`-012`/`-035` have another cause and stay open. |
| `WebOnt-description-logic-502` | inconsistent | inconsistent | **Fixed** in the input rewrite: one equivalent class per `owl:oneOf` constructor triple. |
| `WebOnt-miscellaneous-203` | inconsistent | inconsistent | **Fixed** (patch 002): the QDomDocument shim always failed, so every `rdf:XMLLiteral` was dropped; the lexical form is kept (equality by trimmed string, no well-formedness check). |
| `WebOnt-miscellaneous-204` | inconsistent | inconsistent | **Fixed**, same as `-203`. |

Cause-hunting order (from the plan `docs/plans/2026-11-23-001-fix-pr18-remaining-issues-plan.md`, Unit 7): mapper flags and the FP/IFP skip first, then lexical-form conversion in the Qt shim (`src/compat/QtCompat.h`: `toDouble`/`toFloat` wrap `std::stod`/`stof`, which accept a numeric prefix, unlike Qt), then kernel value-space semantics.

## Literal handling found while triaging (2026-11-23)

- **Fixed:** the minimum of `xsd:byte`, `xsd:short` and `xsd:int` was one too high upstream (`CDatatypeNormalizerPreProcess.cpp`: `-127`, `-32767`, `-2147483647`), so the valid minima were reported inconsistent (patch 002).
- **Open:** the kernel's `parseIntegerValue` / `parseDoubleValue` / `parseFloatValue` return null on a failed parse and the literal is dropped, so ill-typed literals and integers beyond 64 bits give a wrong "consistent". The shim's `QString::toDouble`/`toULongLong` accept a numeric prefix (`"5abc"` parses), unlike Qt, but Qt's strict failure would drop the literal too: the verdict does not change. Fix location: literal validation before the kernel, in `ts/inputNormalize.ts`. Pinned in `tests/integration/datatype-bounds.test.ts`.

## W3C entailment: 4 wrong, 20 unsupported, and why the rest is not being fixed now (2026-11-23)

Raw run: 84 entailment tests, port 60 correct / 4 wrong / 20 unsupported; native Konclude 0.7.0 59 / 9 / 16. The port is already ahead, so a general entailment push was put aside in the plan (Unit 6) in favour of soundness (false inconsistencies, kernel hangs) and the datatype-hierarchy conclusions below.

**4 wrong, native Konclude is wrong on all four:** `Consistent-but-all-unsat`, `Qualified-cardinality-boolean`, `WebOnt-I5.8-010` (nonNegative and nonPositive range force the value 0: value-space reasoning), `WebOnt-imports-011` (imports). Kernel or semantic limits, not port regressions.

**20 unsupported (`isEntailed` returns `null`, never a wrong yes/no).** The reviewer-kit harness builds refutation probes with ROBOT and, where that fails, falls back to `isEntailed` on named triples, which gives up when the conclusion has blank nodes or annotations. Groups:

| Group | Cases | Why not decided |
|---|---|---|
| Annotation conclusions | `WebOnt-AnnotationProperty-002`, `WebOnt-equivalentClass-008-Direct`, `WebOnt-sameAs-001`, `WebOnt-I4.6-005-Direct` | Not DL reasoning: the conclusion is an annotation triple. |
| Blank-node conclusions (existentials) | `somevaluesfrom2bnode`, `WebOnt-someValuesFrom-003`, `WebOnt-I5.26-009`, `-010`, `WebOnt-I5.5-005`, `WebOnt-I5.24-004`, `WebOnt-description-logic-901` | Needs a general probe for graphs with blank nodes (a feature, not a bug fix). |
| Datatype-hierarchy conclusions | `WebOnt-I5.8-006`, `-007`, `-008`, `-009` | `p range byte` therefore `p range short`: decidable by a range probe, **being implemented** (useful for users). |
| Property equivalence / characteristics | `WebOnt-equivalentProperty-003`, `-004`, `WebOnt-SymmetricProperty-002`, `WebOnt-TransitiveProperty-002` | The last two depend on the realization stall (Unit 8). |
| Other | `WebOnt-allValuesFrom-002` | Not yet analysed. |

**Update (2026-11-23):** after the range/domain, equivalence and graph-conclusion work the raw run is 68 correct, 3 wrong (`Consistent-but-all-unsat`, `WebOnt-I5.8-010`, `WebOnt-imports-011`; native Konclude is wrong on these too), 13 unsupported. `isEntailedGraph` decides existential conclusions with anonymous nodes and annotation triples; `description-logic-901` (anonymous classes on both sides of a subclass axiom) is not handled.

## Unsatisfiable-individual family and `miscellaneous-202` (2026-11-23)

- `WebOnt-description-logic-008`, `-012` and the family `-013`, `-015`, `-017`, `-612`, `-613`, `-615`, `-617`: **fixed in the kernel** (patch 002). The consistency step stopped early ("Trivial consistency detected") when the saturation approximation judged all assertion individuals sufficient. For `-008` the critical `≤1` cardinality of the shared filler was recorded under the role `r` but looked up under `concept->getRole()` (`invR`); the lookup now uses the loop's super role. For `-012` a representative successor at its limit is left out of the count on separated nodes; the node is now marked insufficient. Together with the `-105` fix (nominal clash) `checkConsistency` itself answers correctly. The TypeScript check in `materialize()` is kept as a stopgap but is probably redundant now. Test: `tests/integration/pr18-kernel.test.ts`.
- `WebOnt-miscellaneous-202`: two XML literals that are the same value in different spellings. Fixed by the canonicalizer (`ts/xmlLiteral.ts`); the store fast path in `ts/n3Inject.ts` needed its own trigger for XML literals. Test: `tests/integration/xml-literal.test.ts`.

## Realization stall: fixed (2026-11-23)

The stall on the ROBOT-normalized `SymmetricProperty-002` / `TransitiveProperty-002` premises was a **stack overflow**, not a deadlock. The backend-cache neighbour expansion for nominals with self loops recurses about 3,400 frames (natively it needs more than 256 KiB of stack: SIGSEGV at 64, 128 and 256 KiB, fine from 512 KiB). WebAssembly pthreads had the Emscripten default of 64 KiB and, with `ASSERTIONS=0` and no stack check, the overflow silently corrupted the heap and the pipeline stalled. Fix: `-sSTACK_SIZE=2097152 -sDEFAULT_PTHREAD_STACK_SIZE=2097152` in `emscripten.cmake` (about 40 MiB of the 1 GiB heap for ~20 threads). Both premises now complete in about 0.3 s. Test: `tests/integration/realization-normalized.test.ts`. Patches 005 and 002 only moved the stack requirement across the old limit, which explains the kit's bisect.
