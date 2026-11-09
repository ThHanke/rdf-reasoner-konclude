# Patches

Applied to `vendor/konclude/` by `scripts/apply-patches.sh` in filename order, restricted to `patches/ENABLED`.
The five patches below are an aggregation of the earlier per-fix patches 000-041 plus the 0.9.0-series patches 005-009 (folded before the tag); applying them yields a byte-identical vendor tree
(verified by `git diff` hash against the sequential per-fix application).

| Patch                           | Contains (old numbers)                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 000-qt-removal                  | 000                                                                                                                                                                                                                                                                             |
| 001-wasm-port-base              | 001-009, 011                                                                                                                                                                                                                                                                    |
| 002-realizer-kernel-correctness | 009 (KPSet flush registration, 0.9.0 series), 017 (merging limit precedence), 018 (role message trace, native diag), 019 (late role candidate requeue), 020 (dependency node init), 021 (transitive sub-role inversion), 027 (queued flag init), 034 (basement prev-build flag) |
| 003-stall-detection             | 022                                                                                                                                                                                                                                                                             |
| 004-memory-lifecycle            | 005 (item pool release), 006 (Redland triples dtor), 007 (mapTriples probe stream), 008 (saturation-cache epoch arenas) — all 0.9.0 series; 023-026, 028-033, 035-041 (incl. diagnostic counters 024/028/030/037)                                                               |

Old numbers still appear in commit messages, docs/solutions, memory notes and code comments ("patch 019" etc.): use this table.

`archive/0.9.0-pre-fold/` keeps the separate 0.9.0-series patches 005-009 and the pre-fold 002/004 (fold verified: vendor tree hash identical to sequential application).
`archive/per-fix/` keeps the original per-fix patches and their `mod_*.py` generators (reference only, not applied).
`archive/` also holds parked, never-enabled experiments (010, 012-016). Incremental-revision experiments: `docs/experiments/`.

New vendor patches continue at 005 via `scripts/new-multi-file-patch.sh`; run `make reset-patches` after adding one.
