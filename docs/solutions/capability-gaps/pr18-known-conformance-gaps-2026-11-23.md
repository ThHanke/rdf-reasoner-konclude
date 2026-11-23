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
| `New-Feature-Rational-003` | consistent | **inconsistent** | False inconsistency. `owl:rational` handling; highest priority (soundness). |
| `WebOnt-description-logic-035` | inconsistent | consistent | Kernel judges the class satisfiable although its definition is contradictory; native Konclude 0.7.0 agrees. Kernel limitation. |
| `WebOnt-description-logic-105` | inconsistent | consistent | Same as -035. |
| `WebOnt-description-logic-502` | inconsistent | consistent | Raw input wrong, ROBOT-normalized input right: input-format difference to find. |
| `WebOnt-miscellaneous-203` | inconsistent | consistent | XML literals; absent from the normalized set. |
| `WebOnt-miscellaneous-204` | inconsistent | consistent | To diagnose. |

Cause-hunting order (from the plan `docs/plans/2026-11-23-001-fix-pr18-remaining-issues-plan.md`, Unit 7): mapper flags and the FP/IFP skip first, then lexical-form conversion in the Qt shim (`src/compat/QtCompat.h`: `toDouble`/`toFloat` wrap `std::stod`/`stof`, which accept a numeric prefix, unlike Qt), then kernel value-space semantics.

## Literal handling found while triaging (2026-11-23)

- **Fixed:** the minimum of `xsd:byte`, `xsd:short` and `xsd:int` was one too high upstream (`CDatatypeNormalizerPreProcess.cpp`: `-127`, `-32767`, `-2147483647`), so the valid minima were reported inconsistent (patch 002).
- **Open:** the kernel's `parseIntegerValue` / `parseDoubleValue` / `parseFloatValue` return null on a failed parse and the literal is dropped, so ill-typed literals and integers beyond 64 bits give a wrong "consistent". The shim's `QString::toDouble`/`toULongLong` accept a numeric prefix (`"5abc"` parses), unlike Qt, but Qt's strict failure would drop the literal too: the verdict does not change. Fix location: literal validation before the kernel, in `ts/inputNormalize.ts`. Pinned in `tests/integration/datatype-bounds.test.ts`.
