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
| `Datatype-Float-Discrete-001` | inconsistent | consistent | Float/double value counting is not done (excluded from PR #18). Kernel work. |
| `Minus_Infinity_is_not_in_owl_real` | inconsistent | consistent | To diagnose: lexical conversion (`INF`/`-INF`) vs. value-space semantics. |
| `Plus_and_Minus_Zero_are_Distinct` | inconsistent | consistent | To diagnose: +0/-0 comparison in the double value space. |
| `one_two` | inconsistent | consistent | To diagnose (float/double family). |
| `New-Feature-Rational-003` | consistent | **inconsistent** | False inconsistency. Not rational parsing: any `owl:oneOf` of two distinct non-integer values with `minCardinality 2` (`{0.5, 0.25}`, `{1/3, 2/3}`, `{1.5, 2.5}`) is reported inconsistent, while integer and string enumerations work; and `{a}` / `{1, 1}` with `minCardinality 2` are wrongly consistent. This is the data cardinality over finite value spaces gap (kernel value counting, `CDatatypeIndividualProcessNodeHandler`), excluded by PR #18. Pinned in `tests/integration/data-cardinality-gaps.test.ts`. |
| `WebOnt-description-logic-035` | inconsistent | consistent | Kernel judges the class satisfiable although its definition is contradictory; native Konclude 0.7.0 agrees. Kernel limitation. |
| `WebOnt-description-logic-105` | inconsistent | consistent | Same as -035. |
| `WebOnt-description-logic-502` | inconsistent | inconsistent | **Fixed** (2026-11-23): a class with several `owl:oneOf` lists got all of them merged into one rewritten class, so the kernel read one list. Each constructor triple now becomes its own equivalent class (intersection semantics). |
| `WebOnt-miscellaneous-203` | inconsistent | consistent | XML literals; absent from the normalized set. |
| `WebOnt-miscellaneous-204` | inconsistent | consistent | To diagnose. |

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
