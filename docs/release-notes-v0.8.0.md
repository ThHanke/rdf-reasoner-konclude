# Release Notes — v0.8.0

## Summary

v0.8.0 makes repeated reasoning on one `RdfReasoner` reliable: correct results on every call, bounded memory growth, no hangs, and automatic recovery from a stalled kernel. The public API is unchanged; new options are additive. Upgrade from v0.7.2 is drop-in.

On v0.7.2, ten successive `materialize()` calls with changing content on the Roberts family (160 individuals) returned lossy results on two calls, grew to 5.6 GB RSS by call 7, and hung on call 8. On v0.8.0 all ten calls return the full, identical result and RSS stays near 3.2 GB.

---

## What Changed

### Self-invalidating reasoner state

Every public call now sends the store content to the kernel, which hashes each triple (128-bit, term type plus string) and compares the digest set with the last one. Order, duplicates, `Store` identity and blank-node numbering of the interned ids do not matter; blank-node labels count as content.

- Changed content bumps a generation and the ontology is rebuilt lazily by the next `classify`/`materialize`/`checkConsistency`.
- Unchanged content is a cheap no-op: classification, realization and consistency are idempotent per generation.
- Result caches in the TS layer are keyed on `{store, generation}` only to skip re-injecting results; the kernel is authoritative. The old N3 content fingerprint and the per-operation cache invalidation are gone.
- The Worker is recycled only when changed content arrives.

See `docs/solutions/architecture-patterns/self-invalidating-reasoner-api-2026-10-10.md`.

### Full role closure from `materialize()`

`materialize()` returns the complete object-property closure (e.g. `isRelationOf`, `isBloodRelationOf`) together with the rdf:type assertions, in one call and as quads. It uses Konclude's bulk role-realization step (`OPSROLEREALIZE`), which the native CLI `realization` command never requests and whose result its OWL/XML output never lists; natively the closure is only reachable per property through SPARQL, which resolves roles lazily per individual (Roberts: ~6 min for 80 properties in one `sparqlfile` run, vs ~27 s here).

### Correctness fixes (Konclude kernel patches)

- **Lossy / nondeterministic realization:** late role candidates are now queued for confirmation; an uninitialized "queued" flag in the realizer's role-instances item is initialized (documented in `docs/solutions/logic-errors/uninitialized-queued-flag-lossy-sequential-realization-2026-10-12.md`); transitive sub-role links are copied from the right orientation; trivial merging operation limit precedence fixed (`(*limit)--`); `CDependencyNode` pointers zero-initialized.
- **Crash at call 4 / hang at call 7:** KPSet drain-loop iterator fix and processing-set clearing.
- **Cardinality crash and hang:** the first update build after a basement application used a stale top concept (null dereference that WASM does not trap). Documented in `docs/solutions/logic-errors/stale-basement-top-concept-minCardinality-saturation-null-deref-2026-10-13.md`.
- `owl:AsymmetricProperty` self-loop `r(a,a)` is detected as inconsistent (ABox tableau path); 17/17 OWL 2 DL conformance cases pass.

### Memory

Per-call release of structures upstream Konclude leaves for process exit: task data and memory pools, scheduler free-pool reserves (capped and flushed), realizing items and calculation jobs, cache data with its individual-association contexts, adopted write-message pools, stale classification items. Several base classes got virtual destructors. Native growth per realization call fell from ~100 MB to ~8 MB; remaining growth is tracked in the handover notes.

### Robustness (TS layer)

- **Stall recovery:** a blocking call that shows no sign of life for `stallTimeoutMs` (default 600000 ms, 0 disables) restarts the Worker, replays the current store and retries once; otherwise throws `ReasonerStalledError`.
- **Heap recycling:** WASM memory never shrinks and is capped at 4 GiB. When the heap passes `recycleHeapBytes` (default 2 GiB, 0 disables) the Worker is recycled before the next changed load.
- **Result buffers:** read at unsigned pointers (wasm32 pointers above 2 GiB came back negative from Embind and read foreign memory), with a header sanity check and rebuild on corruption.
- New option `workerFactory` creates fresh Workers for restarts.

### Build and repository

- Vendor patches 000-041 aggregated into five patches (000-004). The resulting vendor tree and WASM binary are byte-identical; originals and an old-to-new mapping are in `patches/archive/per-fix/` and `patches/README.md`. New patches start at 005.
- Native repro/debug harness, deterministic scheduler, pool diagnostics and oracle sampling scripts.
- Benchmark runner updated for the digest API; `docs/benchmark.md` refreshed (2026-10-15). On identical hardware, single cold calls are at parity with v0.7.2 (GALEN ~2.0 s, Roberts ~30 s).

---

## Known limitations

- Remaining memory growth of ~46 MB per realization call in the native runs; WASM heap is still capped at 4 GiB (recycling mitigates).
- Occasional unexplained step-time variance on identical input (one 20 s step among ~6 s steps in the sequential test).
- Role closure picks one representative of equivalent roles (e.g. `hasChild` vs `isParentOf`); the choice is semantically equivalent but not stable across builds.
- WASM runs ~7-17× slower than native Konclude on data-heavy ontologies; WASM `realization()` materialises the full role closure, whereas native `Konclude realization` output lists class assertions only (role closure is computed internally but only retrievable per property via SPARQL), so full-realization timings are not comparable.
- Incremental realization is not implemented (upstream is a stub); every changed-content call rebuilds.
