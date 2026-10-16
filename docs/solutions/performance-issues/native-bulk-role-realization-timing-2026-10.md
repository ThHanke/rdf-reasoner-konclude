---
title: Native timing of the bulk role-realization step (same kernel, no WASM)
date: 2026-10-16
module: tests/bench
problem_type: performance
tags: [benchmark, role-closure, OPSROLEREALIZE, native, roberts]
---

# Native bulk role realization vs the lazy SPARQL path

## Question

`docs/benchmark.md` §1b compares WASM `realization()` (bulk `OPSROLEREALIZE`, full role closure) with upstream Konclude answering one SPARQL query per property (lazy, per individual). Those are two different native code paths. What does the bulk step cost natively?

## Method

`build-native/konclude_repro` links the same patched kernel and the same `src/KoncludeReasoner.cpp` as the WASM build, so `realization()` natively requests `OPSROLEREALIZE` exactly like WASM. Three fresh processes on `tests/fixtures/roberts-family.nt`, idle host (load 0.05), 8 threads:

```bash
build-native/konclude_repro --mode reuse --runs 1 --timeout 600 --out DIR tests/fixtures/roberts-family.nt
```

## Result

| Path | Roberts wall time |
| --- | --- |
| Native, same kernel, bulk `OPSROLEREALIZE`, whole process (load + realization + dump of 353 279 triples) | 44.9 / 48.6 / 40.3 s |
| WASM `realization()` ingest→result | 27.5 s [26.7–27.6] |
| Upstream Konclude, one `sparqlfile` run, 80 property queries (lazy per individual) | 91–215 s under load, ~354 s in a standalone run |

Same output size (353 279 vs WASM 353 200 triples, equal modulo equivalent roles).

## Reading

- The bulk step is the cheaper way to get the closure: about 2-8x faster than the lazy SPARQL path, in native as well as in WASM.
- Native here is built `-g3 -O1` (`native/CMakeLists.txt`) with debug-friendly flags and includes process start and the result dump, so it is not a release-quality native number; it shows the order of magnitude, not WASM-vs-native speed. The WASM 27 s excludes module start.
- The bulk step is not reachable from the upstream CLI, SPARQL or `GetFlattenedObjectPropertyTargets`; this package requests it directly.
