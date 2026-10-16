# Benchmark

`npm run bench` (full, ~30 min, needs Docker for native Konclude and HermiT) or `npm run bench:quick` (LUBM schema + GALEN, 3 runs, ~5 min). Output is Markdown; `docs/benchmark.md` is a saved full run.

Options: `--quick`, `--case "<name>"` (one case; names in `cases.mjs`). The run waits up to 5 minutes for a quiet host (1-minute load average < 3.5) before measuring.

## What is measured

| Number | Boundary |
|---|---|
| WASM ingest→result | encode + `syncTripleBuffer()` + reasoning (incl. lazy parse/mapping) + output decode. Module start (`init`) is one-off and excluded. |
| Konclude total | Konclude's own "Total processing time" in the container: OWL/XML parse + reasoning + result serialisation. Container start excluded. |
| Konclude realization + role instances | ABox cases: the unmodified Konclude image run with `-c` config `Konclude.Calculation.Realization.RealizePrecomputation.RoleInstances=true` (default false), which makes `realization` run the bulk role-realization step that WASM `realization()` always runs; its own "Total processing time". Output still lists class assertions only. |
| TS layer total | one full public `RdfReasoner` call in a fresh process, including Worker and module start. |
| warm scenarios | one reasoner: unchanged content, identical content in a new Store, one added axiom. Kernel counters (`syncStats`) are asserted for each. |

Ratios are only formed for ingest→result vs Konclude total (TBox), vs Konclude excl. realization (ABox classification path), and full realization vs Konclude with `RoleInstances=true`. Phase columns are a breakdown: v0.8.0 moved parse/mapping from "load" into "reasoning" (see `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md`), so phases are not comparable across releases.

Cells show `median [min–max]`; `†` = spread above 10%, `‡` = fewer than 5 samples. Run counts and subprocess budgets per case live in `cases.mjs` (slow cases: 3 runs, no warm-up).

## Files

- `bench.mjs` orchestrator and report; `meta.mjs` run metadata; `stats.mjs` summaries; `cases.mjs` budgets.
- Runners: `wasm-runner.mjs` (direct Embind), `ts-runner.mjs` (RdfReasoner + warm scenarios), `native-runner.mjs` (Docker Konclude), `robot-runner.mjs` (HermiT), `binary-runner.mjs` (encoding micro-benchmark).
- `equivalence.mjs` compares role assertions modulo equivalent/inverse roles declared in the input (Konclude picks one representative per equivalence class; the choice differs between builds).
- TS-layer runner (`ts-runner.mjs`): **one fresh process, one fresh `RdfReasoner`, one call per measurement** (`simple-run.mjs`; `simple-warm.mjs` for the warm scenarios). Several reasoners created and terminated inside one Node process produced intermittent 4–5× slow kernel runs on Roberts (`docs/solutions/performance-issues/ts-runner-in-process-slow-runs-2026-10.md`), so in-process repetition is not used.
- Stability across many changed-content calls on one reasoner: `sequential-runner.mjs` (by hand).
- `gen-family.mjs` generates synthetic family ontologies; OWL/XML conversion helper: `scripts/native-xml-to-nt.mjs`.
