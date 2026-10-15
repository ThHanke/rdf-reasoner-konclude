# Benchmark

`npm run bench` (full, ~30 min, needs Docker for native Konclude and HermiT) or `npm run bench:quick` (LUBM schema + GALEN, 3 runs, ~5 min). Output is Markdown; `docs/benchmark.md` is a saved full run.

Options: `--quick`, `--case "<name>"` (one case; names in `cases.mjs`). The run waits up to 5 minutes for a quiet host (1-minute load average < 3.5) before measuring.

## What is measured

| Number | Boundary |
|---|---|
| WASM ingest→result | encode + `syncTripleBuffer()` + reasoning (incl. lazy parse/mapping) + output decode. Module start (`init`) is one-off and excluded. |
| Konclude total | Konclude's own "Total processing time" in the container: OWL/XML parse + reasoning + result serialisation. Container start excluded. |
| TS layer total | a full public `RdfReasoner` call on a fresh instance, including Worker and module start. |
| warm scenarios | one reasoner: unchanged content, identical content in a new Store, one added axiom. Kernel counters (`syncStats`) are asserted for each. |

Only ingest→result vs Konclude total (TBox) or vs Konclude excl. realization (ABox classification path) is a ratio. Phase columns are a breakdown: v0.8.0 moved parse/mapping from "load" into "reasoning" (see `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md`), so phases are not comparable across releases.

Cells show `median [min–max]`; `†` = spread above 10%, `‡` = fewer than 5 samples. Run counts and subprocess budgets per case live in `cases.mjs` (slow cases: 3 runs, no warm-up).

## Files

- `bench.mjs` orchestrator and report; `meta.mjs` run metadata; `stats.mjs` summaries; `cases.mjs` budgets.
- Runners: `wasm-runner.mjs` (direct Embind), `ts-runner.mjs` (RdfReasoner + warm scenarios), `native-runner.mjs` (Docker Konclude), `robot-runner.mjs` (HermiT), `binary-runner.mjs` (encoding micro-benchmark).
- `equivalence.mjs` compares role assertions modulo equivalent/inverse roles declared in the input (Konclude picks one representative per equivalence class; the choice differs between builds).
- A/B across checkouts: `ab-run.mjs` / `ab-compare.mjs` (e.g. a v0.7.2 worktree vs HEAD). Stability across many changed-content calls: `sequential-runner.mjs`.
- `gen-family.mjs` generates synthetic family ontologies; OWL/XML conversion helper: `scripts/native-xml-to-nt.mjs`.
